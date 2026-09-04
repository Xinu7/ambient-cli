import { fetchCatalog, resolveConfig } from "@amb/ambient-api";
import { renderFleet } from "../render/fleet.js";

/** `amb models [--json]` — fetch and display the live Ambient fleet (no API key required). */
export async function runModels(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const config = resolveConfig();
  const models = await fetchCatalog(config);
  if (json) {
    process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderFleet(models).join("\n")}\n`);
}
