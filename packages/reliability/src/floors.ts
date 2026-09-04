/**
 * Per-model output-token floors and the escalate-on-empty budget.
 * Clean-room from ambient-code-bridge/ambient_code/bridge_policy.py (MIT). Pure functions.
 *
 * Rationale: Ambient models sometimes return an empty-but-truncated 200 when `max_tokens` is too
 * small (reasoning models spend their budget "thinking" and emit nothing). Raising a floor and, if
 * still empty, escalating once fixes the common failure without unbounded retries.
 */

export const REASONING_MIN_OUTPUT_TOKENS = 2048;
export const NON_REASONING_MIN_OUTPUT_TOKENS = 256;
/** Unknown reasoning-ness ⇒ assume reasoning (the safer, higher floor). */
export const DEFAULT_MIN_OUTPUT_TOKENS = 2048;
/** Hard safety ceiling on any single request's output budget. */
export const SAFE_MAX_OUTPUT_TOKENS = 65_536;

export function minOutputFloor(opts: { reasoning?: boolean; measuredMin?: number }): number {
  if (opts.measuredMin !== undefined) return opts.measuredMin;
  if (opts.reasoning === undefined) return DEFAULT_MIN_OUTPUT_TOKENS;
  return opts.reasoning ? REASONING_MIN_OUTPUT_TOKENS : NON_REASONING_MIN_OUTPUT_TOKENS;
}

/** Raise an absent/too-small max_tokens up to the model's floor; never exceed the safety ceiling. */
export function floorMaxTokens(
  requested: number | undefined,
  opts: { reasoning?: boolean; measuredMin?: number },
): number {
  const floor = minOutputFloor(opts);
  const val = Math.max(requested ?? 0, floor);
  return Math.min(val, SAFE_MAX_OUTPUT_TOKENS);
}
