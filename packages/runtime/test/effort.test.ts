import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel, NewEvent } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { autoEffortForTask, resolveEffort, summaryEffort } from "../src/effort.js";
import type { ChatClient, ChatParams, RunOptions, TurnCompletion } from "../src/ports.js";

function model(id: string, features: string[], ready = true): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: [],
    outputModalities: [],
    supportedFeatures: features,
    supportedSamplingParameters: [],
    contextLength: 262_144,
    maxOutputLength: 262_144,
    isReady: ready,
  };
}

const reasoning = model("re/asoning", ["tools", "reasoning"]);
const plain = model("no/reasoning", ["tools"]);

// Runtime Mode is plan | ask | accept-edits | bypass (the TUI's "build" maps to the permission axis).
describe("autoEffortForTask — task-adaptive auto effort (fixes the 23s 'sup')", () => {
  it("trivial/greeting/tiny input → low (never medium reasoning on a hello)", () => {
    expect(autoEffortForTask("sup", "ask")).toBe("low");
    expect(autoEffortForTask("hi", "ask")).toBe("low");
    expect(autoEffortForTask("thanks!", "ask")).toBe("low");
    expect(autoEffortForTask("list the files", "ask")).toBe("low"); // ≤4 words → trivial
  });
  it("clearly-hard work → high", () => {
    expect(autoEffortForTask("fix the failing auth test", "ask")).toBe("high");
    expect(autoEffortForTask("why is this crashing?", "ask")).toBe("high");
    expect(autoEffortForTask("refactor the token estimator", "ask")).toBe("high");
  });
  it("ordinary tasks → medium; plan mode always → high", () => {
    expect(autoEffortForTask("build a 2048 game in react", "ask")).toBe("medium");
    expect(autoEffortForTask("sup", "plan")).toBe("high");
  });
  it("resolveEffort uses the task level for `auto`, still gated on reasoning support", () => {
    const reasoning = { supportedFeatures: ["reasoning"] } as unknown as CatalogModel;
    const plain = { supportedFeatures: [] } as unknown as CatalogModel;
    expect(resolveEffort("auto", reasoning, "ask", "low")).toBe("low");
    expect(resolveEffort("auto", reasoning, "ask", "high")).toBe("high");
    expect(resolveEffort("auto", plain, "ask", "high")).toBeUndefined(); // not sent to a non-reasoning model
  });
});

describe("resolveEffort (pure)", () => {
  it("sends nothing when off", () => {
    expect(resolveEffort("off", reasoning, "bypass")).toBeUndefined();
  });
  it("defaults an ABSENT setting to auto (never silently disables reasoning)", () => {
    // undefined ⇒ auto ⇒ medium while building, high while planning — NOT undefined.
    expect(resolveEffort(undefined, reasoning, "bypass")).toBe("medium");
    expect(resolveEffort(undefined, reasoning, "plan")).toBe("high");
  });
  it("auto thinks HARDER while planning (high) and stays balanced otherwise (medium)", () => {
    expect(resolveEffort("auto", reasoning, "plan")).toBe("high");
    expect(resolveEffort("auto", reasoning, "ask")).toBe("medium");
    expect(resolveEffort("auto", reasoning, "accept-edits")).toBe("medium");
    expect(resolveEffort("auto", reasoning, "bypass")).toBe("medium");
  });
  it("passes an explicit level through unchanged (for a reasoning-capable model)", () => {
    expect(resolveEffort("low", reasoning, "ask")).toBe("low");
    expect(resolveEffort("medium", reasoning, "ask")).toBe("medium");
    expect(resolveEffort("high", reasoning, "ask")).toBe("high");
  });
  it("NEVER sends effort to a model that doesn't advertise `reasoning` (catalog-adaptive)", () => {
    expect(resolveEffort("high", plain, "plan")).toBeUndefined();
    expect(resolveEffort("auto", plain, "plan")).toBeUndefined();
    expect(resolveEffort("low", plain, "ask")).toBeUndefined();
  });
  it("sends nothing when the served model is unknown (absent from the catalog)", () => {
    expect(resolveEffort("high", undefined, "ask")).toBeUndefined();
  });
});

describe("summaryEffort (compaction is a cheap utility task, not the run's effort)", () => {
  it("sends LOW to a reasoning-capable model (never the run's high-effort tokens)", () => {
    expect(summaryEffort(reasoning)).toBe("low");
  });
  it("sends nothing to a model without the reasoning feature, or an unknown model", () => {
    expect(summaryEffort(plain)).toBeUndefined();
    expect(summaryEffort(undefined)).toBeUndefined();
  });
});

/** Scripted mock that records every ChatParams so we can prove reasoningEffort actually reaches the wire. */
class RecordingClient implements ChatClient {
  public calls: ChatParams[] = [];
  constructor(
    private readonly cat: CatalogModel[],
    private readonly script: TurnCompletion[],
  ) {}
  async fetchCatalog(): Promise<CatalogModel[]> {
    return this.cat;
  }
  async chat(params: ChatParams): Promise<TurnCompletion> {
    this.calls.push(params);
    const next = this.script.shift();
    if (!next) throw new Error("mock script exhausted");
    return next;
  }
}

let ws: string;
const collected: NewEvent[] = [];
const opts = (over: Partial<RunOptions>): RunOptions => ({
  sessionId: "ses_effort-0000",
  mode: "bypass",
  requestedModel: reasoning.id,
  maxTurns: 4,
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  emit: (e) => collected.push(e),
  approve: async () => "deny",
  // Inert workspace — these tests don't exercise instructions/memory (workspace is required in RunOptions).
  workspace: {
    instructions: () => "",
    readMemory: () => undefined,
    writeMemory: () => {},
    date: () => "2026-09-02",
    platform: () => "test",
    skills: () => [],
  },
  ...over,
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "amb-effort-"));
  collected.length = 0;
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("effort reaches the chat client (wired, not just built)", () => {
  it("sends the resolved reasoning_effort for a reasoning-capable served model", async () => {
    const client = new RecordingClient([reasoning], [{ content: "done", toolCalls: [] }]);
    await new Agent(client).run("hi", opts({ effort: "high", requestedModel: reasoning.id }));
    expect(client.calls[0]?.reasoningEffort).toBe("high");
  });

  it("auto in plan mode resolves to high on the wire", async () => {
    const client = new RecordingClient([reasoning], [{ content: "done", toolCalls: [] }]);
    await new Agent(client).run("hi", opts({ effort: "auto", mode: "plan" }));
    expect(client.calls[0]?.reasoningEffort).toBe("high");
  });

  it("sends NOTHING for a model without the reasoning feature, even at effort high", async () => {
    const client = new RecordingClient([plain], [{ content: "done", toolCalls: [] }]);
    await new Agent(client).run("hi", opts({ effort: "high", requestedModel: plain.id }));
    expect(client.calls[0]?.reasoningEffort).toBeUndefined();
  });

  it("off suppresses effort even for a reasoning-capable model", async () => {
    const client = new RecordingClient([reasoning], [{ content: "done", toolCalls: [] }]);
    await new Agent(client).run("hi", opts({ effort: "off" }));
    expect(client.calls[0]?.reasoningEffort).toBeUndefined();
  });
});

describe("empty fleet is fatal — the `auto` sentinel never reaches the wire", () => {
  it("errors cleanly and sends NO chat request when the catalog is empty", async () => {
    const client = new RecordingClient([], [{ content: "unused", toolCalls: [] }]);
    const res = await new Agent(client).run("hi", opts({ requestedModel: "auto" }));
    expect(res.stopReason).toBe("error");
    expect(client.calls.length).toBe(0); // never sent "auto" (or anything) to the model
  });
});
