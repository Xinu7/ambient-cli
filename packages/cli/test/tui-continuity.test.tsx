import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams } from "@amb/runtime";
import { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/tui/App.js";

const catalog: CatalogModel[] = [
  {
    id: "vendor/m",
    name: "m",
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 262_144,
    maxOutputLength: 262_144,
    isReady: true,
  },
];

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(lastFrame: () => string | undefined, needle: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    const f = lastFrame() ?? "";
    if (f.includes(needle)) return f;
    await settle(20);
  }
  return lastFrame() ?? "";
}

/** The system message a run sent (first message, role "system") — where resumeContext is injected. */
function systemText(params: ChatParams): string {
  const sys = params.messages.find((m) => m.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "amb-continuity-"));
  process.env.AMB_HOME = home;
});
afterEach(() => {
  process.env.AMB_HOME = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("TUI session continuity (one session per launch, prior turns remembered)", () => {
  it("threads turn 1 into turn 2's context and writes ONE session log", async () => {
    const systems: string[] = [];
    let turn = 0;
    const chat: ChatClient["chat"] = async (params) => {
      systems.push(systemText(params));
      turn += 1;
      return { content: `ANSWER-${turn}`, toolCalls: [] };
    };
    const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;

    const { lastFrame, stdin, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass" // no approval overlay — a clean two-turn run
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={30}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );

    await settle(40);
    for (const ch of "remember the widget count is 42") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "ANSWER-1");

    for (const ch of "what did I say") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "ANSWER-2");

    // Turn 1 has NO prior context; turn 2's system prompt must carry turn 1's user input (continuity).
    expect(systems.length).toBe(2);
    expect(systems[0]).not.toContain("widget count is 42");
    expect(systems[1]).toContain("remember the widget count is 42");

    // Exactly ONE durable session log for the whole launch (not one file per submit).
    const files = readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);

    unmount();
  });

  it("/clear starts a fresh session — new log, no memory of the cleared conversation", async () => {
    const systems: string[] = [];
    let turn = 0;
    const chat: ChatClient["chat"] = async (params) => {
      systems.push(systemText(params));
      turn += 1;
      return { content: `ANSWER-${turn}`, toolCalls: [] };
    };
    const client = { fetchCatalog: async () => catalog, chat } as unknown as ChatClient;

    const { lastFrame, stdin, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/m"
        maxTurns={30}
        cwd="/w"
        workspaceRoot="/w"
      />,
    );

    await settle(40);
    for (const ch of "the secret code is banana") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "ANSWER-1");

    // /clear → fresh conversation.
    for (const ch of "/clear") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await settle(40);

    for (const ch of "what is the code") stdin.write(ch);
    await settle(30);
    stdin.write("\r");
    await waitFor(lastFrame, "ANSWER-2");

    // The post-clear turn must NOT carry the pre-clear conversation, and it lives in a NEW session file.
    expect(systems[1]).not.toContain("banana");
    const files = readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(2);

    unmount();
  });
});
