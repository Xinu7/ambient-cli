import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { pickVisionModel } from "../src/pick-best.js";

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

describe("pickVisionModel (slice 5)", () => {
  it("prefers a READY vision model and excludes non-image models", () => {
    const fleet = [
      m("vendor/coder"), // no image → not eligible
      m("google/gemma-vl", { inputModalities: ["text", "image"], isReady: true }),
      m("qwen/qwen-vl-small", {
        inputModalities: ["text", "image"],
        isReady: true,
        id: "qwen/qwen-vl-small",
      }),
    ];
    const pick = pickVisionModel(fleet);
    expect(pick?.ready).toBe(true);
    expect(["google/gemma-vl", "qwen/qwen-vl-small"]).toContain(pick?.id);
  });

  it("returns ready:false when only COLD vision models exist (caller must not fire a cold model)", () => {
    const fleet = [
      m("vendor/coder"),
      m("google/gemma-vl", { inputModalities: ["text", "image"], isReady: false }),
    ];
    const pick = pickVisionModel(fleet);
    expect(pick?.id).toBe("google/gemma-vl");
    expect(pick?.ready).toBe(false);
  });

  it("returns undefined when NO vision model exists at all", () => {
    expect(pickVisionModel([m("vendor/coder"), m("vendor/other")])).toBeUndefined();
  });

  it("honors the exclude set (failover to a different vision peer)", () => {
    const fleet = [
      m("a/vl", { inputModalities: ["text", "image"] }),
      m("b/vl", { inputModalities: ["text", "image"] }),
    ];
    const pick = pickVisionModel(fleet, { exclude: new Set(["a/vl"]) });
    expect(pick?.id).toBe("b/vl");
  });
});
