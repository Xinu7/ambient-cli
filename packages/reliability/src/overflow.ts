/**
 * Context-overflow handling. Clean-room from bridge_policy.py (MIT).
 *
 * When a request genuinely exceeds the model's window, we synthesize the exact phrasing the compactor
 * recognizes so the agent compacts and replays. Crucially, we must NOT treat image/param/schema 400s
 * as overflow — misclassifying those would trigger pointless compaction loops.
 */

export function synthesizeOverflow(promptTokens: number, maxTokens: number): string {
  return `prompt is too long: ${promptTokens} tokens > ${maxTokens} maximum`;
}

const OVERFLOW_RE = /prompt is too long|context length|maximum context|too many tokens/i;
const NOT_OVERFLOW_RE = /image|invalid|unsupported parameter|temperature|content_policy/i;

/** True only for a real context overflow — never for image/param/schema 400s. */
export function isContextOverflowError(body: string, opts: { hasImage?: boolean } = {}): boolean {
  if (opts.hasImage) return false;
  return OVERFLOW_RE.test(body) && !NOT_OVERFLOW_RE.test(body);
}

/** The REAL max token count a provider reported in an overflow message ("… > N maximum"), if present —
 *  so we can learn the model's true (lower-than-catalog) ceiling. Returns undefined if unparseable. */
export function parseOverflowMax(body: string): number | undefined {
  const m = body.match(/>\s*([0-9][0-9,_ ]{2,})\s*(?:maximum|max|tokens|token)?/i);
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(/[,_ ]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
