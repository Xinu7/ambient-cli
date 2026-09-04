import { createBuiltinRegistry } from "@amb/tools-core";
import { describe, expect, it } from "vitest";
import {
  assistedProtocol,
  parseAssistedResponse,
  renderToolsAsText,
  stripActionBlock,
} from "../src/assisted.js";

const tools = createBuiltinRegistry().list();

describe("renderToolsAsText / assistedProtocol", () => {
  it("lists each tool as a COMPACT signature (name(params): desc) + the action protocol", () => {
    const text = renderToolsAsText(tools);
    expect(text).toContain("read("); // compact signature, not a full JSON-schema blob
    expect(text).toContain("edit(");
    expect(text).toContain("path"); // the param name is present (enough to form a call)
    expect(text).not.toContain("JSON Schema"); // the verbose schema dump is gone
    const proto = assistedProtocol(tools);
    expect(proto).toContain("amb-action");
    expect(proto).toContain('"tool"');
  });
});

describe("parseAssistedResponse", () => {
  it("parses a well-formed action envelope", () => {
    const r = parseAssistedResponse(
      'Let me read it.\n```amb-action\n{"tool":"read","args":{"path":"a.ts"}}\n```',
    );
    expect(r.kind).toBe("action");
    if (r.kind === "action") {
      expect(r.tool).toBe("read");
      expect(r.args).toEqual({ path: "a.ts" });
      expect(r.rawArgs).toBe('{"path":"a.ts"}');
    }
  });

  it("parses a SINGLE-LINE fence (some weak models emit the whole envelope on one line) — audit", () => {
    for (const reply of [
      '```amb-action {"tool":"read","args":{"path":"a.ts"}}```',
      '```amb-action{"tool":"read","args":{"path":"a.ts"}}```',
    ]) {
      const r = parseAssistedResponse(reply);
      expect(r.kind).toBe("action");
      if (r.kind === "action") {
        expect(r.tool).toBe("read");
        expect(r.args).toEqual({ path: "a.ts" });
      }
    }
    // …and it's STRIPPED from the visible text (no raw protocol JSON leaks to the user)
    expect(stripActionBlock('done ```amb-action {"tool":"read","args":{}}```')).toBe("done");
    // guard: an extended info string like ```amb-actionable is NEVER parsed as an executable action
    expect(parseAssistedResponse("```amb-actionable\nsome code\n```").kind).not.toBe("action");
  });

  it("treats a plain reply as a final answer", () => {
    const r = parseAssistedResponse("All done — the file compiles.");
    expect(r.kind).toBe("final");
    if (r.kind === "final") expect(r.text).toBe("All done — the file compiles.");
  });

  it("does NOT execute a bare ```json code block (only the explicit amb-action fence acts) — audit HIGH", () => {
    // A model showing example code must never be run as a real action.
    const r = parseAssistedResponse(
      'Here is how you would call it:\n```json\n{"tool":"list","args":{"path":"."}}\n```',
    );
    expect(r.kind).toBe("final");
  });

  it("returns an error (for repair) on malformed JSON in the action block", () => {
    const r = parseAssistedResponse("```amb-action\n{tool: read}\n```");
    expect(r.kind).toBe("error");
  });

  it("returns an error (repair) when the model MENTIONS amb-action but the fence is unterminated — audit #4", () => {
    const r = parseAssistedResponse('I\'ll act now.\n```amb-action\n{"tool":"read","args":{}}');
    expect(r.kind).toBe("error");
  });

  it("returns an error when args is a non-object (string/array) — audit #5", () => {
    expect(parseAssistedResponse('```amb-action\n{"tool":"read","args":"a.ts"}\n```').kind).toBe(
      "error",
    );
    expect(parseAssistedResponse('```amb-action\n{"tool":"read","args":[1,2]}\n```').kind).toBe(
      "error",
    );
  });

  it("nudges (repair) a BARE unfenced action instead of silently ending the run", () => {
    // A weak model emits the JSON action with no fence — must NOT be treated as a final answer.
    const r = parseAssistedResponse('{"tool":"read","args":{"path":"a.ts"}}');
    expect(r.kind).toBe("error");
    // But a genuine prose answer that merely mentions the word tool is still a final answer.
    expect(parseAssistedResponse("I used the read tool and here is the result.").kind).toBe(
      "final",
    );
    // A JSON object that isn't an action (no string `tool`) is still a final answer.
    expect(parseAssistedResponse('{"result": 42}').kind).toBe("final");
    // A legit final JSON with a `tool` key but NO args object is a final answer, NOT an action (
    // else a model obeying a JSON output format loops to maxTurns).
    expect(parseAssistedResponse('{"tool":"hammer","version":1}').kind).toBe("final");
  });

  it("acts on the FIRST block when several are present (protocol says exactly one)", () => {
    const r = parseAssistedResponse(
      '```amb-action\n{"tool":"read","args":{"path":"a"}}\n```\n```amb-action\n{"tool":"list","args":{}}\n```',
    );
    expect(r.kind).toBe("action");
    if (r.kind === "action") expect(r.tool).toBe("read");
  });

  it("returns an error when the tool field is missing", () => {
    const r = parseAssistedResponse('```amb-action\n{"args":{}}\n```');
    expect(r.kind).toBe("error");
  });

  it("defaults args to {} when omitted", () => {
    const r = parseAssistedResponse('```amb-action\n{"tool":"list"}\n```');
    expect(r.kind).toBe("action");
    if (r.kind === "action") expect(r.args).toEqual({});
  });
});

describe("stripActionBlock", () => {
  it("removes the action envelope leaving the reasoning text", () => {
    const t = stripActionBlock(
      'Reading the file.\n```amb-action\n{"tool":"read","args":{"path":"a"}}\n```',
    );
    expect(t).toBe("Reading the file.");
  });
  it("strips an UNTERMINATED action fence through EOF (no raw scaffolding leaks as an answer)", () => {
    const t = stripActionBlock(
      'Reading the file.\n```amb-action\n{"tool":"read","args":{"path":"a"}}',
    );
    expect(t).toBe("Reading the file.");
    expect(t).not.toContain("amb-action");
    expect(t).not.toContain("{");
  });
  it("does NOT strip a FENCED prefix (```amb-actionable) — the info string must be exactly amb-action", () => {
    // The naive `\`\`\`amb-action[\s\S]*$` would wrongly strip this (amb-action is a prefix of amb-actionable).
    const t = stripActionBlock("Notes below.\n```amb-actionable\n- item one\n- item two\n```");
    expect(t).toContain("item one");
    expect(t).toContain("amb-actionable"); // the block itself is preserved — it isn't our envelope
  });

  it("does NOT strip an INLINE (non-line-start) amb-action mention", () => {
    // The naive unanchored regex would strip from a mid-line ```amb-action to EOF; ours requires a line start.
    const t = stripActionBlock(
      "Use the ```amb-action``` envelope to call a tool, then continue working.",
    );
    expect(t).toContain("then continue working.");
  });

  it("strips a fence indented up to 3 spaces (Markdown allows it)", () => {
    const t = stripActionBlock('Reading.\n   ```amb-action\n{"tool":"read","args":{"path":"a"}}');
    expect(t).toBe("Reading.");
    expect(t).not.toContain("amb-action");
  });
});
