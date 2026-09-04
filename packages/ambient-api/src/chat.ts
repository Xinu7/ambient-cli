import { AmbError, ChatRequestSchema } from "@amb/protocol";
import { type AmbientConfig, type FetchLike, authHeaders, chatUrl } from "./config.js";
import { classifyHttpError } from "./errors.js";
import {
  type AccumulatedCompletion,
  type AccumulatorCallbacks,
  ChatAccumulator,
  type SSEEvent,
  readSSEStream,
} from "./sse.js";

export interface ChatRequest {
  model: string;
  messages: unknown[];
  maxTokens?: number;
  tools?: unknown[];
  temperature?: number;
  /** Reasoning effort (low/medium/high) — the caller sends it only for reasoning-capable models. */
  reasoningEffort?: "low" | "medium" | "high";
}

/** Build the OpenAI-compatible body Ambient expects. Always streamed with usage included. */
export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  // Only send `tools` when there is at least one — an empty array is rejected by some models (and the
  // assisted lane deliberately sends no tools, describing them as text instead).
  if (Array.isArray(req.tools) && req.tools.length > 0) body.tools = req.tools;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.reasoningEffort !== undefined) body.reasoning_effort = req.reasoningEffort;
  return body;
}

/** POST /v1/chat/completions and stream SSE events. Throws a classified AmbError on a non-OK response. */
export async function* streamChat(
  config: AmbientConfig,
  req: ChatRequest,
  opts: { fetch?: FetchLike; signal?: AbortSignal; hasImage?: boolean } = {},
): AsyncGenerator<SSEEvent> {
  const doFetch = opts.fetch ?? (fetch as unknown as FetchLike);
  // Validate the OUTBOUND body against the wire schema before sending — a malformed request is our bug, not a
  // transient, so fail fast (non-retryable) with a clear message instead of letting the provider 400 opaquely.
  const body = buildChatBody(req);
  const validated = ChatRequestSchema.safeParse(body);
  if (!validated.success) {
    throw new AmbError({
      kind: "bad_request",
      message: `outbound chat body failed validation: ${validated.error.issues[0]?.message ?? "invalid"}`,
      retryable: false,
      model: req.model,
    });
  }
  const res = await doFetch(chatUrl(config), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...authHeaders(config),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw classifyHttpError(res.status, text, { model: req.model, hasImage: opts.hasImage });
  }
  if (!res.body) throw new Error("Ambient chat response has no body");
  yield* readSSEStream(res.body as ReadableStream<Uint8Array>);
}

/** Convenience: stream a chat completion to completion, invoking callbacks as text arrives. */
export async function streamChatCompletion(
  config: AmbientConfig,
  req: ChatRequest,
  opts: { fetch?: FetchLike; signal?: AbortSignal; hasImage?: boolean } & AccumulatorCallbacks = {},
): Promise<AccumulatedCompletion> {
  const acc = new ChatAccumulator({ onContent: opts.onContent, onReasoning: opts.onReasoning });
  for await (const e of streamChat(config, req, opts)) {
    if (!acc.push(e)) break;
  }
  return acc.result();
}
