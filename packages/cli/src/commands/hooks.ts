import { workspaceSettings } from "../agent/workspace-settings.js";
import { configDir, loadConfig } from "../config.js";

/** `ambient hooks` lists the hooks that run in this folder; `ambient hooks trust` allows the project's own. */
export async function runHooks(args: string[]): Promise<void> {
  const config = loadConfig();
  const control = workspaceSettings(process.cwd(), config, configDir());
  const sub = args[0];
  if (sub === undefined || sub === "list") {
    process.stdout.write(`${control.hooksSummary().join("\n")}\n`);
    return;
  }
  if (sub === "trust") {
    process.stdout.write(`${control.trust()}\n`);
    return;
  }
  process.stderr.write(`ambient: unknown hooks command "${sub}" (use: ambient hooks [trust])\n`);
  process.exitCode = 1;
}
