import { describe, expect, it } from "vitest";
import { classifyHttpError } from "../src/index.js";

describe("classifyHttpError", () => {
  it("401/403 => auth (not retryable)", () => {
    expect(classifyHttpError(401, "unauthorized").kind).toBe("auth");
    expect(classifyHttpError(403, "forbidden").retryable).toBe(false);
  });
  it("429 splits cold (fail over) vs rate_limit (retry)", () => {
    const cold = classifyHttpError(429, "No workers are currently available");
    expect(cold.kind).toBe("cold");
    expect(cold.retryable).toBe(false);
    const rl = classifyHttpError(429, "rate limit exceeded");
    expect(rl.kind).toBe("rate_limit");
    expect(rl.retryable).toBe(true);
  });
  it("400 distinguishes overflow from param errors", () => {
    expect(classifyHttpError(400, "prompt is too long: 5 tokens > 4 maximum").kind).toBe(
      "overflow",
    );
    expect(classifyHttpError(400, "unsupported parameter: temperature").kind).toBe("bad_request");
  });
  it("5xx => transport (retryable)", () => {
    expect(classifyHttpError(503, "bad gateway").retryable).toBe(true);
  });
  it("404 => a RETRYABLE transport error so the run fails over to a warm model (not a hard die)", () => {
    const e = classifyHttpError(404, "model not found", { model: "z-ai/glm-5.2" });
    expect(e.kind).toBe("transport");
    expect(e.retryable).toBe(true); // → the failover engine substitutes instead of dying with "404"
    expect(e.message).toContain("glm-5.2");
  });
});
