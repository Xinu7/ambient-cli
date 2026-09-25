import { type McpServerSpec, loadMcpConfig } from "@amb/context";
import { McpHttpError, startMcpServers } from "@amb/mcp";
import type { ToolDefinition } from "@amb/protocol";

/** Where a configured server stands after connecting. */
export interface McpServerStatus {
  name: string;
  source: McpServerSpec["source"];
  transport: McpServerSpec["transport"];
  state: "connected" | "needs-sign-in" | "failed" | "skipped";
  tools: number;
  detail?: string;
}

export interface McpConnection {
  tools: ToolDefinition[];
  close: () => void;
  notices: string[];
  servers: McpServerStatus[];
}

/** Sign-in for remote servers: a stored access token to send, and a refreshed one after a 401. */
export interface McpAuthPort {
  token(url: string): Promise<string | undefined>;
  refresh(url: string): Promise<string | undefined>;
}

export interface ConnectOptions {
  approveServer?: (s: McpServerSpec) => Promise<boolean>;
  /** Also connect enabled Claude Code plugins' servers (config `claudeSettings`). */
  plugins?: boolean;
  /** Stored sign-ins for servers that use OAuth. */
  auth?: McpAuthPort;
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
  const specs = opts.load
    ? opts.load()
    : loadMcpConfig(workspaceRoot, process.env, undefined, { plugins: opts.plugins === true });
  if (specs.length === 0) return { tools: [], close: () => {}, notices: [], servers: [] };

  const notices: string[] = [];
  const usable: McpServerSpec[] = [];
  const statuses = new Map<string, McpServerStatus>();
  const status = (s: McpServerSpec, state: McpServerStatus["state"], detail?: string) =>
    statuses.set(s.name, { ...baseStatus(s), state, tools: 0, ...(detail ? { detail } : {}) });
  for (const s of specs) {
    // stdio (local child) + http/sse (remote Streamable-HTTP) are supported; only a truly-unknown transport skips.
    if (s.transport !== "stdio" && s.transport !== "http" && s.transport !== "sse") {
      notices.push(`mcp: ${s.name} uses ${s.transport} — transport not supported (skipped)`);
      status(s, "skipped", "transport not supported");
      continue;
    }
    if ((s.transport === "http" || s.transport === "sse") && !s.url) {
      notices.push(`mcp: ${s.name} is remote but has no url (skipped)`);
      status(s, "skipped", "no url");
      continue;
    }
    if (s.missingEnv && s.missingEnv.length > 0) {
      notices.push(
        `mcp: ${s.name} needs ${s.missingEnv.join(", ")} set in your environment (skipped)`,
      );
      status(s, "skipped", `needs ${s.missingEnv.join(", ")}`);
      continue;
    }
    // A PROJECT-scoped server (a workspace file, higher trust surface — a local process OR remote data egress)
    // starts only with an explicit approval. Fail CLOSED: no approver ⇒ not approved.
    if (s.source === "project" && !(opts.approveServer && (await opts.approveServer(s)))) {
      notices.push(`mcp: ${s.name} (project-scoped) not approved — skipped`);
      status(s, "skipped", "project not trusted yet (/trust)");
      continue;
    }
    usable.push(s);
  }
  const ordered = (): McpServerStatus[] =>
    specs.map((s) => statuses.get(s.name)).filter((x): x is McpServerStatus => x !== undefined);
  if (usable.length === 0) return { tools: [], close: () => {}, notices, servers: ordered() };

  const auth = opts.auth;
  const configs = await Promise.all(
    usable.map(async (s) => {
      if (s.transport === "stdio") {
        return {
          name: s.name,
          config: {
            command: s.command as string,
            ...(s.args ? { args: s.args } : {}),
            ...(s.env ? { env: s.env } : {}),
          },
        };
      }
      const url = s.url as string;
      // A server you've signed in to gets its token, unless the config already sends its own credentials.
      const hasAuth = Object.keys(s.headers ?? {}).some((k) => k.toLowerCase() === "authorization");
      const token = !hasAuth && auth ? await auth.token(url) : undefined;
      const headers = { ...s.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      return {
        name: s.name,
        config: {
          url,
          ...(s.transport === "sse" ? { legacySse: true } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(!hasAuth && auth ? { reauthorize: () => auth.refresh(url) } : {}),
        },
      };
    }),
  );

  const start = opts.start ?? startMcpServers;
  const session = await start(configs, {
    onLog: (m) => {
      // A server that wants a sign-in gets its own, actionable notice (below) instead of the raw failure.
      if (!/needs you to sign in/.test(m)) notices.push(m);
    },
  });
  const specByName = new Map(usable.map((s) => [s.name, s]));
  for (const out of session.servers ?? []) {
    const spec = specByName.get(out.name);
    if (!spec) continue;
    if (out.ok) {
      statuses.set(out.name, { ...baseStatus(spec), state: "connected", tools: out.tools });
    } else if (out.error instanceof McpHttpError && out.error.status === 401) {
      notices.push(`mcp: ${out.name} needs you to sign in — ambient mcp login ${out.name}`);
      statuses.set(out.name, { ...baseStatus(spec), state: "needs-sign-in", tools: 0 });
    } else {
      statuses.set(out.name, {
        ...baseStatus(spec),
        state: "failed",
        tools: 0,
        ...(out.error ? { detail: out.error.message } : {}),
      });
    }
  }
  return { tools: session.tools, close: session.close, notices, servers: ordered() };
}

function baseStatus(s: McpServerSpec): Omit<McpServerStatus, "state" | "tools"> {
  return { name: s.name, source: s.source, transport: s.transport };
}
