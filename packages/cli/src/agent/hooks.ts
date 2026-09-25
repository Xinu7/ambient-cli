import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type DiscoveredHooks,
  type HookCommand,
  discoverHooks,
  hooksFingerprint,
} from "@amb/context";
import type { HookEventName, HookOutcome, HooksPort } from "@amb/runtime";
import { killProcessTree, machineShell, shellEnv, shellInvocation } from "@amb/tools-core";

/**
 * Runs hook scripts in Claude Code's format: the event's JSON on stdin; exit 0 = carry on (stdout may be JSON
 * with a decision, or plain text that becomes context for prompt/session events); exit 2 = block, with stderr
 * as the reason; any other exit = the hook failed, which never stops the run. Matching hooks run in parallel.
 */

/** ambient tool names → the Claude Code names hooks are written against. */
const CLAUDE_TOOL_NAME: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "MultiEdit",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  subagent: "Task",
  plan: "TodoWrite",
  skill: "Skill",
  ask_user: "AskUserQuestion",
};

/** ambient argument names → Claude's (and back), for the tools whose inputs differ. */
const FIELD_RENAMES: Array<[string, string]> = [
  ["path", "file_path"],
  ["oldString", "old_string"],
  ["newString", "new_string"],
  ["replaceAll", "replace_all"],
];

export function toClaudeInput(tool: string, input: unknown): unknown {
  if (!CLAUDE_TOOL_NAME[tool] || !input || typeof input !== "object") return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const [ours, theirs] of FIELD_RENAMES) {
    if (ours in out && !(theirs in out)) {
      out[theirs] = out[ours];
      delete out[ours];
    }
  }
  return out;
}

export function fromClaudeInput(
  tool: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!CLAUDE_TOOL_NAME[tool]) return input;
  const out: Record<string, unknown> = { ...input };
  for (const [ours, theirs] of FIELD_RENAMES) {
    if (theirs in out && !(ours in out)) {
      out[ours] = out[theirs];
      delete out[theirs];
    }
  }
  return out;
}

/** Whether a hook's matcher applies to this tool (by its Claude name or ambient's). */
export function matches(matcher: string, tool: string | undefined): boolean {
  if (!matcher || matcher === "*" || tool === undefined) return true;
  const names = [tool, CLAUDE_TOOL_NAME[tool]].filter((n): n is string => Boolean(n));
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return names.some((n) => re.test(n));
  } catch {
    return names.includes(matcher);
  }
}

/** What one hook run produced, before combining. */
interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 100_000;
const CONTEXT_EVENTS = new Set<HookEventName>(["UserPromptSubmit", "SessionStart"]);

/** Turn one hook's exit code and output into what it asked for. */
export function interpret(
  event: HookEventName,
  tool: string | undefined,
  run: HookRun,
): HookOutcome {
  if (run.code === 2) return { block: run.stderr.trim() || "blocked by a hook" };
  if (run.code !== 0) return {};
  const text = run.stdout.trim();
  let json: Record<string, unknown> | undefined;
  if (text.startsWith("{")) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
  }
  if (!json) return CONTEXT_EVENTS.has(event) && text ? { context: text } : {};
  const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const out: HookOutcome = {};
  const reason = (r: unknown) => (typeof r === "string" && r.trim() ? r.trim() : undefined);
  if (json.continue === false) out.block = reason(json.stopReason) ?? "stopped by a hook";
  if (json.decision === "block") out.block = reason(json.reason) ?? "blocked by a hook";
  if (json.decision === "approve") out.allow = true;
  const permission = specific.permissionDecision;
  if (permission === "deny")
    out.block = reason(specific.permissionDecisionReason) ?? "denied by a hook";
  if (permission === "allow") out.allow = true;
  if (permission === "ask") out.ask = true;
  const context = reason(specific.additionalContext);
  if (context) out.context = context;
  if (specific.updatedInput && typeof specific.updatedInput === "object" && tool) {
    out.updatedInput = fromClaudeInput(tool, specific.updatedInput as Record<string, unknown>);
  }
  return out;
}

/** Combine several hooks' outcomes: any block wins, "ask" beats "allow", contexts are joined. */
export function combine(outcomes: readonly HookOutcome[]): HookOutcome {
  const out: HookOutcome = {};
  const blocks = outcomes.map((o) => o.block).filter(Boolean);
  if (blocks.length > 0) out.block = blocks.join("\n");
  if (outcomes.some((o) => o.ask)) out.ask = true;
  else if (outcomes.some((o) => o.allow)) out.allow = true;
  const contexts = outcomes.map((o) => o.context).filter(Boolean);
  if (contexts.length > 0) out.context = contexts.join("\n");
  const updated = outcomes.filter((o) => o.updatedInput).at(-1)?.updatedInput;
  if (updated) out.updatedInput = updated;
  return out;
}

function runCommand(
  hook: HookCommand,
  input: string,
  cwd: string,
  signal: AbortSignal,
): Promise<HookRun> {
  return new Promise((resolve) => {
    const shell = machineShell();
    const command = hook.pluginRoot
      ? hook.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", hook.pluginRoot)
      : hook.command;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell.path, shellInvocation(shell, command), {
        cwd,
        env: {
          ...shellEnv(shell),
          CLAUDE_PROJECT_DIR: cwd,
          AMBIENT_PROJECT_DIR: cwd,
          ...(hook.pluginRoot ? { CLAUDE_PLUGIN_ROOT: hook.pluginRoot } : {}),
        },
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr });
    };
    const stop = () => {
      if (typeof child.pid === "number" && child.exitCode === null) killProcessTree(child.pid);
      finish(null);
    };
    const timer = setTimeout(stop, hook.timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** Where trusted project hook configurations are remembered, by workspace. */
export function trustFilePath(configFolder: string): string {
  return join(configFolder, "trusted-hooks.json");
}

function readTrust(file: string): Record<string, string> {
  try {
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function isProjectTrusted(
  file: string,
  workspaceRoot: string,
  hooks: readonly HookCommand[],
): boolean {
  return hooks.length > 0 && readTrust(file)[workspaceRoot] === hooksFingerprint(hooks);
}

/** Trust this project's current hook configuration (a later change needs trusting again). */
export function trustProject(
  file: string,
  workspaceRoot: string,
  hooks: readonly HookCommand[],
): void {
  const next = { ...readTrust(file), [workspaceRoot]: hooksFingerprint(hooks) };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export interface HooksSetup {
  port: HooksPort | undefined;
  discovered: DiscoveredHooks;
  /** Hooks that will run. */
  active: HookCommand[];
  /** Project hooks that exist but aren't trusted yet (they don't run). */
  untrustedProject: HookCommand[];
  claudeHooksEnabled: boolean;
}

export function setupHooks(opts: {
  workspaceRoot: string;
  sessionId: () => string;
  ambientSettings?: unknown;
  claudeHooks?: boolean;
  trustFile: string;
  home?: string;
}): HooksSetup {
  const discovered = discoverHooks({
    workspaceRoot: opts.workspaceRoot,
    ...(opts.home ? { home: opts.home } : {}),
    ambientSettings: opts.ambientSettings,
  });
  const trusted = isProjectTrusted(opts.trustFile, opts.workspaceRoot, discovered.project);
  const claudeHooksEnabled = opts.claudeHooks === true;
  const active = [
    ...discovered.ambient,
    ...(trusted ? discovered.project : []),
    ...(claudeHooksEnabled ? [...discovered.claudeUser, ...discovered.plugins] : []),
  ];
  const untrustedProject = trusted ? [] : discovered.project;
  const port: HooksPort | undefined =
    active.length === 0
      ? undefined
      : {
          async run(event, payload, signal) {
            const tool = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
            const hooks = active.filter((h) => h.event === event && matches(h.matcher, tool));
            if (hooks.length === 0) return {};
            const input = JSON.stringify({
              session_id: opts.sessionId(),
              cwd: opts.workspaceRoot,
              hook_event_name: event,
              ...payload,
              ...(tool
                ? {
                    tool_name: CLAUDE_TOOL_NAME[tool] ?? tool,
                    tool_input: toClaudeInput(tool, payload.tool_input),
                  }
                : {}),
            });
            const runs = await Promise.all(
              hooks.map((h) => runCommand(h, input, opts.workspaceRoot, signal)),
            );
            return combine(runs.map((r) => interpret(event, tool, r)));
          },
        };
  return { port, discovered, active, untrustedProject, claudeHooksEnabled };
}

/** Where a hook came from, as the user would say it. */
const SOURCE_LABEL: Record<HookCommand["source"], string> = {
  ambient: "ambient config",
  project: "this project (.claude/settings)",
  "claude-user": "~/.claude/settings.json",
  plugin: "a Claude Code plugin",
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function describeHook(h: HookCommand): string {
  const on = h.matcher && h.matcher !== "*" ? `${h.event}(${h.matcher})` : h.event;
  const cmd = h.command.length > 70 ? `${h.command.slice(0, 69)}…` : h.command;
  return `  ${on} → ${cmd}`;
}

/** The hooks for a session, re-read for every run so edits and trust changes apply without a restart. */
export interface HooksControl {
  /** The hooks port for the next run, or undefined when no hook would run. */
  port(sessionId: () => string): HooksPort | undefined;
  /** What `/hooks` shows. */
  summary(): string[];
  /** Trust this project's current hooks; returns what happened. */
  trust(): string;
  /** How many of the project's hooks are waiting to be trusted. */
  untrustedCount(): number;
}

export function makeHooksControl(opts: {
  workspaceRoot: string;
  config: { hooks?: unknown; claudeHooks?: boolean };
  trustFile: string;
  home?: string;
}): HooksControl {
  const setup = (sessionId: () => string) =>
    setupHooks({
      workspaceRoot: opts.workspaceRoot,
      sessionId,
      ambientSettings: opts.config.hooks ? { hooks: opts.config.hooks } : undefined,
      ...(opts.config.claudeHooks !== undefined ? { claudeHooks: opts.config.claudeHooks } : {}),
      trustFile: opts.trustFile,
      ...(opts.home ? { home: opts.home } : {}),
    });
  return {
    port: (sessionId) => setup(sessionId).port,
    summary() {
      const s = setup(() => "");
      const lines: string[] = [];
      if (s.active.length === 0 && s.untrustedProject.length === 0)
        lines.push("No hooks will run.");
      else if (s.active.length > 0) {
        lines.push(`${plural(s.active.length, "hook")} will run:`);
        for (const source of Object.keys(SOURCE_LABEL) as HookCommand["source"][]) {
          const group = s.active.filter((h) => h.source === source);
          if (group.length === 0) continue;
          lines.push(` From ${SOURCE_LABEL[source]}:`);
          for (const h of group) lines.push(describeHook(h));
        }
      }
      const gap = () => {
        if (lines.length > 0) lines.push("");
      };
      const waiting = s.untrustedProject.length;
      if (waiting > 0) {
        gap();
        lines.push(
          `This project has ${plural(waiting, "hook")} that won't run until you trust ${waiting === 1 ? "it" : "them"}:`,
        );
        for (const h of s.untrustedProject) lines.push(describeHook(h));
        lines.push(
          "Review, then trust with /hooks trust (ambient hooks trust in a shell). A later change needs trusting again.",
        );
      }
      const optIn = s.discovered.claudeUser.length + s.discovered.plugins.length;
      if (!s.claudeHooksEnabled && optIn > 0) {
        gap();
        lines.push(
          `${plural(optIn, "Claude Code hook")} from ~/.claude and plugins ${optIn === 1 ? "is" : "are"} off. Set "claudeHooks": true in ambient's config to run them.`,
        );
      }
      return lines;
    },
    untrustedCount: () => setup(() => "").untrustedProject.length,
    trust() {
      const s = setup(() => "");
      if (s.discovered.project.length === 0) return "This project has no hooks to trust.";
      if (s.untrustedProject.length === 0) return "This project's hooks are already trusted.";
      try {
        trustProject(opts.trustFile, opts.workspaceRoot, s.discovered.project);
      } catch (e) {
        return `Couldn't save the trust setting: ${(e as Error).message}`;
      }
      const n = s.discovered.project.length;
      return `Trusted ${plural(n, "project hook")}. ${n === 1 ? "It runs" : "They run"} from the next message.`;
    },
  };
}

/** Fire an event whose outcome doesn't matter (session end, notifications), bounded so exit never hangs. */
export async function fireAndForget(
  port: HooksPort | undefined,
  event: HookEventName,
  payload: Record<string, unknown>,
  limitMs = 5_000,
): Promise<void> {
  if (!port) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), limitMs);
  try {
    await port.run(event, payload, ac.signal);
  } catch {
    // A failing hook never breaks the session.
  } finally {
    clearTimeout(timer);
  }
}

/** The workspace's hooks as ambient's config sets them up (the one place CLI entry points build them). */
export function workspaceHooks(
  workspaceRoot: string,
  config: { hooks?: unknown; claudeHooks?: boolean },
  configFolder: string,
): HooksControl {
  return makeHooksControl({ workspaceRoot, config, trustFile: trustFilePath(configFolder) });
}

/** A one-line heads-up when the project has hooks that won't run yet (headless runs can't ask). */
export function untrustedNote(control: HooksControl): string | undefined {
  const n = control.untrustedCount();
  return n > 0
    ? `This project has ${n} hook${n === 1 ? "" : "s"} that won't run until you trust them (ambient hooks).`
    : undefined;
}
