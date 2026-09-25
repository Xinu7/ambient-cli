import { AmbError, type CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../src/tui/App.js";
import type { AccountPort } from "../src/tui/use-key-prompt.js";

const model: CatalogModel = {
  id: "vendor/m",
  name: "m",
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedFeatures: ["tools"],
  supportedSamplingParameters: [],
  contextLength: 128_000,
  maxOutputLength: 8192,
  isReady: true,
};
const stubWriter = () =>
  ({ append() {}, close() {}, path: "/dev/null" }) as unknown as SessionWriter;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(opts: { keyWorks: () => boolean; verify: AccountPort["verify"] }) {
  const prompts: string[] = [];
  const client = {
    fetchCatalog: async () => [model],
    chat: async (p: ChatParams) => {
      const last = p.messages.at(-1);
      prompts.push(typeof last?.content === "string" ? last.content : "");
      if (!opts.keyWorks())
        throw new AmbError({
          kind: "auth",
          message: "Ambient authentication failed",
          retryable: false,
        });
      return { content: "DONE-AFTER-NEW-KEY", toolCalls: [] };
    },
  } as unknown as ChatClient;
  const saved: string[] = [];
  const account: AccountPort = {
    keysUrl: "https://app.ambient.xyz/keys",
    verify: opts.verify,
    save: (k) => saved.push(k),
    remove: () => {},
    openKeysPage: () => true,
    mask: (k) => `…${k.slice(-4)}`,
  };
  const ui = render(
    <App
      client={client}
      makeWriter={stubWriter}
      agentMode="build"
      permission="bypass"
      effort="auto"
      requestedModel="vendor/m"
      maxTurns={4}
      cwd="/nonexistent-ws"
      workspaceRoot="/nonexistent-ws"
      account={account}
    />,
  );
  return { ui, saved, prompts };
}

describe("a key rejected mid-session", () => {
  it("opens the key panel, saves a verified new key, and re-runs the task", async () => {
    let good = false;
    const { ui, saved, prompts } = harness({
      keyWorks: () => good,
      verify: async (k) => (k === "sk-new-key-0001" ? "valid" : "invalid"),
    });
    await settle(30);
    for (const ch of "write the readme") ui.stdin.write(ch);
    ui.stdin.write("\r");
    await settle(250);
    expect(ui.lastFrame()).toContain("Ambient rejected your API key");

    // A wrong key is rejected in place; nothing is saved.
    ui.stdin.write("sk-wrong-key-9999");
    ui.stdin.write("\r");
    await settle(60);
    expect(ui.lastFrame()).toContain("Ambient rejected that key");
    expect(saved).toEqual([]);

    good = true; // the new key works on the server
    ui.stdin.write("sk-new-key-0001");
    ui.stdin.write("\r");
    await settle(300);
    expect(saved).toEqual(["sk-new-key-0001"]);
    const frame = ui.lastFrame() ?? "";
    expect(frame).not.toContain("sk-new-key-0001"); // never echoed
    expect(frame).toContain("Signed in with key …0001");
    expect(prompts.filter((p) => p.includes("write the readme")).length).toBeGreaterThanOrEqual(2);
    ui.unmount();
  });

  it("/login opens the panel on demand and Esc keeps the current key", async () => {
    const { ui, saved } = harness({ keyWorks: () => true, verify: async () => "valid" });
    await settle(30);
    for (const ch of "/login") ui.stdin.write(ch);
    await settle(30);
    ui.stdin.write("\r");
    await settle(60);
    expect(ui.lastFrame()).toContain("Change your Ambient API key");
    ui.stdin.write("\x1b");
    await settle(60);
    expect(ui.lastFrame()).toContain("Key unchanged");
    expect(saved).toEqual([]);
    ui.unmount();
  });

  it("a saved key that fails the launch check opens the panel before the user types", async () => {
    const client = {
      fetchCatalog: async () => [model],
      chat: async () => ({ content: "x", toolCalls: [] }),
    };
    const ui = render(
      <App
        client={client as unknown as ChatClient}
        makeWriter={stubWriter}
        agentMode="build"
        permission="ask"
        effort="auto"
        requestedModel="auto"
        maxTurns={4}
        cwd="/w"
        workspaceRoot="/w"
        account={{
          keysUrl: "https://app.ambient.xyz/keys",
          verify: async () => "valid",
          save: () => {},
          remove: () => {},
          openKeysPage: () => true,
          mask: (k) => k,
          startupCheck: Promise.resolve("invalid"),
        }}
      />,
    );
    await settle(60);
    expect(ui.lastFrame()).toContain("Your saved Ambient key doesn't work");
    ui.unmount();
  });
});
