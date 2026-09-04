import { z } from "zod";
import { type JsonRpcClient, JsonRpcError } from "./jsonrpc.js";

/** The MCP protocol version we speak (JSON-RPC 2.0 over stdio, newline-delimited). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Bounds on what an UNTRUSTED server can make us hold in memory before the runtime's own result cap runs. */
const MAX_TOOLS = 512; // tools/list is truncated to this many
const MAX_CONTENT_PARTS = 256; // tools/call content parts kept
const MAX_RESULT_CHARS = 262_144; // total flattened tool-result text (256 KiB) the model could ever see
/** The handshake + tools/list must be quick; a tool CALL may legitimately run much longer (matches the tool
 *  manifest's maximumMs), so the two policies are separate — one slow tool must not be capped at the init budget. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

const McpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  // MCP tool annotations (advisory hints). `readOnlyHint:true` lets us map the tool to read-only effects.
  annotations: z
    .object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })
    .passthrough()
    .optional(),
});
export type McpTool = z.infer<typeof McpToolSchema>;

const ListToolsResult = z.object({ tools: z.array(McpToolSchema).default([]) });

// A tool result is a list of content parts (text/image/…) + an optional error flag.
const CallToolResult = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
    .default([]),
  isError: z.boolean().optional(),
});
export type CallToolResult = z.infer<typeof CallToolResult>;

/**
 * A thin MCP client over a JSON-RPC endpoint: the `initialize` handshake, tool discovery, and tool calls.
 * Every response is validated with Zod at the boundary (an untrusted server can't hand us a malformed shape
 * the rest of the app then trusts). v1 supports tools only (resources/prompts deferred).
 */
export class McpClient {
  private readonly callTimeoutMs: number;
  constructor(
    private readonly rpc: JsonRpcClient,
    opts: { callTimeoutMs?: number } = {},
  ) {
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /** Perform the MCP handshake. Must complete before listTools/callTool. */
  async initialize(): Promise<void> {
    await this.rpc.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ambient-cli", version: "0.1.0" },
    });
    this.rpc.notify("notifications/initialized");
  }

  /** Discover the server's tools (count-bounded BEFORE validation, then validated). */
  async listTools(): Promise<McpTool[]> {
    const raw = boundArrayField(await this.rpc.request("tools/list", {}), "tools", MAX_TOOLS);
    const parsed = ListToolsResult.safeParse(raw);
    if (!parsed.success) throw new JsonRpcError(`malformed tools/list: ${parsed.error.message}`);
    return parsed.data.tools;
  }

  /** Invoke a tool by name with arguments; returns the count-bounded (BEFORE validation), validated result. */
  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    // Bound the content-part array on the RAW response, before Zod clones every part (untrusted server).
    const raw = boundArrayField(
      await this.rpc.request("tools/call", { name, arguments: args ?? {} }, this.callTimeoutMs),
      "content",
      MAX_CONTENT_PARTS,
    );
    const parsed = CallToolResult.safeParse(raw);
    if (!parsed.success)
      throw new JsonRpcError(`malformed tools/call result: ${parsed.error.message}`);
    return parsed.data;
  }

  close(): void {
    this.rpc.close();
  }
}

/** If `raw.<field>` is an array longer than `max`, return a shallow copy truncated to `max` — applied to the
 *  UNTRUSTED response BEFORE schema validation so Zod never parses/clones an unbounded array. */
function boundArrayField(raw: unknown, field: string, max: number): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const arr = o[field];
  return Array.isArray(arr) && arr.length > max ? { ...o, [field]: arr.slice(0, max) } : raw;
}

/** Flatten an MCP call result's content parts into a single, length-bounded text blob (what the model sees).
 *  Trim (drop outer whitespace) BEFORE the cap so leading padding never displaces real content, then bound.
 *  The input is already frame-bounded (LineFramer cap) + part-count-bounded (boundArrayField), so building the
 *  joined string here is a bounded transient — correctness (exact prior semantics) beats a micro-optimization. */
export function resultToText(r: CallToolResult): string {
  const joined = r.content
    .map((c) => (typeof c.text === "string" ? c.text : `[${c.type}]`))
    .join("\n")
    .trim();
  const text = joined.length > MAX_RESULT_CHARS ? `${joined.slice(0, MAX_RESULT_CHARS)}…` : joined;
  return r.isError ? `tool error: ${text || "(no detail)"}` : text;
}
