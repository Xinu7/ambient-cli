import type { ChatClient } from "@amb/runtime";
import type { SessionWriter } from "@amb/sessions";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import type { FleetRow } from "../src/render/fleet.js";
import { App } from "../src/tui/App.js";

const stubClient = {
  fetchCatalog: async () => [],
  chat: async () => ({ content: "hi", toolCalls: [] }),
} as unknown as ChatClient;
const stubWriter = () => ({ append() {} }) as unknown as SessionWriter;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fleet: FleetRow[] = [
  {
    avail: "ready",
    id: "moonshotai/kimi-k2.7-code",
    ctx: "262k",
    lane: "direct",
    vision: "vision:no",
    price: "",
  },
  {
    avail: "cold",
    id: "qwen/qwen3.6-27b",
    ctx: "33k",
    lane: "assisted",
    vision: "vision:no",
    price: "",
  },
  {
    avail: "ready",
    id: "z-ai/glm-5.2",
    ctx: "203k",
    lane: "direct",
    vision: "vision:no",
    price: "",
  },
];

it("the /model picker lists only LIVE models — cold ones are hidden", async () => {
  const { lastFrame, stdin, unmount } = render(
    <App
      client={stubClient}
      makeWriter={stubWriter}
      agentMode="build"
      permission="ask"
      effort="auto"
      requestedModel="auto"
      maxTurns={30}
      cwd="/w"
      workspaceRoot="/w"
      fleet={fleet}
    />,
  );
  await settle(40);
  for (const ch of "/model") stdin.write(ch);
  await settle(40);
  stdin.write("\r"); // run the highlighted /model command → opens the picker
  await settle(60);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Pick a model"); // the picker is open
  expect(frame).toContain("kimi-k2.7-code"); // ready → shown
  expect(frame).toContain("glm-5.2"); // ready → shown
  expect(frame).not.toContain("qwen3.6-27b"); // cold → hidden
  expect(frame).not.toContain("cold"); // no cold marker at all
  unmount();
});
