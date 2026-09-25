import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  combine,
  fromClaudeInput,
  interpret,
  makeHooksControl,
  matches,
  toClaudeInput,
} from "../src/agent/hooks.js";

describe("reading what a hook asked for", () => {
  it("exit 2 blocks with stderr as the reason; other failures change nothing", () => {
    expect(interpret("PreToolUse", "bash", { code: 2, stdout: "", stderr: "no rm\n" })).toEqual({
      block: "no rm",
    });
    expect(interpret("PreToolUse", "bash", { code: 1, stdout: "boom", stderr: "x" })).toEqual({});
    expect(interpret("PreToolUse", "bash", { code: null, stdout: "", stderr: "" })).toEqual({});
  });

  it("reads Claude Code's JSON decisions", () => {
    const run = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
    expect(
      interpret(
        "PreToolUse",
        "bash",
        run({
          hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "nope" },
        }),
      ),
    ).toEqual({ block: "nope" });
    expect(
      interpret("PreToolUse", "bash", run({ hookSpecificOutput: { permissionDecision: "allow" } })),
    ).toEqual({ allow: true });
    expect(
      interpret("PreToolUse", "bash", run({ hookSpecificOutput: { permissionDecision: "ask" } })),
    ).toEqual({ ask: true });
    expect(interpret("Stop", undefined, run({ decision: "block", reason: "keep going" }))).toEqual({
      block: "keep going",
    });
    expect(interpret("Stop", undefined, run({ continue: false, stopReason: "halt" }))).toEqual({
      block: "halt",
    });
    expect(
      interpret(
        "PostToolUse",
        "edit",
        run({ hookSpecificOutput: { additionalContext: "lint clean" } }),
      ),
    ).toEqual({ context: "lint clean" });
  });

  it("plain stdout is context only for prompt and session events", () => {
    const out = { code: 0, stdout: "today is release day\n", stderr: "" };
    expect(interpret("UserPromptSubmit", undefined, out)).toEqual({
      context: "today is release day",
    });
    expect(interpret("SessionStart", undefined, out)).toEqual({ context: "today is release day" });
    expect(interpret("PostToolUse", "bash", out)).toEqual({});
  });

  it("maps a hook's rewritten input back to ambient's argument names", () => {
    const run = {
      code: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          updatedInput: { file_path: "b.ts", old_string: "a", new_string: "b" },
        },
      }),
      stderr: "",
    };
    expect(interpret("PreToolUse", "edit", run).updatedInput).toEqual({
      path: "b.ts",
      oldString: "a",
      newString: "b",
    });
  });

  it("combines several hooks: any block wins, ask beats allow, contexts join", () => {
    expect(combine([{ allow: true }, { ask: true }])).toEqual({ ask: true });
    expect(combine([{ allow: true }, { block: "x" }, { context: "a" }, { context: "b" }])).toEqual({
      block: "x",
      allow: true,
      context: "a\nb",
    });
  });
});

describe("tool names and inputs", () => {
  it("matchers use Claude's tool names or ambient's", () => {
    expect(matches("Bash", "bash")).toBe(true);
    expect(matches("Edit|Write", "write")).toBe(true);
    expect(matches("Edit|Write", "read")).toBe(false);
    expect(matches("mcp__.*", "mcp__github__search")).toBe(true);
    expect(matches("", "anything")).toBe(true);
    expect(matches("*", "read")).toBe(true);
    expect(matches("Bash", undefined)).toBe(true);
    expect(matches("[bad", "[bad")).toBe(true); // an invalid pattern matches only itself
  });

  it("hooks see Claude-shaped inputs; unknown tools pass through", () => {
    expect(toClaudeInput("write", { path: "a", content: "x" })).toEqual({
      file_path: "a",
      content: "x",
    });
    expect(toClaudeInput("mcp__x__y", { path: "a" })).toEqual({ path: "a" });
    expect(fromClaudeInput("write", { file_path: "a" })).toEqual({ path: "a" });
  });
});

describe.skipIf(process.platform === "win32")("running hooks", () => {
  let dir: string;
  let ws: string;
  let home: string;
  let trustFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amb-hookrun-"));
    ws = join(dir, "ws");
    home = join(dir, "home");
    trustFile = join(dir, "cfg", "trusted-hooks.json");
    mkdirSync(join(ws, ".claude"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const settings = (event: string, command: string, matcher = "") => ({
    hooks: { [event]: [{ matcher, hooks: [{ type: "command", command }] }] },
  });
  const signal = () => new AbortController().signal;

  it("sends the event JSON on stdin and blocks on exit 2", async () => {
    const control = makeHooksControl({
      workspaceRoot: ws,
      home,
      trustFile,
      config: {
        hooks: settings(
          "PreToolUse",
          `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stderr.write(j.tool_name+":"+j.tool_input.command+":"+j.session_id);process.exit(2)})'`,
          "Bash",
        ).hooks,
      },
    });
    const port = control.port(() => "ses_1");
    const out = await port?.run(
      "PreToolUse",
      { tool_name: "bash", tool_input: { command: "ls" } },
      signal(),
    );
    expect(out).toEqual({ block: "Bash:ls:ses_1" });
    // A non-matching tool doesn't run the hook.
    expect(await port?.run("PreToolUse", { tool_name: "read", tool_input: {} }, signal())).toEqual(
      {},
    );
  });

  it("a hook that hangs is stopped at its timeout and changes nothing", async () => {
    const control = makeHooksControl({
      workspaceRoot: ws,
      home,
      trustFile,
      config: {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "sleep 30; exit 2", timeout: 0.3 }] }],
        },
      },
    });
    const started = Date.now();
    expect(await control.port(() => "s")?.run("Stop", {}, signal())).toEqual({});
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("project hooks run only once trusted, and a changed configuration needs trusting again", async () => {
    const file = join(ws, ".claude", "settings.json");
    writeFileSync(file, JSON.stringify(settings("UserPromptSubmit", "echo from-project")));
    const control = makeHooksControl({ workspaceRoot: ws, home, trustFile, config: {} });
    expect(control.port(() => "s")).toBeUndefined();
    expect(control.untrustedCount()).toBe(1);
    expect(control.summary().join("\n")).toContain("1 hook that won't run until you trust it:");

    expect(control.trust()).toContain("Trusted 1 project hook");
    const out = await control.port(() => "s")?.run("UserPromptSubmit", { prompt: "hi" }, signal());
    expect(out).toEqual({ context: "from-project" });

    writeFileSync(file, JSON.stringify(settings("UserPromptSubmit", "echo changed")));
    expect(control.port(() => "s")).toBeUndefined();
    expect(control.untrustedCount()).toBe(1);
  });

  it("the user's Claude Code hooks run only when turned on", async () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(settings("SessionStart", "echo claude-user")),
    );
    const off = makeHooksControl({ workspaceRoot: ws, home, trustFile, config: {} });
    expect(off.port(() => "s")).toBeUndefined();
    expect(off.summary().join("\n")).toContain('"claudeHooks": true');

    const on = makeHooksControl({
      workspaceRoot: ws,
      home,
      trustFile,
      config: { claudeHooks: true },
    });
    expect(await on.port(() => "s")?.run("SessionStart", {}, signal())).toEqual({
      context: "claude-user",
    });
  });

  it("gives hooks the project folder", async () => {
    const control = makeHooksControl({
      workspaceRoot: ws,
      home,
      trustFile,
      config: { hooks: settings("SessionStart", 'echo "$CLAUDE_PROJECT_DIR"').hooks },
    });
    expect(await control.port(() => "s")?.run("SessionStart", {}, signal())).toEqual({
      context: ws,
    });
  });
});
