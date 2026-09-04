import { estimateMessagesTokens } from "./tokens.js";

/**
 * Context compaction. Clean-room design informed by prime-agent's compaction (MIT) + Karpathy's
 * context-engineering principles: budget context like RAM, keep the recent window, summarize the
 * older middle, and NEVER lose the anchor (the original goal + constraints) so we don't "summarize
 * the summary" away the task.
 *
 * The actual summarization is done by the model; this module decides WHAT to compact and assembles
 * the structured summary skeleton + retention set. It never cuts a tool call from its result.
 */

/** The minimal message shape compaction needs. Generic over the caller's richer message type (e.g. runtime `Msg`). */
export interface CompactableMessage {
  role: string;
  content?: unknown;
  /** Marks a message that pairs a tool call with its result (kept together). */
  toolGroupId?: string;
}
/** @deprecated Use {@link CompactableMessage}. Kept as an alias so external importers don't break. */
export type ChatMsg = CompactableMessage;

export interface CompactionPlan<T extends CompactableMessage = CompactableMessage> {
  /** Messages to summarize (the older middle) — same concrete type the caller passed in. */
  toSummarize: T[];
  /** Messages kept verbatim (recent window + the anchor). */
  kept: T[];
  /** Index in the original array where `kept` begins. */
  keepFromIndex: number;
}

export interface CompactionConfig {
  /** Fire compaction when estimated tokens exceed contextWindow − reserveTokens. */
  reserveTokens: number;
  /** Keep at least this many tokens of the most recent messages verbatim. */
  keepRecentTokens: number;
  /** Number of leading messages that are the immovable anchor (system + goal). */
  anchorCount: number;
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  anchorCount: 2,
};

const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Scale the compaction retention to the SERVED model's window. The fixed 20k-recent + 16k-reserve
 * defaults can't fit a small (≤~32k) model: after a high→low switch the retained tokens alone exceed the
 * usable window, so compaction can't shrink the transcript below the ceiling and the run dead-ends in
 * "blocked". Deriving both from the window lets a small model retain proportionally less and continue (lossy)
 * rather than hard-block, while a large model keeps the generous defaults (the clamps cap at the defaults).
 */
export function compactionConfigForWindow(
  contextWindow: number,
  base: CompactionConfig = DEFAULT_COMPACTION,
): CompactionConfig {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return base;
  return {
    anchorCount: base.anchorCount,
    keepRecentTokens: clampN(Math.floor(contextWindow * 0.35), 4000, base.keepRecentTokens),
    reserveTokens: clampN(Math.floor(contextWindow * 0.15), 2000, base.reserveTokens),
  };
}

export function shouldCompact<T extends CompactableMessage>(
  messages: T[],
  contextWindow: number,
  cfg: CompactionConfig = DEFAULT_COMPACTION,
  bytesPerToken?: number,
): boolean {
  const used = estimateMessagesTokens(messages, bytesPerToken ? { bytesPerToken } : {});
  return used > contextWindow - cfg.reserveTokens;
}

/**
 * Decide what to compact: keep the leading anchor + a recent window of ~keepRecentTokens; summarize
 * the middle. Never split a tool group (call+result stay on the same side of the cut).
 */
export function planCompaction<T extends CompactableMessage>(
  messages: T[],
  cfg: CompactionConfig = DEFAULT_COMPACTION,
  bytesPerToken?: number,
): CompactionPlan<T> {
  const anchor = messages.slice(0, cfg.anchorCount);
  const rest = messages.slice(cfg.anchorCount);
  const opts = bytesPerToken ? { bytesPerToken } : {};

  // Walk backward accumulating recent messages until we hit keepRecentTokens. Always keep AT LEAST the
  // newest message, even if it alone exceeds the budget: never summarize away the current state.
  let acc = 0;
  let cut = rest.length;
  while (cut > 0) {
    const msg = rest[cut - 1];
    if (!msg) break;
    acc += estimateMessagesTokens([msg], opts);
    const isNewest = cut === rest.length;
    if (acc > cfg.keepRecentTokens && !isNewest) break;
    cut -= 1;
  }
  // Don't split a tool group at the boundary: extend the kept region backward over the same group.
  const boundaryGroup = rest[cut]?.toolGroupId;
  if (boundaryGroup) {
    while (cut > 0 && rest[cut - 1]?.toolGroupId === boundaryGroup) cut -= 1;
  }

  const toSummarize = rest.slice(0, cut);
  const recent = rest.slice(cut);
  return {
    toSummarize,
    kept: [...anchor, ...recent],
    keepFromIndex: cfg.anchorCount + cut,
  };
}

/** The fixed structured-summary skeleton the summarizer model must fill (task-tuned, not free-form). */
export const SUMMARY_SKELETON = [
  "## Goal (verbatim — never paraphrase away)",
  "## Constraints & preferences",
  "## Progress (Done / In progress / Blocked)",
  "## Key decisions (+ rationale)",
  "## Files read / modified",
  "## Test & build state",
  "## Next steps",
].join("\n");

/** Flatten a message's content to text for the summarizer — a content-parts array becomes its text parts plus
 *  an "[image]" placeholder per image, so the summary NEVER carries (or re-ships) an image's base64 bytes. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((p) => {
      if (p !== null && typeof p === "object") {
        const type = (p as { type?: unknown }).type;
        if (type === "image_url" || type === "image") return "[image]";
        const text = (p as { text?: unknown }).text;
        if (type === "text" && typeof text === "string") return text;
      }
      return JSON.stringify(p ?? "");
    })
    .join(" ");
}

/** Build the summarizer request messages: prior summary (if any) + the block to compress. */
export function buildSummaryRequest(
  toSummarize: CompactableMessage[],
  priorSummary?: string,
): { role: "system" | "user"; content: string }[] {
  const instruction = `Summarize the conversation below into the exact sections that follow. Preserve the original goal verbatim, every file path touched, test/build outcomes, and decisions with rationale. Be concise but lossless on those. Do not invent progress.\n\n${SUMMARY_SKELETON}`;
  const parts: { role: "system" | "user"; content: string }[] = [
    { role: "system", content: instruction },
  ];
  if (priorSummary) parts.push({ role: "user", content: `Prior summary:\n${priorSummary}` });
  const transcript = toSummarize.map((m) => `${m.role}: ${flattenContent(m.content)}`).join("\n");
  parts.push({ role: "user", content: `Conversation to summarize:\n${transcript}` });
  return parts;
}
