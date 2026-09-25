import { AmbError, type CatalogModel, supportsVision } from "@amb/protocol";
import { UNKNOWN_WINDOW, rankVisionModels, streamTimeouts } from "@amb/reliability";
import type { ChatClient } from "./ports.js";

/**
 * The NON-VISION RELAY: when the served model can't see images, a ready VISION-capable model from the SAME
 * Ambient catalog describes the attached image(s) in a target-optimised, text form, which is then injected
 * into the served model's user message. This gives blind models (e.g. deepseek-v4-flash) a usable vision
 * workaround — Ambient-only, never an external API. Bounded (timeout + one warm-peer failover); honest on
 * failure (no fabricated description — a degrade note tells the model it couldn't see the image).
 */

export const RELAY_TIMEOUT_MS = 90_000;

const DESCRIBE_PROMPT =
  "Describe the attached image(s) in precise, structured detail for another AI that CANNOT see them. " +
  "Transcribe ALL visible text verbatim (UI labels, code, terminal output, error messages, numbers), " +
  "describe layout/structure, and call out anything that looks task-relevant. Be thorough and literal; " +
  "do not speculate beyond what is visible.";

export type RelayOutcome = "described" | "no-model" | "cold" | "failed";

export interface RelayResult {
  outcome: RelayOutcome;
  /** The vision model that produced (or would have produced) the description. */
  visionModel?: string;
  /** The description text — present only when outcome === "described". */
  description?: string;
  /** Every vision model attempted, in order (for an honest "tried X, Y" message). */
  tried?: string[];
}

export interface RelayDeps {
  client: ChatClient;
  catalog: CatalogModel[];
  /** The attached images as data URIs (data:image/...;base64,...) — the caller encodes them. */
  imageDataUris: readonly string[];
  /** The user's text (so the description is written with the task in mind). */
  userText: string;
  signal: AbortSignal;
}

/** Build the one-shot vision request content (describe prompt + the image parts). */
export function toVisionContent(userText: string, imageDataUris: readonly string[]): unknown[] {
  const ask = userText.trim()
    ? `${DESCRIBE_PROMPT}\n\nThe user's request (describe with this in mind): ${userText.trim().slice(0, 600)}`
    : DESCRIBE_PROMPT;
  return [
    { type: "text", text: ask },
    ...imageDataUris.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

/** Most vision peers one relay will try before giving up. */
const MAX_RELAY_ATTEMPTS = 4;

/**
 * Describe the image(s) via a vision model from the live catalog, trying peers in order (ready first). The
 * catalog's readiness flag is only a hint — a flagged model is still tried, and only a real "no workers"
 * answer from every peer makes the outcome `cold`. Each attempt is bounded by a timeout.
 */
export async function relayImageToText(deps: RelayDeps): Promise<RelayResult> {
  const { client, catalog, imageDataUris, userText, signal } = deps;
  const candidates = rankVisionModels(catalog).slice(0, MAX_RELAY_ATTEMPTS);
  if (candidates.length === 0) return { outcome: "no-model" };
  const tried: string[] = [];
  let allCold = true;
  for (const id of candidates) {
    if (signal.aborted) return { outcome: "failed", tried };
    tried.push(id);
    const model = catalog.find((m) => m.id === id);
    const window = model?.contextLength ?? UNKNOWN_WINDOW;
    const descTokens = Math.max(256, Math.min(1500, Math.floor(window * 0.15)));

    // Link the run's signal to a per-attempt timeout so a hung vision call can't stall the run forever.
    const linked = new AbortController();
    const onAbort = () => linked.abort();
    if (signal.aborted) linked.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => linked.abort(), RELAY_TIMEOUT_MS);
    try {
      const res = await client.chat({
        model: id,
        messages: [{ role: "user", content: toVisionContent(userText, imageDataUris) }],
        tools: [],
        maxTokens: descTokens,
        // Images are a large, slow prefill; the watchdog still catches a silent worker well before the cap.
        timeouts: streamTimeouts({
          promptTokens: 8_000 * imageDataUris.length,
          flaggedCold: model?.isReady === false,
        }),
        signal: linked.signal,
        hasImage: true,
      });
      const desc = (res.content ?? "").trim();
      if (desc.length > 0)
        return { outcome: "described", visionModel: id, description: desc, tried };
      allCold = false; // it answered, just emptily → try the next peer
    } catch (e) {
      if (signal.aborted) return { outcome: "failed", visionModel: id, tried }; // the run was cancelled
      if (!(e instanceof AmbError && e.kind === "cold")) allCold = false;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
  return { outcome: allCold ? "cold" : "failed", tried };
}

/**
 * Fold the relay outcome into the served model's user text. On success the description is labelled and clearly
 * attributed to the vision model; on failure an HONEST note tells the model it couldn't see the image — never a
 * fabricated description. Folded into the USER message (not the system anchor), so it can't displace the goal.
 */
export function injectDescription(userText: string, result: RelayResult): string {
  const base = userText.trim();
  if (result.outcome === "described" && result.description) {
    return `${base}\n\n[The model serving you cannot see images. ${result.visionModel ?? "a vision model"} looked at the attached image(s) and described them:]\n${result.description}`;
  }
  const why =
    result.outcome === "no-model"
      ? "no vision-capable model is available right now"
      : result.outcome === "cold"
        ? "every vision-capable model is cold right now"
        : "the image could not be described";
  return `${base}\n\n[You were sent an image, but the model serving you can't see images and ${why}. Work from the text; if the image is essential, ask the user to describe it.]`;
}

/** Re-export the predicate so callers decide the vision-vs-relay branch from one place. */
export { supportsVision };
