import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { pickForRole } from "../src/pick-best.js";

function m(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 200_000,
    isReady: true,
    ...over,
  };
}

// A representative live fleet: a coding flagship, a reasoning flagship, and a cheap flash model.
const fleet: CatalogModel[] = [
  m("moonshotai/kimi-k2.7-code"), // coding-specialized
  m("z-ai/glm-5.2-large", { supportedFeatures: ["tools", "reasoning"] }), // reasoning flagship
  m("openai/gpt-oss-flash", { supportedFeatures: ["tools"] }), // cheap/fast
];

describe("pickForRole", () => {
  it("executor keeps the current default (coding model)", () => {
    expect(pickForRole("executor", fleet)).toBe("moonshotai/kimi-k2.7-code");
  });

  it("planner and reviewer prefer the reasoning flagship over the code tier", () => {
    expect(pickForRole("planner", fleet)).toBe("z-ai/glm-5.2-large");
    expect(pickForRole("reviewer", fleet)).toBe("z-ai/glm-5.2-large");
  });

  it("compactor prefers the cheap/fast model (don't burn the flagship on summarization)", () => {
    expect(pickForRole("compactor", fleet)).toBe("openai/gpt-oss-flash");
  });

  it("compactor ranks by PRICING when the catalog has it (a cheap generic beats an expensive `flash`)", () => {
    const priced = [
      m("vendor/expensive-flash", { pricing: { input: 5, output: 15 } }), // named flash but pricey
      m("vendor/cheap-generic", { pricing: { input: 0.1, output: 0.2 } }), // genuinely cheap
    ];
    expect(pickForRole("compactor", priced)).toBe("vendor/cheap-generic");
  });

  it("reviewer avoids the executor's model when a comparable warm peer exists (second opinion)", () => {
    // Two reasoning flagships: reviewer should NOT return the one we're avoiding.
    const two = [
      m("a/reasoner-large", { supportedFeatures: ["tools", "reasoning"] }),
      m("b/reasoner-max", { supportedFeatures: ["tools", "reasoning"] }),
    ];
    const first = pickForRole("reviewer", two);
    const second = pickForRole("reviewer", two, { avoid: first });
    expect(second).not.toBe(first);
  });

  it("falls back rather than returning undefined when only one model exists", () => {
    const one = [m("solo/only", { supportedFeatures: ["tools", "reasoning"] })];
    expect(pickForRole("reviewer", one, { avoid: "solo/only" })).toBe("solo/only");
  });

  it("returns undefined for an empty fleet; still resolves when all are cold", () => {
    expect(pickForRole("executor", [])).toBeUndefined();
    const cold = fleet.map((x) => ({ ...x, isReady: false }));
    expect(pickForRole("executor", cold)).toBeDefined();
  });

  it("compactor does not require tool support (a text-only model can summarize)", () => {
    const noTools = [
      m("cheap/flash-text", { supportedFeatures: [] }),
      m("coder/kimi-code", { supportedFeatures: ["tools"] }),
    ];
    expect(pickForRole("compactor", noTools)).toBe("cheap/flash-text");
  });
});
