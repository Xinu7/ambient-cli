import { type AmbientConfig, fetchCatalog, resolveConfig } from "@amb/ambient-api";
import { discoverSkills, pinSkill, readPinnedSkills, skillSource, unpinSkill } from "@amb/context";
import type { Grant, ToolDefinition } from "@amb/protocol";
import { SessionWriter } from "@amb/sessions";
import { render } from "ink";
import { createElement } from "react";
import { AmbientChatClient } from "../agent/ambient-client.js";
import { makeCapabilityPort } from "../agent/capability-port.js";
import { type McpConnection, connectMcp } from "../agent/mcp-connect.js";
import { type FleetRow, formatFleetRows, laneResolver } from "../render/fleet.js";
import { NOT_SIGNED_IN, resolveApiKey } from "../secrets.js";
import { App } from "./App.js";
import type { AgentMode, Effort, Permission } from "./state.js";

// Enter/leave the alternate screen buffer so the TUI TAKES OVER the terminal (like Claude Code / Codex):
// the old scrollback is hidden while amb runs, and restored intact on exit.
const ALT_ENTER = "\x1b[?1049h\x1b[2J\x1b[H";
const ALT_EXIT = "\x1b[?1049l";

export interface TuiOptions {
  agentMode: AgentMode;
  permission: Permission;
  effort: Effort;
  requestedModel: string;
  maxTurns: number;
  initialTask?: string;
  /** Skip connecting the user's MCP servers entirely (lean, instant start with only the built-in tools). */
  noMcp?: boolean;
  /** Session grants seeded from the config allowlist (auto-allow those tools without prompting). */
  initialGrants?: Grant[];
  /** A north-star goal to start the session with (`--goal`) — shown pinned + threaded into every run. */
  initialGoal?: string;
}

/** Fetch the live fleet (sorted rows) for the splash count + the model picker — best-effort, never blocks long. */
async function fleetSummary(config: AmbientConfig): Promise<FleetRow[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const models = await fetchCatalog(config, { signal: controller.signal });
    return formatFleetRows(models, laneResolver());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Launch the interactive Ink TUI. Requires a TTY (falls back with a hint otherwise). */
export async function runTui(opts: TuiOptions): Promise<void> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`);
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'ambient: the TUI needs an interactive terminal. Use `ambient "<task>"` for non-interactive runs.\n',
    );
    process.exitCode = 1;
    return;
  }

  const config: AmbientConfig = { baseUrl: resolveConfig().baseUrl, apiKey };
  const client = new AmbientChatClient(config);
  const cwd = process.cwd();
  const fleet = await fleetSummary(config);
  // Skills for the `/skills` summary + interactive browser — a fast fs scan at the edge (the App never
  // touches the filesystem). `onTogglePin` writes the pin list and returns the new pinned state.
  const pinnedNames = new Set(readPinnedSkills(cwd));
  const skillRows = discoverSkills(cwd).map((s) => ({
    name: s.name,
    source: skillSource(s.path),
    description: s.description,
    pinned: pinnedNames.has(s.name),
  }));
  const skillsInfo = { total: skillRows.length, pinned: pinnedNames.size };
  const onTogglePin = (name: string): boolean => {
    if (pinnedNames.has(name)) {
      unpinSkill(name);
      pinnedNames.delete(name);
      return false;
    }
    pinSkill(name);
    pinnedNames.add(name);
    return true;
  };

  // MCP connects in the BACKGROUND (kicked off after render, below) so the UI appears INSTANTLY instead of
  // blocking ~30s while a big MCP suite (10+ servers) spawns. Tools attach to the next run once ready; the
  // holder is read live via getMcpTools. `--no-mcp` / AMBIENT_NO_MCP skips MCP entirely for the leanest start.
  const skipMcp = opts.noMcp || process.env.AMBIENT_NO_MCP === "1";
  let mcpTools: ToolDefinition[] = [];
  // A holder (not a bare `let`) so TS keeps the McpConnection|null type across the background callback that
  // assigns it — the finally/ signal handlers read it live to close the servers on exit.
  const mcpConn: { current: McpConnection | null } = { current: null };

  // Take over the terminal, and ALWAYS restore it (normal exit, Ctrl-C, or a crash) so we never leave the
  // user stranded in the alternate screen.
  process.stdout.write(ALT_ENTER);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.stdout.write(ALT_EXIT);
  };
  process.once("exit", restore);
  // An EXTERNAL signal (kill, terminal close) terminates Node WITHOUT firing `exit`, which would strand
  // the shell inside the alternate screen AND re-deliver the signal before `waitUntilExit().finally` runs —
  // so the MCP servers must be shut down HERE (idempotent), else their child processes leak on a signal exit.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      mcpConn.current?.close();
      restore();
      process.kill(process.pid, sig);
    });
  }

  const instance = render(
    createElement(App, {
      client,
      makeWriter: (sessionId: string) =>
        new SessionWriter(sessionId, () => new Date().toISOString()),
      capabilities: makeCapabilityPort(),
      agentMode: opts.agentMode,
      permission: opts.permission,
      effort: opts.effort,
      requestedModel: opts.requestedModel,
      maxTurns: opts.maxTurns,
      cwd,
      workspaceRoot: cwd,
      fleet,
      initialTask: opts.initialTask,
      ...(opts.initialGoal ? { initialGoal: opts.initialGoal } : {}),
      ...(opts.initialGrants && opts.initialGrants.length > 0
        ? { initialGrants: opts.initialGrants }
        : {}),
      getMcpTools: () => mcpTools,
      skillsInfo,
      skills: skillRows,
      onTogglePin,
    }),
    { exitOnCtrlC: false },
  );

  // Now that the UI is on screen, connect MCP in the background and hand its tools to the live getter. A
  // failure never breaks the session — the built-in tools always work; MCP just augments them when ready.
  let done = false;
  if (!skipMcp) {
    void connectMcp(cwd, {
      approveServer: async () => process.env.AMBIENT_MCP_ALLOW_PROJECT === "1",
    })
      .then((m) => {
        if (done) {
          m.close(); // the session already ended while we were still connecting — don't leak the servers
          return;
        }
        mcpConn.current = m;
        mcpTools = m.tools;
      })
      .catch(() => {});
  }

  try {
    await instance.waitUntilExit();
  } finally {
    done = true;
    mcpConn.current?.close();
    restore();
  }
}
