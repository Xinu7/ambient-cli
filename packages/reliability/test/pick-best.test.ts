import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { pickBestModel } from "../src/pick-best.js";

function m(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedFeatures: ["tools", "reasoning"],
    supportedSamplingParameters: [],
    contextLength: 128_000,
    isReady: true,
    ...over,
  };
}

// A realistic slice of the live fleet (shapes as of 2026-09) — the heuristic must adapt to ANY catalog.
const FLEET: CatalogModel[] = [
  m("z-ai/glm-5.2", { contextLength: 202_752, isReady: true }),
  m("google/gemma-4-26b-a4b-it", { contextLength: 262_144, isReady: false }),
  m("moonshotai/kimi-k2.7-code", { contextLength: 262_144, isReady: true }),
  m("deepseek/deepseek-v4-flash-0731", { contextLength: 1_048_576, isReady: true }),
  m("ambient/large", { contextLength: 202_752, isReady: true }),
  m("ambient/small", { contextLength: 262_144, isReady: false }),
];

describe("pickBestModel", () => {
  it("returns undefined for an empty catalog (never throws)", () => {
    expect(pickBestModel([])).toBeUndefined();
  });

  it("prefers the coding-specialized model over a bigger-context FLASH model", () => {
    // deepseek-flash has 4x the context but is a speed tier; kimi-*-code is coding-specialized → best default.
    expect(pickBestModel(FLEET)).toBe("moonshotai/kimi-k2.7-code");
  });

  it("self-heals: when the coding model is gone, falls back to the flagship tier, not the flash model", () => {
    const gone = FLEET.filter((x) => x.id !== "moonshotai/kimi-k2.7-code");
    expect(pickBestModel(gone)).toBe("ambient/large"); // 'large' flagship beats glm and the flash model
  });

  it("only ever returns a READY model when any ready model exists", () => {
    // Make the two strong models cold; the best READY (glm) must win over cold kimi/ambient-large.
    const cat = FLEET.map((x) =>
      x.id === "moonshotai/kimi-k2.7-code" || x.id === "ambient/large"
        ? { ...x, isReady: false }
        : x,
    );
    const pick = pickBestModel(cat);
    expect(cat.find((x) => x.id === pick)?.isReady).toBe(true);
    expect(pick).toBe("z-ai/glm-5.2"); // best ready after the two strong ones went cold (flash still down-ranked)
  });

  it("falls back to a COLD model when nothing is ready (cold-start still resolves)", () => {
    const allCold = FLEET.map((x) => ({ ...x, isReady: false }));
    expect(pickBestModel(allCold)).toBe("moonshotai/kimi-k2.7-code"); // best by tier, even though cold
  });

  it("prefers a tool-capable model (a coding agent needs native tool-calls)", () => {
    const cat = [
      m("vendor/no-tools-huge", { contextLength: 2_000_000, supportedFeatures: ["reasoning"] }),
      m("vendor/tools-small", { contextLength: 32_768, supportedFeatures: ["tools", "reasoning"] }),
    ];
    expect(pickBestModel(cat)).toBe("vendor/tools-small");
  });

  it("scores the model NAME, not the vendor (a 'smallco/' or 'code-labs/' vendor isn't mis-ranked)", () => {
    // If the vendor were scored, 'bigvendor-small/pro' would be down-ranked and 'code-labs/plain' up-ranked.
    const small = m("smallco/pro-262k", { contextLength: 262_144 }); // vendor has "small", model does not
    const plain = m("code-labs/plain-262k", { contextLength: 262_144 }); // vendor has "code", model does not
    // Neither has a tier word in its MODEL name → they tie on features+ctx → deterministic id order.
    expect(pickBestModel([small, plain])).toBe(pickBestModel([plain, small]));
    // A model whose NAME says small IS down-ranked, even against a vendor that merely looks big.
    const named = m("x/mini-fast", { contextLength: 262_144 });
    const big = m("mini-corp/pro", { contextLength: 262_144 }); // vendor "mini", model "pro"
    expect(pickBestModel([named, big])).toBe("mini-corp/pro");
  });

  it("is deterministic on a tie (stable id order)", () => {
    const a = m("vendor/alpha", { supportedFeatures: ["tools"] });
    const b = m("vendor/beta", { supportedFeatures: ["tools"] });
    expect(pickBestModel([a, b])).toBe(pickBestModel([b, a]));
  });
});
