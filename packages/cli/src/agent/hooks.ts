import { spawn } from "node:child_process";
import type { HookCommand } from "@amb/context";
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

/** A port that runs these hook commands for a session (undefined when there are none). */
export function hooksPort(
  active: readonly HookCommand[],
  workspaceRoot: string,
  sessionId: () => string,
): HooksPort | undefined {
  if (active.length === 0) return undefined;
  return {
    async run(event, payload, signal) {
      const tool = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
      const hooks = active.filter((h) => h.event === event && matches(h.matcher, tool));
      if (hooks.length === 0) return {};
      const input = JSON.stringify({
        session_id: sessionId(),
        cwd: workspaceRoot,
        hook_event_name: event,
        ...payload,
        ...(tool
          ? {
              tool_name: CLAUDE_TOOL_NAME[tool] ?? tool,
              tool_input: toClaudeInput(tool, payload.tool_input),
            }
          : {}),
      });
      const runs = await Promise.all(hooks.map((h) => runCommand(h, input, workspaceRoot, signal)));
      return combine(runs.map((r) => interpret(event, tool, r)));
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
