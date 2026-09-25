import { describe, expect, it } from "vitest";
import { parseToolArgs } from "../src/agent/ambient-client.js";

describe("parseToolArgs", () => {
  it("treats empty/whitespace arguments as an empty object (a zero-arg call is valid)", () => {
    expect(parseToolArgs("")).toEqual({});
    expect(parseToolArgs("  \n")).toEqual({});
  });
  it("parses JSON and returns undefined only for genuinely malformed input", () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArgs("{bad")).toBeUndefined();
  });
});
