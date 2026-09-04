import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Grant, Mode } from "@amb/protocol";
import type { EffortSetting } from "@amb/runtime";
import { z } from "zod";

/**
 * Persistent user config for `amb`, at ~/.config/amb/config.json (or $XDG_CONFIG_HOME/amb, or $AMB_CONFIG_HOME
 * for tests). Every field is OPTIONAL — the file only sets DEFAULTS; an explicit flag or env var always wins.
 * A missing file is normal (all built-in defaults). A malformed file WARNS and is ignored, never fatal — a
 * typo in a dotfile must not brick the CLI.
 */
export const AmbConfigSchema = z
  .object({
    /** Default requested model id (same as --model). "auto" / omitted ⇒ best live pick. */
    model: z.string().min(1).optional(),
    /** Default reasoning effort (same as --effort). */
    effort: z.enum(["off", "auto", "low", "medium", "high"]).optional(),
    /** Default permission mode (same as --plan/--accept-edits/--bypass). Drives BOTH UIs. */
    mode: z.enum(["plan", "ask", "accept-edits", "bypass"]).optional(),
    /** Default agent-loop cap (same as --max-turns). */
    maxTurns: z.number().int().min(1).max(1000).optional(),
    /** Skip connecting MCP servers by default (same as --no-mcp). */
    noMcp: z.boolean().optional(),
    /** Tool names to AUTO-ALLOW without prompting (a persistent allowlist). Powerful — listing "bash" here
     *  lets the agent run ANY shell command unprompted. Your file, your choice; empty/omitted ⇒ prompt as
     *  usual. Seeded as session-scoped grants at run start. */
    allow: z.array(z.string().min(1)).optional(),
  })
  // Unknown keys are stripped (default) rather than rejected, so a future field in an older binary is tolerated.
  .strip();

export type AmbConfig = z.infer<typeof AmbConfigSchema>;

/** The config file path, honoring $AMB_CONFIG_HOME then $XDG_CONFIG_HOME then ~/.config. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.AMB_CONFIG_HOME ?? env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "amb", "config.json");
}

/**
 * Load + validate the config. Returns {} for a missing file; WARNS to stderr and returns {} for unreadable /
 * non-JSON / schema-invalid content (never throws). `warn` is injectable for tests.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): AmbConfig {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    warn(`ambient: ignoring ${path} — not valid JSON`);
    return {};
  }
  const parsed = AmbConfigSchema.safeParse(raw);
  if (!parsed.success) {
    warn(
      `ambient: ignoring invalid ${path} — ${parsed.error.issues[0]?.message ?? "schema error"}`,
    );
    return {};
  }
  return parsed.data;
}

/** The (agentMode, permission) axis pair a config `mode` maps to for the TUI. Plan is the read-only agent
 *  mode; the rest ride the permission axis with agentMode=build. Pure. */
export function tuiAxesFromMode(mode: Mode): {
  agentMode: "build" | "plan";
  permission: "ask" | "accept-edits" | "bypass";
} {
  if (mode === "plan") return { agentMode: "plan", permission: "ask" };
  return { agentMode: "build", permission: mode };
}

/** Seed session-scoped grants from the config allowlist (the user's explicit auto-allow choice). */
export function grantsFromConfig(config: AmbConfig): Grant[] {
  return (config.allow ?? []).map((toolName) => ({ scope: "session" as const, toolName }));
}

/** Narrow the config effort to the runtime's EffortSetting (identical union; this documents the intent). */
export function configEffort(config: AmbConfig): EffortSetting | undefined {
  return config.effort;
}
