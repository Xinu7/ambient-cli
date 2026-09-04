import { KEYS_URL, fetchCatalog, resolveConfig } from "@amb/ambient-api";
import { githubStatus, githubSummary } from "../agent/github.js";
import { bold, dim } from "../render/color.js";
import { resolveApiKey } from "../secrets.js";

/** `ambient doctor` — self-diagnostic: node version, config, key presence, live catalog reachability. */
export async function runDoctor(): Promise<void> {
  const ok = (s: string) => process.stdout.write(`  ✓ ${s}\n`);
  const warn = (s: string) => process.stdout.write(`  ! ${s}\n`);
  process.stdout.write(`${bold("ambient doctor")}\n\n`);

  ok(`node ${process.version}`);

  let baseUrl = "";
  try {
    baseUrl = resolveConfig().baseUrl;
    ok(`base URL ${baseUrl}`);
  } catch (err) {
    warn(`base URL invalid: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const key = resolveApiKey();
  if (key) ok("API key found (env or keychain)");
  else
    warn(
      `not signed in — 'ambient models' works without a key; run 'ambient login' (or create one at ${KEYS_URL}) to run tasks`,
    );

  try {
    const models = await fetchCatalog({ baseUrl, apiKey: key });
    const ready = models.filter((m) => m.isReady === true).length;
    ok(`catalog reachable: ${models.length} models, ${ready} ready`);
  } catch (err) {
    warn(`catalog unreachable: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // GitHub sign-in (optional — used for commit/push/PR work; never blocks the CLI).
  const gh = githubStatus();
  if (gh.authed) ok(githubSummary(gh).replace(/^GitHub:\s*/, "GitHub — "));
  else warn(githubSummary(gh).replace(/^GitHub:\s*/, "GitHub — "));

  process.stdout.write(dim("\nAll systems go.\n"));
}
