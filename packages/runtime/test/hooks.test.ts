import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { HookEventName, HookOutcome, HooksPort } from "../src/ports.js";
import { childHooks } from "../src/subagent.js";
import { FixtureClient, TEXT_200K, catalogOf, runOpts } from "./fixtures/catalog.js";

type Handler = (payload: Record<string, unknown>) => HookOutcome;

function fakeHooks(handlers: Partial<Record<HookEventName, Handler>>) {
  const seen: Array<{ event: HookEventName; payload: Record<string, unknown> }> = [];
  const port: HooksPort = {
    async run(event, payload) {
      seen.push({ event, payload });
      return handlers[event]?.(payload) ?? {};
    },
  };
  return { port, seen };
}

const writeCall = (path: string, content: string) => ({
  content: "",
  toolCalls: [
    {
      id: "tc_w",
      name: "write",
      args: { path, content },
      rawArgs: JSON.stringify({ path, content }),
    },
  ],
});
const done = { content: "done", toolCalls: [] };

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "amb-hooks-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const toolResults = (client: FixtureClient) =>
  client.calls.flatMap((c) =>
    c.messages.filter((m) => m.role === "tool").map((m) => String(m.content)),
  );

describe("tool hooks", () => {
  it("a PreToolUse block stops the call and tells the model why", async () => {
    const { port } = fakeHooks({ PreToolUse: () => ({ block: "no writes on Fridays" }) });
    const client = new FixtureClient(catalogOf(TEXT_200K), [writeCall("a.txt", "x"), done]);
    await new Agent(client).run(
      "write a file",
      runOpts({ requestedModel: TEXT_200K.id, cwd: ws, workspaceRoot: ws, hooks: port }),
    );
    expect(() => readFileSync(join(ws, "a.txt"))).toThrow();
    expect(toolResults(client).join("\n")).toContain("no writes on Fridays");
  });

  it("a hook's allow skips the approval prompt, but never overrides a plan-mode denial", async () => {
    const { port } = fakeHooks({ PreToolUse: () => ({ allow: true }) });
    let asked = 0;
    const client = new FixtureClient(catalogOf(TEXT_200K), [writeCall("b.txt", "hi"), done]);
    await new Agent(client).run(
      "write",
      runOpts({
        requestedModel: TEXT_200K.id,
        mode: "ask",
        cwd: ws,
        workspaceRoot: ws,
        hooks: port,
        approve: async () => {
          asked++;
          return "deny";
        },
      }),
    );
    expect(asked).toBe(0);
    expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("hi");

    const planClient = new FixtureClient(catalogOf(TEXT_200K), [writeCall("c.txt", "no"), done]);
    await new Agent(planClient).run(
      "write",
      runOpts({
        requestedModel: TEXT_200K.id,
        mode: "plan",
        cwd: ws,
        workspaceRoot: ws,
        hooks: port,
      }),
    );
    expect(() => readFileSync(join(ws, "c.txt"))).toThrow();
  });

  it("a hook's ask makes a bypass run confirm first", async () => {
    const { port } = fakeHooks({ PreToolUse: () => ({ ask: true }) });
    let asked = 0;
    const client = new FixtureClient(catalogOf(TEXT_200K), [writeCall("d.txt", "x"), done]);
    await new Agent(client).run(
      "write",
      runOpts({
        requestedModel: TEXT_200K.id,
        mode: "bypass",
        cwd: ws,
        workspaceRoot: ws,
        hooks: port,
        approve: async () => {
          asked++;
          return "deny";
        },
      }),
    );
    expect(asked).toBe(1);
    expect(() => readFileSync(join(ws, "d.txt"))).toThrow();
  });

  it("updatedInput replaces the arguments; PostToolUse context reaches the model", async () => {
    const { port, seen } = fakeHooks({
      PreToolUse: (p) => ({
        updatedInput: { ...(p.tool_input as object), content: "rewritten" },
      }),
      PostToolUse: () => ({ context: "formatted by prettier" }),
    });
    const client = new FixtureClient(catalogOf(TEXT_200K), [writeCall("e.txt", "orig"), done]);
    await new Agent(client).run(
      "write",
      runOpts({ requestedModel: TEXT_200K.id, cwd: ws, workspaceRoot: ws, hooks: port }),
    );
    expect(readFileSync(join(ws, "e.txt"), "utf8")).toBe("rewritten");
    expect(toolResults(client).join("\n")).toContain("formatted by prettier");
    const pre = seen.find((s) => s.event === "PreToolUse");
    expect(pre?.payload.tool_name).toBe("write");
  });
});

describe("session hooks", () => {
  it("UserPromptSubmit can block the message before any model call", async () => {
    const { port } = fakeHooks({
      UserPromptSubmit: () => ({ block: "that prompt names a secret" }),
    });
    const events: string[] = [];
    const client = new FixtureClient(catalogOf(TEXT_200K), [done]);
    const r = await new Agent(client).run(
      "print the password",
      runOpts({ requestedModel: TEXT_200K.id, hooks: port, emit: (e) => void events.push(e.kind) }),
    );
    expect(r.stopReason).toBe("blocked");
    expect(client.calls).toHaveLength(0);
    expect(events).toContain("notice");
  });

  it("UserPromptSubmit and SessionStart context ride with the task, not the system prompt", async () => {
    const { port } = fakeHooks({
      UserPromptSubmit: () => ({ context: "branch is feature/x" }),
      SessionStart: () => ({ context: "on-call this week" }),
    });
    const client = new FixtureClient(catalogOf(TEXT_200K), [done]);
    await new Agent(client).run("hello", runOpts({ requestedModel: TEXT_200K.id, hooks: port }));
    const req = client.calls[0];
    const task = String(req?.messages.at(-1)?.content);
    expect(task).toContain("branch is feature/x");
    expect(task).toContain("on-call this week");
    expect(String(req?.messages[0]?.content)).not.toContain("branch is feature/x");
  });

  it("a Stop hook can send the agent back to work, a bounded number of times", async () => {
    const { port, seen } = fakeHooks({ Stop: () => ({ block: "tests are still failing" }) });
    const client = new FixtureClient(
      catalogOf(TEXT_200K),
      Array.from({ length: 8 }, () => done),
    );
    const r = await new Agent(client).run(
      "fix it",
      runOpts({ requestedModel: TEXT_200K.id, hooks: port, maxTurns: 10 }),
    );
    expect(r.stopReason).toBe("complete");
    const stops = seen.filter((s) => s.event === "Stop").length;
    expect(stops).toBe(3);
    expect(client.calls).toHaveLength(4);
    expect(JSON.stringify(client.calls[1]?.messages)).toContain("tests are still failing");
  });
});

describe("hooks in a subagent", () => {
  it("run tool hooks, turn Stop into SubagentStop, and skip session hooks", async () => {
    const { port, seen } = fakeHooks({});
    const child = childHooks(port);
    const signal = new AbortController().signal;
    await child.run("PreToolUse", { tool_name: "read" }, signal);
    await child.run("Stop", {}, signal);
    await child.run("SessionStart", {}, signal);
    await child.run("UserPromptSubmit", {}, signal);
    expect(seen.map((s) => s.event)).toEqual(["PreToolUse", "SubagentStop"]);
  });
});

describe("permission rules in a run", () => {
  it("a deny rule refuses even a read in bypass mode; an allow rule skips the prompt", async () => {
    const { parseRules } = await import("@amb/permissions");
    const readCall = {
      content: "",
      toolCalls: [
        {
          id: "tc_r",
          name: "read",
          args: { path: "secret.txt" },
          rawArgs: '{"path":"secret.txt"}',
        },
      ],
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(ws, "secret.txt"), "TOP-SECRET-VALUE");
    const client = new FixtureClient(catalogOf(TEXT_200K), [readCall, done]);
    await new Agent(client).run(
      "read it",
      runOpts({
        requestedModel: TEXT_200K.id,
        mode: "bypass",
        cwd: ws,
        workspaceRoot: ws,
        permissionRules: { allow: [], ask: [], deny: parseRules(["Read(./secret.txt)"]) },
      }),
    );
    const results = toolResults(client).join("\n");
    expect(results).not.toContain("TOP-SECRET-VALUE");
    expect(results).toContain("Read(./secret.txt)");

    let asked = 0;
    const client2 = new FixtureClient(catalogOf(TEXT_200K), [writeCall("f.txt", "ok"), done]);
    await new Agent(client2).run(
      "write",
      runOpts({
        requestedModel: TEXT_200K.id,
        mode: "ask",
        cwd: ws,
        workspaceRoot: ws,
        approve: async () => {
          asked++;
          return "deny";
        },
        permissionRules: { allow: parseRules(["Write(f.txt)"]), ask: [], deny: [] },
      }),
    );
    expect(asked).toBe(0);
    expect(readFileSync(join(ws, "f.txt"), "utf8")).toBe("ok");
  });
});
