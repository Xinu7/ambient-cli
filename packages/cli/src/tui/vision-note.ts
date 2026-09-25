import type { FleetRow } from "../render/fleet.js";

/**
 * What happens to an attached image with the model you've chosen, said BEFORE you send: nothing to say when
 * the model can see images; otherwise which vision model will describe it, or that none is available.
 * Computed from the live fleet (never a hardcoded model list).
 */
export function visionNote(
  requested: string,
  fleet: readonly FleetRow[] | undefined,
): string | undefined {
  if (!fleet || fleet.length === 0) return undefined;
  const short = (id: string) => id.split("/").pop() ?? id;
  const vision = fleet.filter((r) => r.vision === "vision:yes");
  const rank = (r: FleetRow) => (r.avail === "ready" ? 0 : r.avail === "unknown" ? 1 : 2);
  const describer = [...vision].sort((a, b) => rank(a) - rank(b))[0];
  const chosen = fleet.find((r) => r.id === requested);
  if (chosen) {
    if (chosen.vision === "vision:yes") return undefined;
    return describer
      ? `${short(chosen.id)} can't see images — ${short(describer.id)} will describe it`
      : `${short(chosen.id)} can't see images, and no vision model is available — describe it in words`;
  }
  // `auto` (or an id not in the fleet): the served model isn't known until the run starts.
  return describer
    ? `if the model can't see images, ${short(describer.id)} will describe it`
    : "no vision model is available — if the model can't see images, describe it in words";
}
