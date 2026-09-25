import type { ToolDefinition } from "@amb/protocol";
import { McpClient } from "./client.js";
import { type HttpServerConfig, spawnHttpTransport } from "./http.js";
import { JsonRpcClient, type Transport } from "./jsonrpc.js";
import { spawnSseTransport } from "./sse-legacy.js";
import { type StdioServerConfig, spawnStdioTransport } from "./stdio.js";
import { mcpToolToDefinition } from "./to-tool.js";

/** One MCP server: either a local stdio child process OR a remote Streamable-HTTP endpoint. */
export type McpServerConfig = StdioServerConfig | HttpServerConfig;
export interface McpServerSpec {
  name: string;
  config: McpServerConfig;
}

/** The default transport factory — picks HTTP for a `{url}` config, else spawns a stdio child. */
function defaultSpawn(cfg: McpServerConfig): { transport: Transport } {
  if (!("url" in cfg)) return spawnStdioTransport(cfg);
  return cfg.legacySse ? spawnSseTransport(cfg) : spawnHttpTransport(cfg);
}

export interface McpSession {
  /** All discovered tools across servers, as ambient ToolDefinitions (register these). */
  tools: ToolDefinition[];
  /** Shut every server down (kills the child processes). */
  close(): void;
}

export interface StartOptions {
  onLog?: (msg: string) => void;
  /** Timeout for the handshake + tools/list (quick). A tool CALL uses `callTimeoutMs` instead. */
  initTimeoutMs?: number;
  /** Timeout for a single tools/call — much longer than init so a legitimately slow tool isn't cut short. */
  callTimeoutMs?: number;
  /** Injectable transport factory (defaults to stdio child / HTTP by config shape) — tests pass a fake. */
  spawn?: (cfg: McpServerConfig) => { transport: Transport };
}

/**
 * Start a set of MCP servers, run the handshake, discover their tools, and return them as ambient tools plus
 * a `close()`. A server that fails to start / initialize / list is LOGGED and SKIPPED — one bad server never
 * kills the run (or the others). Every discovered tool is namespaced + untrusted-guarded by mcpToolToDefinition.
 */
export async function startMcpServers(
  specs: McpServerSpec[],
  opts: StartOptions = {},
): Promise<McpSession> {
  const log = opts.onLog ?? (() => {});
  const spawnFn = opts.spawn ?? defaultSpawn;

  // Servers start in PARALLEL (one slow or dead server must not hold up the rest); their tools are then
  // registered in config order, so the tool list — and the prompt it feeds — is the same every time.
  const started = await Promise.all(
    specs.map(async (spec) => {
      let client: McpClient | undefined;
      try {
        const { transport } = spawnFn(spec.config);
        client = new McpClient(
          new JsonRpcClient(transport, { requestTimeoutMs: opts.initTimeoutMs ?? 15_000 }),
          { ...(opts.callTimeoutMs ? { callTimeoutMs: opts.callTimeoutMs } : {}) },
        );
        await client.initialize();
        return { spec, client, discovered: await client.listTools() };
      } catch (e) {
        // The server spawned but failed to initialize/list — close it so we don't leak the child process.
        try {
          client?.close();
        } catch {
          /* already gone */
        }
        log(`mcp: ${spec.name} unavailable — skipped (${(e as Error).message})`);
        return undefined;
      }
    }),
  );

  const clients: McpClient[] = [];
  const tools: ToolDefinition[] = [];
  const seen = new Set<string>(); // tool ids already claimed — a duplicate is skipped, never a crash
  for (const s of started) {
    if (!s) continue;
    let added = 0;
    for (const t of s.discovered) {
      const def = mcpToolToDefinition(s.spec.name, t, s.client);
      if (!def) continue;
      // Two tools that collapse to the same id (a same-server duplicate, or a server/tool name pair that
      // aliases another) must NOT reach the registry — register() throws on a dup and would abort the run.
      if (seen.has(def.manifest.name)) {
        log(`mcp: ${s.spec.name} tool ${def.manifest.name} duplicates an existing tool — skipped`);
        continue;
      }
      seen.add(def.manifest.name);
      tools.push(def);
      added += 1;
    }
    clients.push(s.client);
    log(`mcp: ${s.spec.name} → ${added} tool(s)`);
  }

  return {
    tools,
    close: () => {
      for (const c of clients) {
        try {
          c.close();
        } catch {
          /* already gone */
        }
      }
    },
  };
}
