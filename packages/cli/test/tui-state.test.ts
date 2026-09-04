import type { NewEvent } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import {
  MAX_GOAL_CHARS,
  type TranscriptItem,
  appendNotice,
  clearTranscript,
  initialState,
  nextPermission,
  optimisticEcho,
  reduce,
  setGoal,
  setRequestedModel,
  toRuntimeMode,
  toggleAgentMode,
  withStop,
} from "../src/tui/state.js";

const base = { schemaVersion: 1 as const, sessionId: "ses_a", turnId: "trn_a", attemptId: "att_a" };
const init = () =>
  initialState({
    agentMode: "build",
    permission: "ask",
    effort: "auto",
    requestedModel: "moonshotai/kimi-k2.7-code",
  });

describe("setGoal + goal persistence across a run", () => {
  it("sets a trimmed goal and clears on empty", () => {
    const withGoal = setGoal(init(), "  ship the export  ");
    expect(withGoal.goal).toBe("ship the export");
    expect(setGoal(withGoal, "   ").goal).toBeUndefined(); // empty → cleared
  });

  it("caps an over-long goal to MAX_GOAL_CHARS", () => {
    const long = "x".repeat(MAX_GOAL_CHARS + 50);
    expect(setGoal(init(), long).goal?.length).toBe(MAX_GOAL_CHARS);
  });

  it("PRESERVES the goal across session.started (unlike the plan, which resets)", () => {
    const s = reduce(setGoal(init(), "the north star"), {
      kind: "session.started",
      ...base,
      cwd: "/w",
      workspaceRoot: "/w",
    } as NewEvent);
    expect(s.goal).toBe("the north star"); // north-star survives a new run
    expect(s.plan).toEqual([]); // plan is reset
  });
});

describe("tui reducer — handoff", () => {
  const resolved = (id: string) =>
    ({
      kind: "model.resolved",
      ...base,
      requestedModel: id,
      targetModel: id,
      lane: "direct",
      rule: "exact-live",
    }) as NewEvent;
  it("a compactor (utility) handoff does NOT repoint the flightline; a failover handoff DOES", () => {
    let s = reduce(init(), resolved("vendor/main"));
    s = reduce(s, {
      kind: "handoff",
      ...base,
      from: "vendor/main",
      to: "cheap/flash",
      role: "compactor",
    } as NewEvent);
    expect(s.status.targetModel).toBe("vendor/main"); // compaction is a side call, not a serving switch
    s = reduce(s, {
      kind: "handoff",
      ...base,
      from: "vendor/main",
      to: "other/model",
      role: "executor",
    } as NewEvent);
    expect(s.status.targetModel).toBe("other/model"); // a real failover repoints
  });
});

describe("tui reducer — model.resolved receipt", () => {
  const resolved = (requestedModel: string, targetModel: string) =>
    ({
      kind: "model.resolved",
      ...base,
      requestedModel,
      targetModel,
      lane: "direct",
      rule: requestedModel === "auto" ? "auto-best" : "ready-substitution",
      reason: requestedModel === "auto" ? "no model requested; picked the best" : "cold",
    }) as NewEvent;

  it("an `auto` pick emits NO receipt (it's the default, not a substitution — flightline shows ←auto)", () => {
    const s = reduce(init(), resolved("auto", "moonshotai/kimi-k2.7-code"));
    expect(s.transcript.filter((t) => t.kind === "receipt")).toHaveLength(0);
    expect(s.status.targetModel).toBe("moonshotai/kimi-k2.7-code"); // status still updates
  });

  it("an explicit cold model DOES emit a substitution receipt", () => {
    const s = reduce(init(), resolved("acme/legacy", "z-ai/glm-5.2"));
    const receipts = s.transcript.filter((t) => t.kind === "receipt");
    expect(receipts).toHaveLength(1);
    // the receipt uses the short (vendor-stripped) name
    expect((receipts[0] as { text: string }).text).toContain("you asked for legacy");
  });
});

describe("tui reducer — thinking", () => {
  it("accumulates reasoning.delta into a bounded transient buffer and shows it by default", () => {
    let s = init();
    expect(s.showThinking).toBe(true);
    s = reduce(s, { kind: "reasoning.delta", ...base, text: "Let me " } as NewEvent);
    s = reduce(s, { kind: "reasoning.delta", ...base, text: "think about it." } as NewEvent);
    expect(s.thinking).toBe("Let me think about it.");
  });
  it("clears the reasoning tail when the model starts ANSWERING (assistant.delta)", () => {
    let s = init();
    s = reduce(s, { kind: "reasoning.delta", ...base, text: "reasoning…" } as NewEvent);
    s = reduce(s, { kind: "assistant.delta", ...base, text: "Here is the answer." } as NewEvent);
    expect(s.thinking).toBe("");
  });
  it("clears the reasoning tail when the model starts ACTING (tool.started)", () => {
    let s = init();
    s = reduce(s, { kind: "reasoning.delta", ...base, text: "planning a read" } as NewEvent);
    s = reduce(s, {
      kind: "tool.started",
      ...base,
      toolCallId: "tc_1",
      toolName: "read",
    } as NewEvent);
    expect(s.thinking).toBe("");
  });
  it("bounds the buffer to a rolling tail (a verbose model can't grow it unbounded)", () => {
    let s = init();
    s = reduce(s, { kind: "reasoning.delta", ...base, text: "x".repeat(10_000) } as NewEvent);
    expect(s.thinking.length).toBeLessThanOrEqual(4000);
  });
});

describe("tui reducer", () => {
  it("turn.started marks running and pushes the user input", () => {
    const s = reduce(init(), {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "add a test",
    } as NewEvent);
    expect(s.status.running).toBe(true);
    expect(s.transcript).toEqual([{ kind: "user", id: expect.any(String), text: "add a test" }]);
  });

  it("optimistic echo shows the message + Thinking instantly; turn.started confirms it in place (no dup)", () => {
    // The instant the user submits: echo the message + go "Thinking" (before the run's catalog fetch).
    let s = optimisticEcho(init(), "add a test");
    expect(s.status.running).toBe(true);
    expect(s.status.activity).toEqual({ verb: "Thinking" });
    expect(s.transcript).toEqual([
      { kind: "user", id: expect.any(String), text: "add a test", optimistic: true },
    ]);

    // session.started (run begins) must NOT clear the activity — else "Thinking" flickers off during the fetch.
    s = reduce(s, { kind: "session.started", schemaVersion: 1, sessionId: "ses_a" } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Thinking" });
    expect(s.transcript).toHaveLength(1); // the echo survives the session reset

    // turn.started confirms the SAME item (drops `optimistic`) rather than pushing a duplicate.
    s = reduce(s, {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "add a test",
    } as NewEvent);
    expect(s.transcript).toEqual([{ kind: "user", id: expect.any(String), text: "add a test" }]);
  });

  it("turn.started with NO prior optimistic echo still pushes the user item (replay / non-TUI path)", () => {
    const s = reduce(init(), {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "ship it",
    } as NewEvent);
    expect(s.transcript).toEqual([{ kind: "user", id: expect.any(String), text: "ship it" }]);
  });

  it("assistant deltas coalesce into one streaming item, then final settles it", () => {
    let s = init();
    s = reduce(s, { kind: "assistant.delta", ...base, text: "Hel" } as NewEvent);
    s = reduce(s, { kind: "assistant.delta", ...base, text: "lo" } as NewEvent);
    expect(s.transcript).toHaveLength(1);
    const streaming = s.transcript[0];
    expect(streaming).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
    s = reduce(s, { kind: "assistant.final", ...base, text: "" } as NewEvent);
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]).toMatchObject({ kind: "assistant", text: "Hello", streaming: false });
  });

  it("verify.gate pushes a notice (warn on failure w/ summary, info on pass)", () => {
    let s = init();
    s = reduce(s, {
      kind: "verify.gate",
      ...base,
      ok: false,
      attempt: 0,
      summary: "2 tests failing",
    } as NewEvent);
    const fail = s.transcript.at(-1);
    expect(fail).toMatchObject({ kind: "notice", level: "warn" });
    expect((fail as { text: string }).text).toContain("verification failed");
    expect((fail as { text: string }).text).toContain("2 tests failing");
    s = reduce(s, { kind: "verify.gate", ...base, ok: true, attempt: 1 } as NewEvent);
    expect(s.transcript.at(-1)).toMatchObject({ kind: "notice", level: "info" });
  });

  it("subagent lifecycle: started creates a group, tool events fill it, finished collapses w/ summary", () => {
    let s = init();
    const sb = { ...base, toolCallId: "tc_p", childSessionId: "ses_c1" };
    s = reduce(s, {
      kind: "subagent.started",
      ...sb,
      role: "scout",
      label: "find-auth",
      model: "z-ai/glm-5.2",
      readOnly: true,
      prompt: "find auth",
    } as NewEvent);
    let item = s.transcript.find((t) => t.kind === "subagent") as {
      kind: "subagent";
      children: { label: string; model: string; tools: unknown[]; status: string }[];
      status: string;
      collapsed: boolean;
    };
    expect(item.children).toHaveLength(1);
    expect(item.children[0]).toMatchObject({
      label: "find-auth",
      model: "glm-5.2",
      status: "running",
    });

    s = reduce(s, {
      kind: "subagent.tool",
      ...sb,
      childToolCallId: "tc_c1",
      toolName: "grep",
      status: "running",
      preview: "/auth/",
    } as NewEvent);
    s = reduce(s, {
      kind: "subagent.tool",
      ...sb,
      childToolCallId: "tc_c1",
      toolName: "grep",
      status: "ok",
    } as NewEvent);
    item = s.transcript.find((t) => t.kind === "subagent") as typeof item;
    expect(item.children[0]?.tools).toHaveLength(1); // running row settled in place, not duplicated
    expect((item.children[0]?.tools[0] as { status: string }).status).toBe("ok");

    s = reduce(s, {
      kind: "subagent.finished",
      ...sb,
      stopReason: "complete",
      turns: 3,
      toolCount: 1,
      summary: "auth is in middleware/limit.ts",
      durationMs: 12000,
    } as NewEvent);
    item = s.transcript.find((t) => t.kind === "subagent") as typeof item;
    expect(item.status).toBe("ok");
    expect(item.collapsed).toBe(true);
    expect((item.children[0] as { summary?: string }).summary).toContain("middleware/limit.ts");
  });

  it("subagent event with an unknown parent id is a no-op (default passthrough intact)", () => {
    const s0 = init();
    const s1 = reduce(s0, {
      kind: "subagent.tool",
      ...base,
      toolCallId: "tc_missing",
      childSessionId: "ses_x",
      childToolCallId: "tc_y",
      toolName: "read",
      status: "running",
    } as NewEvent);
    expect(s1.transcript).toEqual(s0.transcript);
  });

  it("a whitespace-only delta does NOT open a spinning streaming item", () => {
    let s = init();
    s = reduce(s, { kind: "assistant.delta", ...base, text: "  \n " } as NewEvent);
    // no blank, forever-spinning assistant line was created
    expect(s.transcript.some((t) => t.kind === "assistant")).toBe(false);
    // once real content arrives, the item opens normally
    s = reduce(s, { kind: "assistant.delta", ...base, text: "hi" } as NewEvent);
    expect(s.transcript.some((t) => t.kind === "assistant" && t.streaming)).toBe(true);
  });

  it("tool.proposed carries no diff; the diff attaches from tool.result (its OUTPUT)", () => {
    let s = init();
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_1",
      wireId: "w1",
      toolName: "write",
      // the tool INPUT never contains a diff — the reducer must not read one here
      args: { path: "a.ts", content: "hi" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    expect(s.transcript[0]).toMatchObject({
      kind: "tool",
      name: "write",
      preview: "a.ts",
      status: "running",
    });
    expect((s.transcript[0] as Extract<TranscriptItem, { kind: "tool" }>).diff).toBeUndefined();
    // the unified diff rides on tool.result and is attached to the same row
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_1",
      ok: true,
      durationMs: 12,
      diff: "--- a.ts\n+++ a.ts\n+hi",
    } as NewEvent);
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]).toMatchObject({
      kind: "tool",
      status: "ok",
      durationMs: 12,
      diff: "--- a.ts\n+++ a.ts\n+hi",
    });
  });

  it("a non-diff tool (grep/bash) attaches its OUTPUT preview + exitCode so it isn't just '✓ 34ms'", () => {
    let s = init();
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_g",
      wireId: "w",
      toolName: "grep",
      args: { pattern: "TODO" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_g",
      ok: true,
      durationMs: 12,
      preview: "src/a.ts:12: // TODO fix\nsrc/b.ts:4: // TODO test",
      exitCode: 0,
    } as NewEvent);
    const tool = s.transcript.find((t) => t.kind === "tool") as Extract<
      TranscriptItem,
      { kind: "tool" }
    >;
    expect(tool.resultPreview).toContain("TODO fix");
    // a write/edit result (has a diff) must NOT also show the raw JSON output preview
    let s2 = init();
    s2 = reduce(s2, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_w",
      wireId: "w",
      toolName: "write",
      args: { path: "a.ts", content: "x" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    s2 = reduce(s2, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_w",
      ok: true,
      durationMs: 3,
      diff: "--- a.ts\n+++ a.ts\n+x",
      preview: '{"path":"a.ts","operation":"create"}',
    } as NewEvent);
    const wtool = s2.transcript.find((t) => t.kind === "tool") as Extract<
      TranscriptItem,
      { kind: "tool" }
    >;
    expect(wtool.diff).toContain("+x");
    expect(wtool.resultPreview).toBeUndefined();
  });

  it("a tool.result with no matching row (e.g. a folded plan call) is a no-op, not a crash", () => {
    const s0 = init();
    const s = reduce(s0, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_missing",
      ok: true,
      durationMs: 4,
    } as NewEvent);
    expect(s.transcript).toHaveLength(0); // no phantom row
    expect(s.plan).toEqual(s0.plan);
    expect(s.status.requestedModel).toBe(s0.status.requestedModel); // no phantom telemetry bumped
    // a folded/unknown result resets the activity to Thinking so a stale tool verb never sticks
    expect(s.status.activity).toEqual({ verb: "Thinking" });
  });

  it("model.resolved surfaces a substitution notice and records the served model", () => {
    const s = reduce(init(), {
      kind: "model.resolved",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      requestedModel: "z-ai/glm-5.2",
      targetModel: "moonshotai/kimi-k2.7-code",
      lane: "direct",
      rule: "warm-substitute",
      reason: "cold",
    } as NewEvent);
    expect(s.status.targetModel).toBe("moonshotai/kimi-k2.7-code");
    expect(s.status.lane).toBe("direct");
    // substitution surfaces a calm, honest RECEIPT (short model names, no em-dash)
    expect(
      s.transcript.some((t) => t.kind === "receipt" && t.text.includes("served by kimi-k2.7-code")),
    ).toBe(true);
  });

  it("no substitution notice when served === requested", () => {
    const s = reduce(init(), {
      kind: "model.resolved",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      requestedModel: "moonshotai/kimi-k2.7-code",
      targetModel: "moonshotai/kimi-k2.7-code",
      lane: "direct",
      rule: "exact",
    } as NewEvent);
    expect(s.transcript).toHaveLength(0);
  });

  it("a mid-run handoff updates the flightline's target + lane AND shows a row", () => {
    let s = reduce(init(), {
      kind: "model.resolved",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      requestedModel: "z-ai/glm-5.2",
      targetModel: "z-ai/glm-5.2",
      lane: "direct",
      rule: "exact",
    } as NewEvent);
    s = reduce(s, {
      kind: "handoff",
      ...base,
      from: "z-ai/glm-5.2",
      to: "moonshotai/kimi-k2.7-code",
      role: "executor",
      lane: "direct",
      reason: "glm-5.2 is cold; failing over to a warm model",
    } as NewEvent);
    // the served model + lane follow the failover even if the response omits reportedModel
    expect(s.status.targetModel).toBe("moonshotai/kimi-k2.7-code");
    expect(s.status.lane).toBe("direct");
    expect(
      s.transcript.some((t) => t.kind === "handoff" && t.to === "moonshotai/kimi-k2.7-code"),
    ).toBe(true);
  });

  it("a handoff CLEARS the prior model's reportedModel (flightline never names the failed model)", () => {
    let s = reduce(init(), {
      kind: "model.resolved",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      requestedModel: "z-ai/glm-5.2",
      targetModel: "z-ai/glm-5.2",
      lane: "direct",
      rule: "exact",
    } as NewEvent);
    // an earlier successful inference reported model A…
    s = reduce(s, {
      kind: "inference.response",
      ...base,
      empty: false,
      truncated: false,
      reportedModel: "z-ai/glm-5.2",
    } as NewEvent);
    expect(s.status.reportedModel).toBe("z-ai/glm-5.2");
    // …then a failover to B whose response omits reportedModel: the stale A must not persist.
    s = reduce(s, {
      kind: "handoff",
      ...base,
      from: "z-ai/glm-5.2",
      to: "moonshotai/kimi-k2.7-code",
      role: "executor",
      lane: "direct",
    } as NewEvent);
    expect(s.status.reportedModel).toBeUndefined();
    expect(s.status.targetModel).toBe("moonshotai/kimi-k2.7-code");
  });

  it("assistant.final's non-empty text is canonical (restores dropped leading indentation)", () => {
    let s = init();
    // the leading-whitespace delta is dropped by the spin guard, so the streamed text loses its indent…
    s = reduce(s, { kind: "assistant.delta", ...base, text: "    " } as NewEvent);
    s = reduce(s, { kind: "assistant.delta", ...base, text: "const x = 1" } as NewEvent);
    // …but the final carries the complete indented text and must win when settling.
    s = reduce(s, { kind: "assistant.final", ...base, text: "    const x = 1" } as NewEvent);
    const a = s.transcript.find((t) => t.kind === "assistant") as Extract<
      TranscriptItem,
      { kind: "assistant" }
    >;
    expect(a.text).toBe("    const x = 1");
    expect(a.streaming).toBe(false);
  });

  it("inference.response folds the reported (actually-serving) model", () => {
    const s = reduce(init(), {
      kind: "inference.response",
      ...base,
      empty: false,
      truncated: false,
      reportedModel: "deepseek/deepseek-v4-flash-0731",
    } as NewEvent);
    expect(s.status.reportedModel).toBe("deepseek/deepseek-v4-flash-0731");
  });

  it("context.preflight feeds the status gauge; turn.finished clears running", () => {
    let s = reduce(init(), {
      kind: "context.preflight",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      model: "m",
      contextWindow: 128000,
      promptEstimate: 4000,
      reserve: 1000,
      requestedOutput: 2048,
      sentOutput: 2048,
      remainingShared: 120000,
    } as NewEvent);
    expect(s.status.contextWindow).toBe(128000);
    expect(s.status.promptEstimate).toBe(4000);
    s = reduce({ ...s, status: { ...s.status, running: true } }, {
      kind: "turn.finished",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      stopReason: "complete",
    } as NewEvent);
    expect(s.status.running).toBe(false);
  });

  it("a REAL error is a red notice; withStop records the stop reason", () => {
    let s = reduce(init(), {
      kind: "error",
      schemaVersion: 1,
      sessionId: "ses_a",
      errorKind: "auth",
      message: "bad key",
    } as NewEvent);
    expect(s.transcript[0]).toMatchObject({ kind: "notice", level: "error" });
    s = withStop(s, "complete");
    expect(s.status.stopReason).toBe("complete");
    expect(s.status.running).toBe(false);
  });

  it("rate_limit / cold are CALM transient notices (dim, deduped) — not a wall of red", () => {
    let s = init();
    const rl = {
      kind: "error",
      schemaVersion: 1,
      sessionId: "ses_a",
      errorKind: "rate_limit",
      message: "Rate limited by Ambient",
      model: "moonshotai/kimi-k2.7-code",
    } as NewEvent;
    s = reduce(s, rl);
    s = reduce(s, rl); // a burst of identical retries…
    s = reduce(s, rl);
    const notices = s.transcript.filter((t) => t.kind === "notice");
    expect(notices).toHaveLength(1); // …collapses to ONE line
    expect(notices[0]).toMatchObject({ level: "info" }); // calm/dim, not "error"
    expect((notices[0] as Extract<TranscriptItem, { kind: "notice" }>).text).toContain("busy");
  });

  it("session.started resets run-scoped status (a second task never shows a stale model/gauge)", () => {
    let s = init();
    for (let i = 0; i < 3; i++) {
      s = reduce(s, {
        kind: "turn.started",
        schemaVersion: 1,
        sessionId: "ses_a",
        turnId: "trn_a",
        input: `t${i}`,
      } as NewEvent);
    }
    s = reduce(s, {
      kind: "model.resolved",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      requestedModel: "a",
      targetModel: "b",
      lane: "direct",
      rule: "r",
      reason: "warm",
    } as NewEvent);
    s = reduce(s, {
      kind: "context.preflight",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      model: "b",
      contextWindow: 128000,
      promptEstimate: 40000,
      reserve: 1000,
      requestedOutput: 2048,
      sentOutput: 2048,
      remainingShared: 80000,
    } as NewEvent);
    s = withStop(s, "complete");
    // a NEW run begins
    s = reduce(s, {
      kind: "session.started",
      schemaVersion: 1,
      sessionId: "ses_b",
      cwd: "/w",
      workspaceRoot: "/w",
    } as NewEvent);
    expect(s.status.stopReason).toBeUndefined();
    expect(s.status.targetModel).toBeUndefined();
    expect(s.status.lane).toBeUndefined();
    expect(s.status.contextWindow).toBeUndefined();
    expect(s.status.promptEstimate).toBeUndefined();
    expect(s.status.running).toBe(true);
    // history is preserved across runs
    expect(s.transcript.length).toBeGreaterThan(0);
  });

  it("withStop terminalizes in-flight items (streaming stops, running tools fail)", () => {
    let s = init();
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_1",
      wireId: "w",
      toolName: "bash",
      args: { command: "sleep 99" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    s = reduce(s, { kind: "assistant.delta", ...base, text: "thinking" } as NewEvent);
    expect(s.transcript.some((t) => t.kind === "assistant" && t.streaming)).toBe(true);
    expect(s.transcript.some((t) => t.kind === "tool" && t.status === "running")).toBe(true);
    s = withStop(s, "cancelled");
    expect(s.transcript.some((t) => t.kind === "assistant" && t.streaming)).toBe(false);
    const tool = s.transcript.find((t) => t.kind === "tool") as Extract<
      TranscriptItem,
      { kind: "tool" }
    >;
    expect(tool.status).toBe("fail");
    expect(tool.error).toBe("cancelled");
  });

  it("assistant.final closes a streaming assistant even when a tool was pushed after it", () => {
    let s = init();
    s = reduce(s, { kind: "assistant.delta", ...base, text: "let me check" } as NewEvent);
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_9",
      wireId: "w",
      toolName: "read",
      args: { path: "a.ts" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    s = reduce(s, { kind: "assistant.final", ...base, text: "" } as NewEvent);
    expect(s.transcript.some((t) => t.kind === "assistant" && t.streaming)).toBe(false);
  });

  it("reduce is deterministic/pure — same (state, event) yields identical ids", () => {
    const s0 = init();
    const ev = {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "x",
    } as NewEvent;
    const a = reduce(s0, ev);
    const b = reduce(s0, ev);
    expect(a).toEqual(b); // no module-global counter — replay/double-invoke are stable
    expect(a.seq).toBe(1);
  });

  it("the plan tool folds into state.plan and does NOT show a transcript row; resets per session", () => {
    let s = init();
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_p",
      wireId: "w",
      toolName: "plan",
      args: {
        tasks: [
          { text: "read the code", status: "done" },
          { text: "write the fix", status: "active" },
          { text: "run tests", status: "pending" },
        ],
      },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    expect(s.plan).toEqual([
      { text: "read the code", status: "done" },
      { text: "write the fix", status: "active" },
      { text: "run tests", status: "pending" },
    ]);
    expect(s.transcript.some((t) => t.kind === "tool")).toBe(false); // no tool row for the plan
    // the plan's own tool.result has no matching row and must NOT create phantom state
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_p",
      ok: true,
      durationMs: 1,
    } as NewEvent);
    expect(s.transcript.some((t) => t.kind === "tool")).toBe(false);
    // malformed / bad status is coerced to pending; non-string text is dropped
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_p2",
      wireId: "w",
      toolName: "plan",
      args: {
        tasks: [
          { text: "ok", status: "weird" },
          { text: 42, status: "done" },
        ],
      },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    expect(s.plan).toEqual([{ text: "ok", status: "pending" }]);
    // a new session clears the plan
    s = reduce(s, {
      kind: "session.started",
      schemaVersion: 1,
      sessionId: "ses_b",
      cwd: "/w",
      workspaceRoot: "/w",
    } as NewEvent);
    expect(s.plan).toEqual([]);
  });

  it("tracks the live ACTIVITY: Thinking → tool verb → back to Thinking → cleared on finish", () => {
    let s = init();
    s = reduce(s, {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "edit the router",
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Thinking" });
    // proposal is recorded but does NOT drive the activity (all proposals emit up front, not in exec order)
    s = reduce(s, {
      kind: "tool.proposed",
      ...base,
      toolCallId: "tc_e",
      wireId: "w",
      toolName: "edit",
      args: { path: "src/router.ts", oldString: "a", newString: "b" },
      rawArgs: "{}",
      argsHash: "h",
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Thinking" }); // unchanged until it actually STARTS
    // it actually starts executing → "Editing <path>"
    s = reduce(s, {
      kind: "tool.started",
      ...base,
      toolCallId: "tc_e",
      toolName: "edit",
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Editing", detail: "src/router.ts" });
    // when it finishes, the agent goes back to the model → "Thinking"
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_e",
      ok: true,
      durationMs: 3,
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Thinking" });
    // turn finished → activity cleared (the live line disappears)
    s = reduce(s, {
      kind: "turn.finished",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      stopReason: "complete",
    } as NewEvent);
    expect(s.status.activity).toBeUndefined();
  });

  it("parallel tools: a finished tool keeps the activity on a still-running sibling, not 'Thinking'", () => {
    let s = init();
    const start = (id: string, name: string, args: unknown) => {
      s = reduce(s, {
        kind: "tool.proposed",
        ...base,
        toolCallId: id,
        wireId: "w",
        toolName: name,
        args,
        rawArgs: "{}",
        argsHash: "h",
      } as NewEvent);
      s = reduce(s, { kind: "tool.started", ...base, toolCallId: id, toolName: name } as NewEvent);
    };
    start("tc_a", "read", { path: "a.ts" });
    start("tc_b", "grep", { pattern: "TODO" });
    // tc_a finishes but tc_b is still running → the line follows tc_b, NOT "Thinking"
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_a",
      ok: true,
      durationMs: 1,
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Searching", detail: "TODO" });
    // now tc_b finishes too → back to Thinking
    s = reduce(s, {
      kind: "tool.result",
      ...base,
      toolCallId: "tc_b",
      ok: true,
      durationMs: 1,
    } as NewEvent);
    expect(s.status.activity).toEqual({ verb: "Thinking" });
  });

  it("slash helpers: appendNotice pushes a notice, clearTranscript empties, setRequestedModel updates", () => {
    let s = init();
    s = reduce(s, {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "x",
    } as NewEvent);
    s = appendNotice(s, "info", "model set to z-ai/glm-5.2");
    expect(s.transcript.some((t) => t.kind === "notice" && t.text.includes("glm-5.2"))).toBe(true);
    s = setRequestedModel(s, "z-ai/glm-5.2");
    expect(s.status.requestedModel).toBe("z-ai/glm-5.2");
    s = clearTranscript(s);
    expect(s.transcript).toHaveLength(0);
    expect(s.plan).toHaveLength(0);
    expect(s.status.requestedModel).toBe("z-ai/glm-5.2"); // status is preserved across a clear
  });

  it("two axes: Tab toggles plan/build, Shift+Tab cycles permission, runtime mode derives", () => {
    expect(toggleAgentMode("plan")).toBe("build");
    expect(toggleAgentMode("build")).toBe("plan");
    expect(nextPermission("ask")).toBe("accept-edits");
    expect(nextPermission("accept-edits")).toBe("bypass");
    expect(nextPermission("bypass")).toBe("ask");
    expect(toRuntimeMode("plan", "bypass")).toBe("plan");
    expect(toRuntimeMode("build", "bypass")).toBe("bypass");
    expect(toRuntimeMode("build", "ask")).toBe("ask");
  });

  it("reduce never mutates the input state (immutability)", () => {
    const s0 = init();
    const frozen = Object.freeze(s0);
    const s1 = reduce(frozen, {
      kind: "turn.started",
      schemaVersion: 1,
      sessionId: "ses_a",
      turnId: "trn_a",
      input: "x",
    } as NewEvent);
    expect(s1).not.toBe(s0);
    expect(s0.transcript).toHaveLength(0);
  });
});
