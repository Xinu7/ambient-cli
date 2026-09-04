import { randomUUID } from "node:crypto";
import {
  type AmbientConfig,
  type ChatRequest,
  fetchCatalog,
  streamChatCompletion,
} from "@amb/ambient-api";
import type { CatalogModel } from "@amb/protocol";
import type { ChatClient, ChatParams, Msg, ToolCall, TurnCompletion } from "@amb/runtime";

/** The real Ambient adapter: implements the runtime's ChatClient over @amb/ambient-api. Ambient-only. */
export class AmbientChatClient implements ChatClient {
  constructor(private readonly config: AmbientConfig) {}

  fetchCatalog(signal?: AbortSignal): Promise<CatalogModel[]> {
    return fetchCatalog(this.config, signal ? { signal } : {});
  }

  async chat(params: ChatParams): Promise<TurnCompletion> {
    const req: ChatRequest = {
      model: params.model,
      messages: toWireMessages(params.messages),
      maxTokens: params.maxTokens,
      tools: params.tools,
      // Sent only when the agent resolved a concrete effort for a reasoning-capable served model.
      ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
    };
    const out = await streamChatCompletion(this.config, req, {
      signal: params.signal,
      onContent: params.onContent,
      onReasoning: params.onReasoning,
      // Tell the API layer the outbound body carries image parts, so an image-related 400 from a model that
      // can't actually see images is NOT misclassified as a context overflow (which would trigger compaction).
      hasImage: params.hasImage ?? messagesHaveImageParts(params.messages),
    });
    const toolCalls: ToolCall[] = out.toolCalls.map((tc) => ({
      // Synthesize a GLOBALLY-unique id when the provider omitted one, so ids never collide across
      // parallel calls OR across turns — a per-response index alone repeats as tc_read_0.
      id: tc.id || `tc_${tc.name}_${randomUUID().slice(0, 8)}`,
      name: tc.name,
      args: safeParse(tc.arguments),
      rawArgs: tc.arguments,
    }));
    return {
      content: out.content,
      toolCalls,
      finishReason: out.finishReason,
      reportedModel: out.reportedModel,
      usage: out.usage,
    };
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** Translate the runtime's message shape into OpenAI wire messages (assistant tool_calls + tool results). */
export function toWireMessages(messages: Msg[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        // Bridge canonical shape: content is null (not "") when tool_calls are present.
        content: typeof m.content === "string" && m.content.length > 0 ? m.content : null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.rawArgs },
        })),
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: wireContent(m.content),
      };
    }
    return {
      role: m.role,
      content: wireContent(m.content),
    };
  });
}

/**
 * Shape a message's content for the wire. A content-parts ARRAY (text + image_url, the OpenAI vision format)
 * passes through VERBATIM — the load-bearing vision fix: the old code JSON.stringify'd any non-string content,
 * which silently collapsed image parts into a dead string. A string stays a string; anything else is stringified
 * defensively.
 */
function wireContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content;
  return JSON.stringify(content ?? "");
}

/** True if any message carries an image content-part — drives the API layer's image-vs-overflow 400 classify. */
export function messagesHaveImageParts(messages: Msg[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some(
        (p) =>
          p !== null && typeof p === "object" && (p as { type?: unknown }).type === "image_url",
      ),
  );
}
