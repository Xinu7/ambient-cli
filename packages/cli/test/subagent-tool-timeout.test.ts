import { describe, expect, it } from "vitest";
import { makeSubagentTool } from "../src/agent/subagent-tool.js";

describe("subagent tool timeout", () => {
  it("declares no whole-wave hard cap — each child bounds itself, so big waves aren't aborted wholesale", () => {
    const tool = makeSubagentTool({
      client: { fetchCatalog: async () => [], chat: async () => ({ content: "", toolCalls: [] }) },
      workspace: {
        instructions: () => "",
        readMemory: () => undefined,
        writeMemory: () => {},
        date: () => "2026-09-25",
        platform: () => "test",
        skills: () => [],
      },
      approve: async () => "deny",
      parentMode: "ask",
    });
    expect(tool.manifest.timeoutPolicy.maximumMs).toBeUndefined();
  });
});
