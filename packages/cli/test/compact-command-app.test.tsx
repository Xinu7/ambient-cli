import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams, TurnCompletion } from "@amb/runtime";
import { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/tui/App.js";

const catalog: CatalogModel[] = [
  {
    id: "vendor/small",
    name: "small",
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 32_768,
    maxOutputLength: 4_096,
    isReady: true,
  },
];
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(lastFrame: () => string | undefined, needle: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const f = lastFrame() ?? "";
    if (f.includes(needle)) return f;
    await settle(20);
  }
  return lastFrame() ?? "";
}

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "amb-compact-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("/compact, /context and /usage in the app", () => {
  it("summarizes the conversation on request and reports tokens, never money", async () => {
    const calls: ChatParams[] = [];
    const client = {
      fetchCatalog: async () => catalog,
      chat: async (p: ChatParams): Promise<TurnCompletion> => {
        calls.push(p);
        const isSummary = p.messages.some(
          (m) =>
            typeof m.content === "string" && m.content.startsWith("Summarize the conversation"),
        );
        if (isSummary) return { content: "## Goal\nexplain\n## Progress\ndone", toolCalls: [] };
        return {
          content: `ANSWER ${calls.length} ${"long explanation ".repeat(1_200)}`,
          toolCalls: [],
          usage: { promptTokens: 9_000, completionTokens: 5_000, cachedTokens: 8_000 },
        } as TurnCompletion;
      },
    } as unknown as ChatClient;
    const { stdin, lastFrame, unmount } = render(
      <App
        client={client}
        makeWriter={(id: string) => new SessionWriter(id, () => new Date().toISOString())}
        agentMode="build"
        permission="bypass"
        effort="auto"
        requestedModel="vendor/small"
        maxTurns={5}
        cwd={ws}
        workspaceRoot={ws}
      />,
    );
    const send = async (text: string, until: string) => {
      for (const ch of text) stdin.write(ch);
      await settle(30);
      stdin.write("\r");
      await waitFor(lastFrame, until);
      await settle(60);
    };
    await settle(40);
    await send("explain the parser", "ANSWER 1");
    await send("and the lexer", "ANSWER 2");
    const before = calls.length;
    await send("/compact the lexer", "compacted the conversation");
    expect(lastFrame()).toContain("compacted the conversation");
    expect(calls.length).toBe(before + 1);
    const instruction = String(calls.at(-1)?.messages[0]?.content);
    expect(instruction).toContain("focus on: the lexer");

    await send("/usage", "Usage");
    expect(lastFrame()).toMatch(/Usage · this session · \d+ requests?/);
    expect(lastFrame()).not.toMatch(/\$/);
    await send("/context", "Context");
    expect(lastFrame()).toContain("32.8k window");
    // One receipt for the compaction, not two.
    expect(lastFrame()).not.toContain("compacted context (");
    unmount();
  });
});
