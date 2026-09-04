import { AmbError, type ChatChunk, ChatChunkSchema } from "@amb/protocol";

/**
 * SSE parsing + OpenAI chat-completion accumulation.
 * Clean-room from ambient-code-bridge/ambient_code/upstream.py (MIT).
 *
 * The tricky part is reassembling a tool call whose `arguments` JSON is fragmented across many deltas
 * (and possibly across network chunk boundaries) — getting this wrong silently corrupts tool inputs.
 * The chunk wire-shape is validated by @amb/protocol's ChatChunkSchema (single source of truth).
 */

export interface SSEEvent {
  data: string;
}

/** Parse a complete SSE text payload into events. Ignores comment lines and non-data fields. */
export function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length > 0) events.push({ data: dataLines.join("\n") });
  }
  return events;
}

/** The `[DONE]` sentinel returned by parseChatChunk when the stream is complete. */
export const CHUNK_DONE = Symbol("chunk-done");

/**
 * Parse one SSE `data:` payload into a validated chat chunk. Returns CHUNK_DONE at `[DONE]`. Unlike a silent
 * skip, this THROWS a classified transport error on malformed JSON, a provider error object embedded in the
 * stream, or a chunk that fails the wire schema — so provider drift surfaces as a clear, retryable failure
 * instead of an unexplained empty answer (fail-fast).
 */
export function parseChatChunk(data: string): ChatChunk | typeof CHUNK_DONE {
  if (data === "[DONE]") return CHUNK_DONE;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new AmbError({
      kind: "transport",
      message: `malformed SSE chunk (not JSON): ${data.slice(0, 200)}`,
      retryable: true,
    });
  }
  // A provider error delivered mid-stream ({"error": {...}}) must not masquerade as an empty chunk.
  if (json && typeof json === "object" && "error" in json) {
    const e = (json as { error: unknown }).error;
    const msg =
      e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : JSON.stringify(e);
    throw new AmbError({
      kind: "transport",
      message: `provider error in stream: ${msg.slice(0, 200)}`,
      retryable: true,
    });
  }
  const parsed = ChatChunkSchema.safeParse(json);
  if (!parsed.success) {
    throw new AmbError({
      kind: "transport",
      message: `SSE chunk failed the wire schema: ${parsed.error.issues[0]?.message ?? "invalid shape"}`,
      retryable: true,
    });
  }
  return parsed.data;
}

export interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AccumulatedCompletion {
  content: string;
  reasoning: string;
  toolCalls: AccumulatedToolCall[];
  finishReason?: string;
  /** The model the provider actually served (from the response `model`), observed during the stream. */
  reportedModel?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface AccumulatorCallbacks {
  onContent?: (text: string) => void;
  onReasoning?: (text: string) => void;
}

/** Incrementally folds SSE chunks into a settled completion, invoking callbacks as text streams in. */
export class ChatAccumulator {
  private content = "";
  private reasoning = "";
  private finishReason: string | undefined;
  private reportedModel: string | undefined;
  private usage: AccumulatedCompletion["usage"];
  private readonly toolMap = new Map<number, AccumulatedToolCall>();

  constructor(private readonly cb: AccumulatorCallbacks = {}) {}

  /**
   * Push one SSE event. Returns false when the `[DONE]` sentinel is seen (stop iterating). THROWS a classified
   * transport error on a malformed / error / off-schema chunk (parseChatChunk) rather than silently dropping it.
   */
  push(e: SSEEvent): boolean {
    const chunk = parseChatChunk(e.data);
    if (chunk === CHUNK_DONE) return false;
    if (this.reportedModel === undefined && typeof chunk.model === "string") {
      this.reportedModel = chunk.model;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.content += delta.content;
        this.cb.onContent?.(delta.content);
      }
      const r = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
      if (typeof r === "string" && r.length > 0) {
        this.reasoning += r;
        this.cb.onReasoning?.(r);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = this.toolMap.get(idx) ?? { id: "", name: "", arguments: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          this.toolMap.set(idx, cur);
        }
      }
    }
    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
    if (chunk.usage) {
      this.usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
      };
    }
    return true;
  }

  result(): AccumulatedCompletion {
    const toolCalls = [...this.toolMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    return {
      content: this.content,
      reasoning: this.reasoning,
      toolCalls,
      finishReason: this.finishReason,
      reportedModel: this.reportedModel,
      usage: this.usage,
    };
  }
}

/** Fold a finished stream of SSE events into a settled completion. Stops at the `[DONE]` sentinel. */
export function accumulateChatStream(events: Iterable<SSEEvent>): AccumulatedCompletion {
  const acc = new ChatAccumulator();
  for (const e of events) {
    if (!acc.push(e)) break;
  }
  return acc.result();
}

/** Incrementally parse SSE events from a byte stream, respecting arbitrary chunk boundaries. */
export async function* readSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const sep = /\r?\n\r?\n/;
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let m = sep.exec(buf);
    while (m) {
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      for (const ev of parseSSE(block)) yield ev;
      m = sep.exec(buf);
    }
  }
  buf += decoder.decode();
  if (buf.trim().length > 0) {
    for (const ev of parseSSE(buf)) yield ev;
  }
}
