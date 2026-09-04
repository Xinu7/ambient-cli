import { type CatalogModel, supportsVision } from "@amb/protocol";

/**
 * Pick the best default model from the LIVE catalog — never a hard-coded id, so the CLI self-heals as the
 * Ambient fleet changes (a model going cold or disappearing can't strand the default). The catalog carries
 * no explicit "quality" field, so "best" is a small, documented heuristic over the signals it DOES carry:
 *
 *   1. Tool-capable first — a coding agent needs native tool-calls; models without the `tools` feature are
 *      excluded (unless NONE advertise tools, in which case we don't exclude everything).
 *   2. Ready first — prefer `isReady === true`; if nothing is ready (cold start) keep the cold ones so we
 *      still resolve to SOMETHING rather than returning undefined.
 *   3. Capability TIER from the id — coding-specialized (`code`) > flagship (`large`/`max`/`opus`) > generic,
 *      and speed/cheap tiers (`flash`/`mini`/`nano`/`lite`/`small`/`tiny`/`turbo`) are down-ranked so a huge-
 *      context FLASH model doesn't beat a coding flagship. Reasoning support is a small bonus.
 *   4. Context length is a mild (log-scaled) secondary signal, then id order breaks ties deterministically.
 *
 * The heuristics are SOFT (scoring, not hard rules) so an unfamiliar future model still resolves sensibly.
 */
export function pickBestModel(catalog: CatalogModel[]): string | undefined {
  if (catalog.length === 0) return undefined;
  const toolCapable = catalog.filter((m) => m.supportedFeatures.includes("tools"));
  const base = toolCapable.length > 0 ? toolCapable : catalog;
  const ready = base.filter((m) => m.isReady === true);
  const pool = ready.length > 0 ? ready : base;

  return [...pool]
    .map((m) => ({ id: m.id, score: scoreModel(m) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0]?.id;
}

const FLAGSHIP = ["large", "max", "opus", "ultra", "flagship"];
const SMALL_TIER = ["flash", "mini", "nano", "lite", "small", "tiny", "turbo"];

/**
 * A PHASE role the fleet can route to (feature #27). Each maps to a per-role scoring overlay on the shared
 * `scoreModel`, so "plan on the strongest reasoner, edit on the best coder, review with a second opinion,
 * compact on a cheap model" all resolve from the SAME live catalog — never a hard-coded id.
 */
export type RoutedRole = "planner" | "executor" | "reviewer" | "compactor";

/** True when the model advertises a finite input or output price (so pricing-based ranking is meaningful). */
function hasPricing(m: CatalogModel): boolean {
  const p = m.pricing;
  return !!p && (Number.isFinite(p.input) || Number.isFinite(p.output));
}
/** A comparable cost figure (input + output price); undefined components count as 0 (a free tier is cheapest). */
function priceOf(m: CatalogModel): number {
  const p = m.pricing;
  return (
    (Number.isFinite(p?.input) ? (p?.input as number) : 0) +
    (Number.isFinite(p?.output) ? (p?.output as number) : 0)
  );
}

/** Per-role score = the shared base score + a role overlay (soft, so an unfamiliar model still resolves). */
function roleScore(role: RoutedRole, m: CatalogModel): number {
  const name = (m.id.split("/").pop() ?? m.id).toLowerCase();
  const base = scoreModel(m);
  if (role === "executor") return base; // the current default — behavior unchanged where it matters
  if (role === "planner" || role === "reviewer") {
    // Planning/reviewing rewards reasoning + flagship tier more than raw coding specialization.
    let bonus = 0;
    if (m.supportedFeatures.includes("reasoning")) bonus += 25;
    if (FLAGSHIP.some((w) => name.includes(w))) bonus += 20;
    return base + bonus;
  }
  // compactor: a cheap/fast, WARM model is ideal for mechanical summarization — invert the small-tier penalty
  // and de-prefer the expensive flagship/coding tiers (spending them on summarization is the cost leak we fix).
  let bonus = 0;
  if (SMALL_TIER.some((w) => name.includes(w))) bonus += 45;
  if (FLAGSHIP.some((w) => name.includes(w))) bonus -= 30;
  if (name.includes("code")) bonus -= 40;
  if (m.isReady) bonus += 10;
  return base + bonus;
}

/**
 * Pick the best LIVE model for a phase role. `executor`/`planner`/`reviewer` require native tool-calls;
 * `compactor` does not (it only has to accept a text summary). `reviewer` prefers a model DIFFERENT from
 * `opts.avoid` (a genuine second opinion) when a comparable warm peer exists, else falls back to it. Returns
 * undefined only for an empty fleet — callers fall back to the run's model, so a role never strands a run.
 */
export function pickForRole(
  role: RoutedRole,
  catalog: CatalogModel[],
  opts: { avoid?: string } = {},
): string | undefined {
  if (catalog.length === 0) return undefined;
  const toolFiltered =
    role === "compactor" ? catalog : catalog.filter((m) => m.supportedFeatures.includes("tools"));
  const base = toolFiltered.length > 0 ? toolFiltered : catalog;
  const ready = base.filter((m) => m.isReady === true);
  const pool = ready.length > 0 ? ready : base;

  // Compaction is pure cost minimization: when the catalog carries PRICING, pick the genuinely cheapest warm
  // model (an expensive `vendor/flash` shouldn't beat a cheap generically-named one). Name tiers are only the
  // fallback when no pricing is advertised. the model-facts fallback appends authoritative facts, so a weak-but-
  // cheap summarizer is safe.
  if (role === "compactor") {
    const priced = pool.filter((m) => hasPricing(m));
    if (priced.length > 0) {
      return [...priced].sort((a, b) => priceOf(a) - priceOf(b) || a.id.localeCompare(b.id))[0]?.id;
    }
  }

  const scored = [...pool]
    .map((m) => ({ id: m.id, score: roleScore(role, m) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (role === "reviewer" && opts.avoid && scored[0]?.id === opts.avoid && scored.length > 1) {
    return scored[1]?.id; // a second opinion — a different warm model of comparable score
  }
  return scored[0]?.id;
}

export interface VisionPick {
  id: string;
  /** true = a READY vision model; false = only a COLD vision model exists (caller must NOT fire it — it 429s). */
  ready: boolean;
}

/**
 * Pick the best VISION-capable model from the live catalog (backs the non-vision relay: a blind served model
 * asks this model to describe the image). Vision-capable ⇔ supportsVision (catalog `inputModalities`), never a
 * hardcoded id. Prefers READY; if only cold vision models exist, returns the best with `ready:false` so the
 * caller can degrade honestly instead of firing a cold model. `exclude` drops already-failed peers on failover.
 */
export function pickVisionModel(
  catalog: CatalogModel[],
  opts: { exclude?: ReadonlySet<string> } = {},
): VisionPick | undefined {
  const exclude = opts.exclude ?? new Set<string>();
  const vision = catalog.filter((m) => supportsVision(m) && !exclude.has(m.id));
  if (vision.length === 0) return undefined;
  const ready = vision.filter((m) => m.isReady === true);
  const pool = ready.length > 0 ? ready : vision;
  const best = [...pool]
    .map((m) => ({ id: m.id, score: scoreVisionModel(m) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0];
  return best ? { id: best.id, ready: ready.length > 0 } : undefined;
}

/** Score a vision model for the relay: flagship up, small-tier mildly down (a small VLM is still fine for a
 *  one-shot description), reasoning + context as gentle bonuses. NO coding bonus (describing an image ≠ coding). */
export function scoreVisionModel(m: CatalogModel): number {
  const name = (m.id.split("/").pop() ?? m.id).toLowerCase();
  let s = 0;
  if (FLAGSHIP.some((w) => name.includes(w))) s += 20;
  if (SMALL_TIER.some((w) => name.includes(w))) s -= 15;
  if (m.supportedFeatures.includes("reasoning")) s += 5;
  s += Math.min(10, Math.log10(Math.max(1, m.contextLength ?? 0)));
  return s;
}

/**
 * Capability-tier score for one model (higher = a better default). Pure; see pickBestModel for the rationale.
 * Tier words are matched against the MODEL NAME only (the part after the last `/`), never the vendor — so a
 * vendor id like `smallco/pro` or `code-labs/x` isn't accidentally up/down-ranked by its vendor name.
 */
export function scoreModel(m: CatalogModel): number {
  const name = (m.id.split("/").pop() ?? m.id).toLowerCase();
  let s = 0;
  if (name.includes("code")) s += 40; // coding-specialized — ideal for a coding agent
  if (FLAGSHIP.some((w) => name.includes(w))) s += 20; // flagship tier
  if (SMALL_TIER.some((w) => name.includes(w))) s -= 25; // speed/cheap tier — a poor default for coding
  if (m.supportedFeatures.includes("reasoning")) s += 5;
  // Context as a MILD secondary signal (log-scaled + capped) — never enough to make a flash model the default.
  s += Math.min(10, Math.log10(Math.max(1, m.contextLength ?? 0)));
  return s;
}
