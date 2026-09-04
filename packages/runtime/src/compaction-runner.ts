import {
  buildSummaryRequest,
  compactionConfigForWindow,
  estimateMessagesTokens,
  planCompaction,
} from "@amb/context";
import type { CatalogModel } from "@amb/protocol";
import { pickForRole } from "@amb/reliability";
import { SUMMARY_MARKER, deterministicSummary, planSpill } from "./agent-support.js";
import { MAX_COMPACTIONS } from "./constants.js";
import { summaryEffort } from "./effort.js";
import type { ChatClient, Msg, RunOptions } from "./ports.js";

/**
 * Context-management for the agent loop — split out of `agent.ts` so the state machine stays focused. These
 * are the two ways the loop reclaims window space (model-summary compaction, then a lossy artifact spill) plus
 * the `reduceContext` that combines them. Pure w.r.t. their message input (return a NEW array or null; never
 * mutate in place). `client` is injected so this module has no `this` and is directly testable.
 */

/**
 * Compact the conversation. Prefers a MODEL-written structured summary (goal-anchored, lossless on
 * files/decisions/test-state — the SUMMARY_SKELETON) and falls back to the deterministic offline summary
 * if the model call fails/aborts. The anchor (system + the original goal) is NEVER summarized, so the goal
 * survives every compaction. Persists the structured summary to `.ambient/MEMORY.md` (compounding memory).
 * PURE w.r.t. its input: returns a NEW message array on real progress (fewer tokens), or `null` when there
 * is nothing to compact / no reduction — never mutates `messages` in place (immutability rule).
 */
export async function compact(
  client: ChatClient,
  messages: Msg[],
  target: string,
  catalog: CatalogModel[],
  sessionId: string,
  turnId: string,
  emit: RunOptions["emit"],
  signal: AbortSignal,
  persistMemory: (summary: string) => void,
  windowTokens: number,
  priorMemory: string,
): Promise<Msg[] | null> {
  // Retention scaled to the SERVED model's window — a small model keeps proportionally less so the
  // transcript can actually shrink below its ceiling (a fixed 20k-recent floor can't fit a ≤32k model). The
  // window is the caller's LEARNED-ceiling-aware budget: using the raw catalog window here
  // while the trigger used the learned window made compaction retain too much and re-overflow → "blocked".
  const cfg = compactionConfigForWindow(windowTokens);
  const before = estimateMessagesTokens(messages);
  const plan = planCompaction(messages, cfg);
  if (plan.toSummarize.length === 0) return null;

  // A model summary preserves plan/decisions/rationale that the deterministic one drops; on any failure
  // (rate-limit, transport, abort) we fall back to the deterministic summary so compaction never blocks.
  const facts = deterministicSummary(plan.toSummarize);
  const factsBody = facts.replace(/^## [^\n]*\n?/, "").trim(); // drop its own marker header
  let summary = facts;
  if (!signal.aborted) {
    // Fleet-routed compaction (#27): summarization is a mechanical utility task, so route it to a CHEAP
    // model from the live fleet instead of burning the run's (often flagship/coding) `target` — a real
    // per-token cost win on a pay-per-token network. Falls back to `target` if nothing cheaper is warm, and
    // the whole call falls back to the deterministic summary on any failure, so a cold cheap model is safe.
    const compactor = pickForRole("compactor", catalog) ?? target;
    if (compactor !== target) {
      emit({
        schemaVersion: 1,
        kind: "handoff",
        sessionId,
        turnId,
        from: target,
        to: compactor,
        role: "compactor",
        reason: "cheap-model compaction",
      });
    }
    try {
      // Feed the PRIOR project memory as the prior-summary so the new summary COMPOUNDS it instead of
      // replacing it (memory lives in the anchor, excluded from toSummarize, so without this the
      // next session's first compaction would erase it).
      const req = buildSummaryRequest(plan.toSummarize, priorMemory || undefined);
      const out = await client.chat({
        model: compactor,
        messages: req,
        tools: [],
        maxTokens: 2048,
        // Utility task — cheap by design; never spends the run's high-effort tokens summarizing.
        reasoningEffort: summaryEffort(catalog.find((m) => m.id === compactor)),
        signal,
      });
      // Use the model's NARRATIVE but ALWAYS append the AUTHORITATIVE facts from the log (files touched,
      // tool ok/fail, last error) so a weak compactor can't fabricate "all tests pass" or drop real errors
      // and then steer the strong model wrong. A TRUNCATED summary (hit the output cap) is untrusted
      // → keep the deterministic one whole.
      const modelText = out.content.trim();
      if (modelText.length > 0 && out.finishReason !== "length") {
        summary =
          factsBody.length > 0
            ? `${modelText}\n\n## Ground truth (from the session log — authoritative; trust over the narrative above)\n${factsBody}`
            : modelText;
      }
    } catch {
      // keep the deterministic fallback
    }
  }

  const anchor = messages.slice(0, cfg.anchorCount); // system + original goal, kept together (never summarized)
  const recent = plan.kept.slice(cfg.anchorCount);
  const summaryMsg: Msg = {
    role: "system",
    // MUST start with SUMMARY_MARKER (the SAME constant the deterministic path reads) so a LATER compaction
    // carries this summary forward verbatim instead of dropping it — otherwise repeated compaction
    // progressively loses earlier state (the exact drift compaction is meant to prevent).
    content: `${SUMMARY_MARKER} (another model may have written this — re-verify with your tools before relying on it)\n${summary}`,
  };
  const next: Msg[] = [...anchor, summaryMsg, ...recent];
  const after = estimateMessagesTokens(next);
  if (after >= before) return null; // no real reduction — don't loop

  persistMemory(summary); // compounding project memory (best-effort, via the workspace port)
  emit({
    schemaVersion: 1,
    kind: "context.compacted",
    sessionId,
    turnId,
    keptTokens: after,
    summarizedPhases: plan.toSummarize.length,
  });
  return next;
}

/**
 * Last-resort context relief: when compaction can't shrink the transcript below the served window,
 * EVICT the middle (everything between the goal anchor and the newest turn) to the artifact store and leave
 * a breadcrumb the model can page back in via read_artifact. Needs NO model call, so it always shrinks and
 * works even when the compactor is cold — the honest answer to "run on ANY model, Qwen → GLM-5.2". Tool
 * groups are never split (reuses planSpill). Returns the smaller array, or null when there's nothing
 * safe left to evict (the goal anchor + one turn is the floor — if a single turn overflows, we honestly block).
 */
export function spillToArtifact(
  messages: Msg[],
  sessionId: string,
  turnId: string,
  emit: RunOptions["emit"],
  artifact?: (content: string) => string | undefined,
): Msg[] | null {
  if (!artifact) return null;
  // planSpill keeps the goal anchor + the newest turn (group-safe: a tool call and its result never split)
  // and serializes the middle for eviction, or returns null when there's nothing safe left to evict.
  const spill = planSpill(messages);
  if (!spill) return null;
  const handle = artifact(spill.evictedText);
  if (!handle) return null;
  // The breadcrumb MUST start with SUMMARY_MARKER so a LATER compaction carries the handle forward verbatim
  // (deterministicSummary preserves prior-summary lines) instead of paraphrasing the pointer away.
  const breadcrumb: Msg = {
    role: "system",
    content: `${SUMMARY_MARKER} — ${spill.evictedCount} earlier message(s) were evicted to fit a small context window. They are not lost: call read_artifact({handle:"${handle}"}) to page through that history if you need it.`,
  };
  const next: Msg[] = [...spill.anchor, breadcrumb, ...spill.recent];
  if (estimateMessagesTokens(next) >= estimateMessagesTokens(messages)) return null; // no real reduction
  emit({
    schemaVersion: 1,
    kind: "context.compacted",
    sessionId,
    turnId,
    keptTokens: estimateMessagesTokens(next),
    summarizedPhases: spill.evictedCount,
  });
  return next;
}

/**
 * Reclaim context to fit the served window: normal model-summary compaction first; if that can't
 * shrink further (hit the compaction cap, or nothing left to summarize), fall back to a lossy artifact
 * SPILL of the middle so a small-window / weak model keeps MOVING instead of dead-ending in "blocked".
 * Returns the smaller transcript, or null when nothing more can be reclaimed (the caller then blocks).
 */
export async function reduceContext(
  client: ChatClient,
  messages: Msg[],
  target: string,
  catalog: CatalogModel[],
  sessionId: string,
  turnId: string,
  emit: RunOptions["emit"],
  signal: AbortSignal,
  persistMemory: (summary: string) => void,
  windowTokens: number,
  priorMemory: string,
  compactions: number,
  artifact?: (content: string) => string | undefined,
): Promise<Msg[] | null> {
  const compacted =
    compactions >= MAX_COMPACTIONS
      ? null
      : await compact(
          client,
          messages,
          target,
          catalog,
          sessionId,
          turnId,
          emit,
          signal,
          persistMemory,
          windowTokens,
          priorMemory,
        );
  if (compacted) return compacted;
  return spillToArtifact(messages, sessionId, turnId, emit, artifact);
}
