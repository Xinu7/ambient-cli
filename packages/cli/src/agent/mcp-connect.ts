import { type McpServerSpec, loadMcpConfig } from "@amb/context";
import { startMcpServers } from "@amb/mcp";
import type { ToolDefinition } from "@amb/protocol";

export interface McpConnection {
  tools: ToolDefinition[];
  close: () => void;
  notices: string[];
}

export interface ConnectOptions {
  approveServer?: (s: McpServerSpec) => Promise<boolean>;
  /** Test seams — default to the real config loader + server starter. */
  load?: () => McpServerSpec[];
  start?: typeof startMcpServers;
}

/**
 * Connect the user's configured MCP servers (Claude `.mcp.json` + Codex `config.toml` + project
 * `.ambient/mcp.json`) and return their tools for the registry. v1 is stdio-only (remote transports are
 * skipped with a notice). A PROJECT-scoped server is a process-spawn/secret surface, so it only starts when
 * `approveServer` says yes; user-scoped servers (the user's own global config) start automatically. A server
 * that fails to start is skipped, never fatal. Returns `{tools:[], close, notices}` when nothing is configured.
 */
export async function connectMcp(
  workspaceRoot: string,
  opts: ConnectOptions = {},
): Promise<McpConnection> {
  const specs = opts.load ? opts.load() : loadMcpConfig(workspaceRoot);
  if (specs.length === 0) return { tools: [], close: () => {}, notices: [] };

  const notices: string[] = [];
  const usable: McpServerSpec[] = [];
  for (const s of specs) {
    // stdio (local child) + http/sse (remote Streamable-HTTP) are supported; only a truly-unknown transport skips.
    if (s.transport !== "stdio" && s.transport !== "http" && s.transport !== "sse") {
      notices.push(`mcp: ${s.name} uses ${s.transport} — transport not supported (skipped)`);
      continue;
    }
    if ((s.transport === "http" || s.transport === "sse") && !s.url) {
      notices.push(`mcp: ${s.name} is remote but has no url (skipped)`);
      continue;
    }
    // A PROJECT-scoped server (a workspace file, higher trust surface — a local process OR remote data egress)
    // starts only with an explicit approval. Fail CLOSED: no approver ⇒ not approved.
    if (s.source === "project" && !(opts.approveServer && (await opts.approveServer(s)))) {
      notices.push(`mcp: ${s.name} (project-scoped) not approved — skipped`);
      continue;
    }
    usable.push(s);
  }
  if (usable.length === 0) return { tools: [], close: () => {}, notices };

  const start = opts.start ?? startMcpServers;
  const session = await start(
    usable.map((s) => ({
      name: s.name,
      config:
        s.transport === "stdio"
          ? {
              command: s.command as string,
              ...(s.args ? { args: s.args } : {}),
              ...(s.env ? { env: s.env } : {}),
            }
          : { url: s.url as string },
    })),
    { onLog: (m) => notices.push(m) },
  );
  return { tools: session.tools, close: session.close, notices };
}
