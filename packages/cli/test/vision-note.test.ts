import { describe, expect, it } from "vitest";
import type { FleetRow } from "../src/render/fleet.js";
import { visionNote } from "../src/tui/vision-note.js";

const row = (id: string, vision: boolean, avail: FleetRow["avail"] = "ready"): FleetRow => ({
  id,
  avail,
  ctx: "",
  lane: "direct",
  vision: vision ? "vision:yes" : "vision:no",
  price: "",
});

describe("visionNote (attach-time heads-up)", () => {
  const fleet = [
    row("z-ai/glm-5.2", false),
    row("qwen/qwen3.6-27b", true, "cold"),
    row("qwen/qwen3.8-27b", true),
  ];
  it("names the vision model that will describe the image for a model that can't see", () => {
    expect(visionNote("z-ai/glm-5.2", fleet)).toBe(
      "glm-5.2 can't see images — qwen3.8-27b will describe it",
    );
  });
  it("says nothing when the chosen model can see images", () => {
    expect(visionNote("qwen/qwen3.8-27b", fleet)).toBeUndefined();
  });
  it("is honest when no vision model exists", () => {
    expect(visionNote("z-ai/glm-5.2", [row("z-ai/glm-5.2", false)])).toMatch(
      /no vision model is available/,
    );
  });
  it("hedges for auto (the served model isn't known yet)", () => {
    expect(visionNote("auto", fleet)).toBe(
      "if the model can't see images, qwen3.8-27b will describe it",
    );
  });
});
