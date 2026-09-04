import type { CatalogModel, Mode } from "@amb/protocol";
import type { EffortSetting } from "./ports.js";

/** Hard-work signals in a task → `auto` reasons HARD. */
const HARD_TASK =
  /\b(debug|why|fix|bug|error|fail|failing|broken|crash|refactor|optimi[sz]e|architect|design|implement|migrat|crash|race condition|regression|investigat|analy[sz]e|trace|root ?cause|performance|security|audit|algorithm|concurren)\b/i;
/** Clearly-trivial / conversational input → `auto` should NOT burn deep reasoning (this is the "sup" case
 *  that took 23s at medium vs 3s at low). */
const TRIVIAL_TASK =
  /^\s*(hi|hey|hello|sup|yo|hiya|thanks|thank you|ty|ok|okay|k|cool|nice|great|got it|test|ping|yes|no|y|n)\b[\s!.?]*$/i;

/**
 * The `auto` reasoning level for a task — TASK-ADAPTIVE (not just mode-based), so a greeting doesn't trigger
 * medium reasoning that makes a reasoning model think for 20s. Plan mode always reasons hard (planning is
 * deliberate); otherwise: clearly-hard work → high, a trivial/tiny/greeting → low, everything else → medium.
 */
export function autoEffortForTask(text: string, mode: Mode): "low" | "medium" | "high" {
  if (mode === "plan") return "high";
  const t = (text ?? "").trim();
  if (HARD_TASK.test(t)) return "high";
  if (TRIVIAL_TASK.test(t) || t.split(/\s+/).filter(Boolean).length <= 4) return "low";
  return "medium";
}

/**
 * Resolve the user's effort CHOICE into the concrete `reasoning_effort` to send for THIS request, or
 * undefined to send none. Catalog-adaptive + honest:
 *  - `off` / no setting        → send nothing.
 *  - model lacks `reasoning`   → send nothing (never send a param the served model doesn't advertise).
 *  - `auto`                    → TASK-ADAPTIVE via `taskEffort` (plan→high, hard→high, trivial→low, else medium).
 *  - explicit low/medium/high  → sent as-is (still gated on the model supporting reasoning).
 * Resolved PER attempt so a failover to a non-reasoning model automatically drops the param.
 */
export function resolveEffort(
  setting: EffortSetting | undefined,
  model: CatalogModel | undefined,
  mode: Mode,
  taskEffort?: "low" | "medium" | "high",
): "low" | "medium" | "high" | undefined {
  const choice = setting ?? "auto";
  if (choice === "off") return undefined;
  const supportsReasoning = model?.supportedFeatures.includes("reasoning") ?? false;
  if (!supportsReasoning) return undefined;
  if (choice === "auto") return taskEffort ?? (mode === "plan" ? "high" : "medium");
  return choice;
}

/**
 * Effort for the compaction SUMMARY request. This is a utility task (mechanical extraction into a fixed
 * skeleton) on a pay-per-token network — cheap by design, NOT the user's run effort (a `high` run must not
 * spend high-effort tokens summarizing). Sends `low` to reasoning-capable models, nothing to the rest.
 */
export function summaryEffort(model: CatalogModel | undefined): "low" | undefined {
  return (model?.supportedFeatures.includes("reasoning") ?? false) ? "low" : undefined;
}
