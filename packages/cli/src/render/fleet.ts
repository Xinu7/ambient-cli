import { join } from "node:path";
import { CapabilityStore, laneFor, resolveRecord } from "@amb/capabilities";
import { type CatalogModel, type Lane, availability, supportsVision } from "@amb/protocol";
import { ambHome } from "@amb/sessions";

export interface FleetRow {
  avail: "ready" | "cold" | "unknown";
  id: string;
  ctx: string;
  lane: Lane;
  vision: string;
  price: string;
}

function ctxLabel(n?: number): string {
  if (!n) return "—";
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
function laneLabel(lane: Lane): string {
  return `tools:${lane}`;
}
function visionLabel(m: CatalogModel): string {
  return supportsVision(m) ? "vision:yes" : "vision:no";
}
function priceLabel(m: CatalogModel): string {
  const p = m.pricing;
  if (!p || (p.input == null && p.output == null)) return "";
  return `$${p.input ?? 0}/${p.output ?? 0}`;
}

const RANK: Record<FleetRow["avail"], number> = { ready: 0, unknown: 1, cold: 2 };

/** Read the capability store (if any) to show each model's evidence-based lane. */
export function laneResolver(): (m: CatalogModel) => Lane {
  const store = new CapabilityStore(join(ambHome(), "capabilities.json"));
  const now = Date.now();
  return (m) => laneFor(m, resolveRecord(m, store.get(m.id), now));
}

/** Pure: map models to sorted display rows (ready → unknown → cold, then by id). */
export function formatFleetRows(
  models: CatalogModel[],
  resolveLane: (m: CatalogModel) => Lane,
): FleetRow[] {
  return models
    .map((m) => ({
      avail: availability(m),
      id: m.id,
      ctx: ctxLabel(m.contextLength),
      lane: resolveLane(m),
      vision: visionLabel(m),
      price: priceLabel(m),
    }))
    .sort((a, b) => RANK[a.avail] - RANK[b.avail] || a.id.localeCompare(b.id));
}

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function colorFor(avail: FleetRow["avail"]): string {
  if (avail === "ready") return C.green;
  if (avail === "unknown") return C.yellow;
  return C.dim;
}
function availLabel(avail: FleetRow["avail"]): string {
  if (avail === "ready") return "●READY";
  if (avail === "cold") return " COLD ";
  return " WARM?";
}

function defaultColor(): boolean {
  return !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
}

/** Render the fleet view as terminal lines. Availability + evidence-based lane + vision + price, ready first. */
export function renderFleet(
  models: CatalogModel[],
  opts: { color?: boolean; resolveLane?: (m: CatalogModel) => Lane } = {},
): string[] {
  const useColor = opts.color ?? defaultColor();
  const resolveLane = opts.resolveLane ?? laneResolver();
  const rows = formatFleetRows(models, resolveLane);
  const readyCount = rows.filter((r) => r.avail === "ready").length;
  const idW = Math.min(44, Math.max(4, ...rows.map((r) => r.id.length)));
  const laneW = Math.max(...rows.map((r) => laneLabel(r.lane).length), 12);
  const header = `AMBIENT FLEET — ${models.length} models, ${readyCount} ready`;
  const lines: string[] = [useColor ? `${C.bold}${header}${C.reset}` : header, ""];
  for (const r of rows) {
    const line = `${availLabel(r.avail)}  ${r.id.padEnd(idW)}  ${r.ctx.padStart(6)}  ${laneLabel(r.lane).padEnd(laneW)}  ${r.vision}${r.price ? `  ${r.price}` : ""}`;
    lines.push(useColor ? `${colorFor(r.avail)}${line}${C.reset}` : line);
  }
  return lines;
}
