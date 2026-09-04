import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import type { ChatClient, ChatParams, TurnCompletion } from "../src/ports.js";
import { injectDescription, relayImageToText, toVisionContent } from "../src/vision-relay.js";

function m(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 128_000,
    isReady: true,
    ...over,
  };
}
const vision = (id: string, over: Partial<CatalogModel> = {}) =>
  m(id, { inputModalities: ["text", "image"], ...over });

function client(chat: (p: ChatParams) => Promise<TurnCompletion>): ChatClient {
  return { fetchCatalog: async () => [], chat } as unknown as ChatClient;
}
const URIS = ["data:image/png;base64,AAAA"];
const sig = new AbortController().signal;

describe("vision relay (slice 6)", () => {
  it("describes via a ready vision model and injects the labelled description", async () => {
    let sawModel = "";
    const c = client(async (p) => {
      sawModel = p.model;
      return { content: "A terminal window showing an ENOENT error.", toolCalls: [] };
    });
    const res = await relayImageToText({
      client: c,
      catalog: [m("kimi/code"), vision("google/gemma-vl")],
      imageDataUris: URIS,
      userText: "what's wrong?",
      signal: sig,
    });
    expect(res.outcome).toBe("described");
    expect(sawModel).toBe("google/gemma-vl");
    const injected = injectDescription("what's wrong?", res);
    expect(injected).toContain("ENOENT");
    expect(injected).toContain("google/gemma-vl"); // attributed
  });

  it("no vision model → 'no-model' + honest degrade note (no fabrication)", async () => {
    const res = await relayImageToText({
      client: client(async () => ({ content: "x", toolCalls: [] })),
      catalog: [m("kimi/code"), m("vendor/other")],
      imageDataUris: URIS,
      userText: "look",
      signal: sig,
    });
    expect(res.outcome).toBe("no-model");
    expect(injectDescription("look", res).toLowerCase()).toContain("can't see images");
  });

  it("only a COLD vision model → 'cold' (never fires a cold model)", async () => {
    let called = false;
    const res = await relayImageToText({
      client: client(async () => {
        called = true;
        return { content: "x", toolCalls: [] };
      }),
      catalog: [m("kimi/code"), vision("google/gemma-vl", { isReady: false })],
      imageDataUris: URIS,
      userText: "look",
      signal: sig,
    });
    expect(res.outcome).toBe("cold");
    expect(called).toBe(false); // did NOT fire the cold model
  });

  it("empty description → fails over to a warm peer, then degrades", async () => {
    const res = await relayImageToText({
      client: client(async () => ({ content: "   ", toolCalls: [] })), // always empty
      catalog: [vision("a/vl"), vision("b/vl")],
      imageDataUris: URIS,
      userText: "look",
      signal: sig,
    });
    expect(res.outcome).toBe("failed");
  });

  it("toVisionContent carries the images as image_url parts", () => {
    const parts = toVisionContent("hi", URIS) as { type: string }[];
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
    expect(parts[0]?.type).toBe("text");
  });
});
