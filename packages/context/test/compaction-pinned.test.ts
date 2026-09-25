import { describe, expect, it } from "vitest";
import { planCompaction } from "../src/index.js";

const big = (role: string, tag: string, extra: Record<string, unknown> = {}) => ({
  role,
  content: `${tag} ${"x".repeat(4000)}`,
  ...extra,
});

describe("planCompaction with a pinned task message", () => {
  it("never summarizes the pinned CURRENT task, even when older messages precede it", () => {
    const msgs = [
      { role: "system", content: "sys" },
      big("user", "OLD-TASK"),
      big("assistant", "old answer"),
      big("user", "CURRENT-TASK", { pinned: true }),
      big("assistant", "step 1"),
      big("assistant", "step 2"),
      big("assistant", "step 3"),
    ];
    const plan = planCompaction(msgs, { anchorCount: 1, keepRecentTokens: 1500, reserveTokens: 0 });
    const summarized = plan.toSummarize.map((m) => String(m.content).slice(0, 12));
    expect(summarized).toContain("OLD-TASK xxx");
    expect(summarized.some((s) => s.startsWith("CURRENT-TASK"))).toBe(false);
    expect(plan.anchor.map((m) => String(m.content).slice(0, 12))).toEqual(["sys", "CURRENT-TASK"]);
    expect(plan.kept[0]).toBe(msgs[0]);
    expect(plan.kept[1]).toBe(msgs[3]);
  });
});
