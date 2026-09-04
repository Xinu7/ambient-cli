import { AmbError } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import {
  CHUNK_DONE,
  ChatAccumulator,
  type SSEEvent,
  accumulateChatStream,
  parseChatChunk,
  parseSSE,
  readSSEStream,
} from "../src/index.js";

const ev = (o: unknown): SSEEvent => ({ data: JSON.stringify(o) });

describe("parseSSE", () => {
  it("extracts data lines and ignores comments", () => {
    const evs = parseSSE(":comment\ndata: hello\n\ndata: [DONE]\n\n");
    expect(evs.map((e) => e.data)).toEqual(["hello", "[DONE]"]);
  });
});

describe("parseChatChunk (fail fast, don't silently discard)", () => {
  it("returns CHUNK_DONE at the sentinel and a validated chunk for good data", () => {
    expect(parseChatChunk("[DONE]")).toBe(CHUNK_DONE);
    const chunk = parseChatChunk(JSON.stringify({ choices: [{ delta: { content: "hi" } }] }));
    expect(chunk).not.toBe(CHUNK_DONE);
  });
  it("THROWS a retryable transport error on malformed JSON (was silently skipped)", () => {
    expect(() => parseChatChunk("{not json")).toThrow(AmbError);
    try {
      parseChatChunk("{not json");
    } catch (e) {
      expect((e as AmbError).kind).toBe("transport");
      expect((e as AmbError).retryable).toBe(true);
    }
  });
  it("THROWS on a provider error object embedded in the stream (no empty-answer masquerade)", () => {
    expect(() => parseChatChunk(JSON.stringify({ error: { message: "rate limited" } }))).toThrow(
      /provider error in stream: rate limited/,
    );
  });
  it("ChatAccumulator.push propagates the throw instead of dropping the chunk", () => {
    const acc = new ChatAccumulator();
    expect(() => acc.push({ data: "{broken" })).toThrow(AmbError);
  });
});

describe("accumulateChatStream", () => {
  it("concatenates content, captures reasoning + reported model + finish, stops at [DONE]", () => {
    const out = accumulateChatStream([
      ev({ model: "moonshotai/kimi-k2.7-code", choices: [{ delta: { content: "Hel" } }] }),
      ev({ choices: [{ delta: { reasoning: "thinking" } }] }),
      ev({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }),
      { data: "[DONE]" },
      ev({ choices: [{ delta: { content: "IGNORED" } }] }),
    ]);
    expect(out.content).toBe("Hello");
    expect(out.reasoning).toBe("thinking");
    expect(out.reportedModel).toBe("moonshotai/kimi-k2.7-code");
    expect(out.finishReason).toBe("stop");
  });

  it("reassembles a tool call whose arguments are fragmented across deltas", () => {
    const out = accumulateChatStream([
      ev({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } },
              ],
            },
          },
        ],
      }),
      ev({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } },
        ],
      }),
      ev({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toEqual({ id: "call_1", name: "read", arguments: '{"path":"a.ts"}' });
    expect(out.finishReason).toBe("tool_calls");
  });

  it("captures usage from a usage-only terminal chunk", () => {
    const out = accumulateChatStream([
      ev({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    ]);
    expect(out.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });
});

describe("ChatAccumulator", () => {
  it("streams content via onContent, stops at [DONE], and settles the same result", () => {
    const seen: string[] = [];
    const acc = new ChatAccumulator({ onContent: (t) => seen.push(t) });
    acc.push(ev({ model: "z-ai/glm-5.2", choices: [{ delta: { content: "Hel" } }] }));
    acc.push(ev({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }));
    expect(acc.push({ data: "[DONE]" })).toBe(false);
    expect(seen).toEqual(["Hel", "lo"]);
    const r = acc.result();
    expect(r.content).toBe("Hello");
    expect(r.reportedModel).toBe("z-ai/glm-5.2");
    expect(r.finishReason).toBe("stop");
  });
});

describe("readSSEStream", () => {
  it("parses events split across arbitrary chunk boundaries", async () => {
    const enc = new TextEncoder();
    const parts = ['data: {"a":1}\n', '\ndata: {"b":2}\n\n'];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    const seen: string[] = [];
    for await (const e of readSSEStream(stream)) seen.push(e.data);
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });
});
