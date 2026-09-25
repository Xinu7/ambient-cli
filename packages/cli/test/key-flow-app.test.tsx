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

function harness(opts: {
  keyWorks: () => boolean;
  verify: AccountPort["verify"];
  startupCheck?: AccountPort["startupCheck"];
}) {
  const prompts: string[] = [];
  const requests: ChatParams[] = [];
  const client = {
    fetchCatalog: async () => [model],
    chat: async (p: ChatParams) => {
      requests.push({ ...p, messages: [...p.messages] });
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
    remove: () => "Signed out on this machine.",
    openKeysPage: () => true,
    mask: (k) => `…${k.slice(-4)}`,
    ...(opts.startupCheck ? { startupCheck: opts.startupCheck } : {}),
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
  return { ui, saved, prompts, requests };
}

describe("a key rejected mid-session", () => {
  it("opens the key panel, saves a verified new key, and re-runs the task", async () => {
    let good = false;
    const { ui, saved, prompts, requests } = harness({
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
    // The retried request carries the task ONCE (the failed attempt isn't left in the conversation).
    const lastReq = requests.at(-1)?.messages ?? [];
    const copies = lastReq.filter(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("write the readme"),
    );
    expect(copies).toHaveLength(1);
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
          remove: () => "",
          openKeysPage: () => true,
          mask: (k) => k,
          startupCheck: Promise.resolve({ result: "invalid" as const }),
        }}
      />,
    );
    await settle(60);
    expect(ui.lastFrame()).toContain("Your saved Ambient key doesn't work");
    ui.unmount();
  });
});

describe("key panel races", () => {
  it("Esc while a key is being checked cancels it: nothing is saved and nothing re-runs", async () => {
    let finish: (r: "valid") => void = () => {};
    const { ui, saved, prompts } = harness({
      keyWorks: () => false,
      verify: () =>
        new Promise((r) => {
          finish = r;
        }),
    });
    await settle(30);
    for (const ch of "do it") ui.stdin.write(ch);
    ui.stdin.write("\r");
    await settle(250);
    ui.stdin.write("sk-late-key-7777");
    ui.stdin.write("\r");
    await settle(30);
    ui.stdin.write("\x1b"); // dismiss while the check is still in flight
    await settle(30);
    const before = prompts.length;
    finish("valid");
    await settle(100);
    expect(saved).toEqual([]);
    expect(prompts.length).toBe(before);
    expect(ui.lastFrame()).not.toContain("Signed in with key");
    ui.unmount();
  });

  it("a launch check that switched to another working key says so", async () => {
    const { ui } = harness({
      keyWorks: () => true,
      verify: async () => "valid",
      startupCheck: Promise.resolve({
        result: "valid" as const,
        note: "Your saved key was rejected, so ambient is using …2222",
      }),
    });
    await settle(80);
    expect(ui.lastFrame()).toContain("using …2222");
    expect(ui.lastFrame()).not.toContain("Change your Ambient API key");
    ui.unmount();
  });
});
