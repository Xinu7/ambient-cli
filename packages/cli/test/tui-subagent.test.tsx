import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Subagent } from "../src/tui/components/Subagent.js";
import type { SubagentChild, TranscriptItem } from "../src/tui/state.js";

type SubagentItem = Extract<TranscriptItem, { kind: "subagent" }>;

function child(i: number, over: Partial<SubagentChild> = {}): SubagentChild {
  return {
    childSessionId: `c${i}`,
    label: `scout-${i}`,
    role: "scout",
    model: "glm-5.2",
    status: "running",
    activity: { verb: "Reading", detail: `src/file-${i}.ts` },
    tools: [],
    ...over,
  };
}

function wave(n: number): SubagentItem {
  return {
    kind: "subagent",
    id: "w1",
    children: Array.from({ length: n }, (_, i) => child(i + 1)),
    status: "running",
    collapsed: false,
    spin: 0,
  };
}

describe("Subagent tree is bounded to a rows budget (a big wave can't become a tall frame)", () => {
  it("windows a large wave to maxRows and shows a '… +K more agents' marker", () => {
    const { lastFrame, unmount } = render(<Subagent item={wave(12)} width={80} maxRows={6} />);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    // header (1) + a handful of children + the "more" marker — never the full 12.
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(frame).toContain("more agents");
    expect(frame).toContain("subagent"); // the header survives
    expect(frame).toContain("scout-1"); // the first children are the ones kept
    expect(frame).not.toContain("scout-12"); // the tail is windowed away
    unmount();
  });

  it("renders every child when the budget is ample (no marker)", () => {
    const { lastFrame, unmount } = render(<Subagent item={wave(4)} width={80} maxRows={40} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("more agents");
    expect(frame).toContain("scout-1");
    expect(frame).toContain("scout-4");
    unmount();
  });

  it("defaults to unbounded when no budget is passed (back-compat)", () => {
    const { lastFrame, unmount } = render(<Subagent item={wave(10)} width={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("more agents");
    expect(frame).toContain("scout-10");
    unmount();
  });
});
