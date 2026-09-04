import { createHash } from "node:crypto";
import { planCompaction } from "@amb/context";
import type { CatalogModel } from "@amb/protocol";
import type { Msg } from "./ports.js";

/**
 * Pure helpers for the agent loop — no `this`, no I/O — split out to keep `agent.ts` focused on the state
 * machine. Covered by the agent + reducer test suites through their callers.
 */

/**
 * Render the model's own `plan` tool-call args into a compact anchor block. Pinning this into the
 * SYSTEM anchor each turn — which compaction never summarizes — keeps the model looking at its live checklist
 * on long autonomous runs (the #1 adherence gap: the plan otherwise scrolls into compacted history). Parsed
 * defensively + bounded here (it's advisory re-injection of the model's own list, not the durable record).
 */
export function renderPlanAnchor(args: unknown): string {
  const tasks = (args as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return "";
  const lines: string[] = [];
  for (const t of tasks.slice(0, 50)) {
    const o = t as { text?: unknown; status?: unknown };
    if (typeof o.text !== "string" || o.text.length === 0) continue;
    const mark = o.status === "done" ? "[x]" : o.status === "active" ? "[~]" : "[ ]";
    const text = o.text.replace(/\s+/g, " ").trim().slice(0, 200);
    if (text.length > 0) lines.push(`${lines.length + 1}. ${mark} ${text}`);
  }
  return lines.length > 0
    ? `## Current plan (ADHERE to it; keep it current — mark each step done as you finish)\n${lines.join("\n")}`
    : "";
}

/**
 * The recency half of the goal "sandwich": a one-line restatement appended to the OUTBOUND messages just
 * before generation. The goal already sits at the top of the system anchor (primacy); position-bias research
 * shows weaker models still lose mid-prompt instructions, so restating it in the most-recent slot (recency)
 * keeps even an 8B model aligned. Transient — built per attempt, never persisted. Returns a NEW array (never
 * mutates the caller's messages); a no-op when there's no goal.
 */
export function withGoalReminder(messages: Msg[], goal: string | undefined): Msg[] {
  if (!goal || !goal.trim()) return messages;
  return [
    ...messages,
    {
      role: "system",
      content: `<goal_reminder>Your north-star goal for this session (set by the user): ${goal.trim()}. Confirm the next step serves it before acting.</goal_reminder>`,
    },
  ];
}

/**
 * Plan a last-resort context SPILL: keep the goal anchor (the first 2 messages — system + goal) plus
 * the newest turn, and evict everything in between. Reuses the group-safe compaction planner so a tool call
 * and its result never land on opposite sides of the cut. Returns the serialized middle + the anchor/recent
 * pieces to reassemble the transcript, or null when there is nothing safe to evict (anchor + one turn is the
 * floor — if a single turn overflows the window, no history eviction can help and the caller honestly blocks).
 */
export function planSpill(messages: Msg[]): {
  evictedText: string;
  evictedCount: number;
  anchor: Msg[];
  recent: Msg[];
} | null {
  const plan = planCompaction(messages, { anchorCount: 2, keepRecentTokens: 1, reserveTokens: 0 });
  if (plan.toSummarize.length === 0) return null;
  // Serialize the WHOLE messages — role, content AND the native tool-call fields (toolCalls/toolCallId/
  // toolGroupId). A native assistant tool-call message carries content:"" with its real state in toolCalls, so
  // a role+content-only dump would record it as empty and the paged-back history would lose which tool ran and
  // its args. JSON preserves all of it and is legible when read back via read_artifact.
  const evictedText = JSON.stringify(plan.toSummarize, null, 2);
  return {
    evictedText,
    evictedCount: plan.toSummarize.length,
    anchor: messages.slice(0, 2),
    recent: plan.kept.slice(2),
  };
}

export function catalogHash(catalog: CatalogModel[]): string {
  // Hash identity + readiness + limits + ALL capabilities (in/out modalities, features, sampling params)
  // so any capability change changes the hash.
  const shape = catalog
    .map((m) =>
      [
        m.id,
        m.isReady,
        m.contextLength,
        m.maxOutputLength,
        [...m.supportedFeatures].sort().join(","),
        [...m.inputModalities].sort().join(","),
        [...m.outputModalities].sort().join(","),
        [...m.supportedSamplingParameters].sort().join(","),
      ].join(":"),
    )
    .sort();
  return `sha256:${createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16)}`;
}

/**
 * Deterministic structured summary (no model call). Preserves the operational state that a naive
 * count-and-filenames summary drops (new-audit #1): recent user requests, files touched, tool
 * successes/failures, and the last error — so the model won't repeat a done action or claim false success.
 */
export const SUMMARY_MARKER = "## Summary of earlier conversation";

export function deterministicSummary(msgs: Msg[]): string {
  const files = new Set<string>();
  const userReqs: string[] = [];
  const priorSummaries: string[] = [];
  let toolOk = 0;
  let toolFail = 0;
  let lastError = "";
  for (const m of msgs) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    // Carry a PRIOR summary forward verbatim so repeated compaction doesn't erase earlier state.
    if (text.startsWith(SUMMARY_MARKER)) {
      priorSummaries.push(text);
      continue;
    }
    for (const match of text.matchAll(
      /[\w./-]+\.(ts|js|tsx|jsx|json|md|py|go|rs|txt|toml|yaml|yml)\b/g,
    ))
      files.add(match[0]);
    if (m.role === "user") userReqs.push(text.slice(0, 200));
    if (m.role === "tool") {
      if (text.startsWith("ERROR:")) {
        toolFail += 1;
        lastError = text.slice(0, 200);
      } else {
        toolOk += 1;
      }
    }
  }
  const lines = [
    `${SUMMARY_MARKER} (compacted — do not repeat completed work)`,
    `- ${msgs.length} earlier messages summarized. Tool calls this window: ${toolOk} succeeded, ${toolFail} failed.`,
    files.size > 0 ? `- Files touched/referenced: ${[...files].slice(0, 40).join(", ")}` : "",
    userReqs.length > 0 ? `- Recent requests: ${userReqs.slice(-3).join(" | ")}` : "",
    lastError ? `- Last tool error: ${lastError}` : "",
  ].filter(Boolean);
  if (priorSummaries.length > 0) {
    lines.push("- Carried forward from earlier compaction(s):");
    lines.push(
      ...priorSummaries.map((s) =>
        s
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      ),
    );
  }
  lines.push(
    "- The original goal is in the first user message. Continue from the recent messages below; verify before claiming success.",
  );
  return lines.join("\n");
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
}

/**
 * Cap a single tool result so one huge output can't overflow the model window on its own. `maxBytes` is
 * CEILING-AWARE (from `toolResultCharBudget`) so it tightens as the window fills; keeps a head + tail with an
 * honest truncation marker in the middle. Measured in UTF-8 BYTES (not UTF-16 `.length`) so multi-byte text
 * (CJK/emoji) is budgeted like the tokenizer sees it, not 3× over. The marker is reserved INSIDE the cap.
 */
export const MAX_TOOL_RESULT_CHARS = 24_000;
const MARKER_RESERVE_BYTES = 48; // room for "\n…[NNNNNNNN bytes truncated]…\n"
export function capToolResult(text: string, maxBytes: number = MAX_TOOL_RESULT_CHARS): string {
  const cap = Number.isFinite(maxBytes)
    ? Math.max(200, Math.floor(maxBytes))
    : MAX_TOOL_RESULT_CHARS;
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  if (bytes.length <= cap) return text;
  const budget = Math.max(0, cap - MARKER_RESERVE_BYTES);
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  const omitted = bytes.length - head - tail;
  // A byte-slice may split a trailing multi-byte code point → TextDecoder replaces it with U+FFFD (harmless
  // in a truncated preview). Omitted count is computed from the ACTUAL retained bytes.
  const dec = new TextDecoder();
  return `${dec.decode(bytes.slice(0, head))}\n…[${omitted} bytes truncated]…\n${dec.decode(bytes.slice(bytes.length - tail))}`;
}

export function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return "[unserializable result]";
  }
}

/** True if a tool result carries a durable file mutation (write/edit/apply_patch) — drives the verify gate. */
export function isMutationOutcome(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const op = (result as { operation?: unknown }).operation;
  if (op === "create" || op === "modify" || op === "delete") return true;
  // apply_patch returns { files: [{operation}], ... } rather than a single operation.
  const files = (result as { files?: unknown }).files;
  return (
    Array.isArray(files) &&
    files.some(
      (f) =>
        f &&
        typeof f === "object" &&
        ["create", "modify", "delete"].includes((f as { operation?: string }).operation ?? ""),
    )
  );
}

/** A conservative stand-in when a target model isn't in the live catalog (budgeting must never crash). */
export function fallbackModel(id: string): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: [],
    supportedSamplingParameters: [],
    contextLength: 128_000,
    maxOutputLength: 8192,
  };
}
