/**
 * Small, shared CLI argument primitives so each command doesn't re-implement (and drift on) the same
 * flag validation. Pure + immutable: each parser returns the validated value OR an `{ error }` object; the
 * command aggregates errors and reports them. Keeps flag semantics identical across run / tui / resume.
 */

/** The reasoning-effort choices accepted by `--effort` (same values as runtime EffortSetting / tui Effort). */
export const EFFORT_VALUES = ["auto", "off", "low", "medium", "high"] as const;

export interface ParseError {
  error: string;
}

export function isParseError<T>(v: T | ParseError): v is ParseError {
  return typeof v === "object" && v !== null && "error" in v;
}

/** Validate `--effort <level>`; returns the lowercased value or an error. Caller casts to its own union. */
export function parseEffort(raw: string | undefined): string | ParseError {
  const v = (raw ?? "").toLowerCase();
  if ((EFFORT_VALUES as readonly string[]).includes(v)) return v;
  return { error: `--effort needs one of ${EFFORT_VALUES.join(" / ")} (got ${raw || "nothing"})` };
}

/** Validate `--max-turns <n>` as an integer in [1, 1000]. Rejects missing / non-integer / out-of-range. */
export function parseMaxTurns(raw: string | undefined): number | ParseError {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n <= 0 || n > 1000) {
    return { error: `--max-turns needs an integer between 1 and 1000 (got ${raw ?? "nothing"})` };
  }
  return n;
}
