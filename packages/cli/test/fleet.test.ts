import { declaredRecord, laneFor, resolveRecord } from "@amb/capabilities";
import type { CatalogModel, Lane } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { formatFleetRows, renderFleet } from "../src/render/fleet.js";

const m = (id: string, isReady?: boolean, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  inputModalities: [],
  outputModalities: [],
  supportedFeatures: [],
  supportedSamplingParameters: [],
  isReady,
  ...extra,
});

// A declared-evidence lane resolver (no store) for deterministic tests.
const declaredLane = (model: CatalogModel): Lane =>
  laneFor(model, resolveRecord(model, undefined, Date.now()));

describe("formatFleetRows", () => {
  it("sorts ready → unknown → cold, then by id, and labels the evidence-based lane", () => {
    const rows = formatFleetRows(
      [
        m("b/cold", false),
        m("a/ready", true, {
          contextLength: 262144,
          supportedFeatures: ["tools"],
          inputModalities: ["text"],
        }),
        m("c/unknown", undefined),
      ],
      declaredLane,
    );
    expect(rows.map((r) => r.avail)).toEqual(["ready", "unknown", "cold"]);
    expect(rows[0]?.id).toBe("a/ready");
    expect(rows[0]?.ctx).toBe("262k");
    expect(rows[0]?.lane).toBe("direct"); // declared tools → direct
    expect(rows[0]?.vision).toBe("vision:no");
  });
});

describe("renderFleet", () => {
  it("renders a header + rows with no ANSI when color is off", () => {
    const out = renderFleet([m("a/ready", true, { supportedFeatures: ["tools"] })], {
      color: false,
      resolveLane: declaredLane,
    });
    expect(out[0]).toContain("AMBIENT FLEET");
    expect(
      out.some((l) => l.includes("●READY") && l.includes("a/ready") && l.includes("tools:direct")),
    ).toBe(true);
    expect(out.every((l) => !l.includes("\x1b["))).toBe(true);
  });
  it("emits ANSI when color is on", () => {
    const out = renderFleet([m("a/ready", true)], { color: true, resolveLane: declaredLane });
    expect(out.some((l) => l.includes("\x1b["))).toBe(true);
  });
});
