import { loadMcpConfig } from "@amb/context";
import type { ToolDefinition } from "@amb/protocol";
import { openBrowser } from "../commands/login.js";
import { makeMcpAuth, realFetch } from "../mcp-auth/auth-port.js";
import { signIn } from "../mcp-auth/oauth.js";
import { type TokenStore, makeTokenStore } from "../mcp-auth/token-store.js";
import {
  type ConnectOptions,
  type McpConnection,
  type McpServerStatus,
  connectMcp,
} from "./mcp-connect.js";

/** The session's MCP servers as the TUI sees them: live status, sign-in, and a reconnect after it. */
export interface McpControl {
  /** Each configured server and where it stands; undefined while the first connect is still running. */
  status(): McpServerStatus[] | undefined;
  /** Sign in to a server that uses OAuth, then reconnect so its tools arrive; resolves to what happened. */
  login(name: string, onUrl: (url: string) => void): Promise<string>;
  /** The tools connected right now. */
  tools(): ToolDefinition[];
  close(): void;
}

export function makeMcpControl(opts: {
  workspaceRoot: string;
  connect: Omit<ConnectOptions, "auth">;
  store?: TokenStore;
  connectImpl?: typeof connectMcp;
  signInImpl?: typeof signIn;
}): McpControl & { start(): Promise<void> } {
  const store = opts.store ?? makeTokenStore();
  const connect = opts.connectImpl ?? connectMcp;
  let current: McpConnection | undefined;
  let closed = false;

  const reconnect = async () => {
    const next = await connect(opts.workspaceRoot, { ...opts.connect, auth: makeMcpAuth(store) });
    if (closed) {
      next.close(); // the session ended while connecting — don't leak the servers
      return;
    }
    current?.close();
    current = next;
  };

  return {
    start: () => reconnect().catch(() => {}),
    status: () => current?.servers,
    tools: () => current?.tools ?? [],
    close() {
      closed = true;
      current?.close();
    },
    async login(name, onUrl) {
      const spec = loadMcpConfig(opts.workspaceRoot, process.env, undefined, {
        plugins: opts.connect.plugins === true,
      }).find((s) => s.name === name);
      if (!spec) return `No MCP server named "${name}". /mcp lists them.`;
      if (!spec.url) return `${name} runs on this machine and has no sign-in.`;
      try {
        await (opts.signInImpl ?? signIn)(spec.url, {
          fetch: realFetch,
          store,
          openBrowser,
          onUrl,
        });
      } catch (e) {
        return `Couldn't sign in to ${name}: ${(e as Error).message}`;
      }
      await reconnect().catch(() => {});
      const now = current?.servers.find((s) => s.name === name);
      return now?.state === "connected"
        ? `Signed in to ${name} · ${now.tools} tool${now.tools === 1 ? "" : "s"} ready.`
        : `Signed in to ${name}, but it didn't connect${now?.detail ? `: ${now.detail}` : ""}.`;
    },
  };
}

const STATE_LABEL: Record<McpServerStatus["state"], string> = {
  connected: "connected",
  "needs-sign-in": "needs sign-in",
  failed: "failed",
  skipped: "not started",
};

/** What `/mcp` shows. */
export function mcpReport(servers: McpServerStatus[] | undefined): string {
  if (servers === undefined) return "MCP servers are still connecting…";
  if (servers.length === 0) return "No MCP servers configured.";
  const w = Math.min(28, Math.max(...servers.map((s) => s.name.length)));
  const lines = servers.map((s) => {
    const what =
      s.state === "connected"
        ? `connected · ${s.tools} tool${s.tools === 1 ? "" : "s"}`
        : `${STATE_LABEL[s.state]}${s.detail ? ` · ${s.detail}` : ""}`;
    return `  ${s.name.padEnd(w)}  ${what}`;
  });
  const signIn = servers.filter((s) => s.state === "needs-sign-in").map((s) => s.name);
  return [
    `MCP servers (${servers.filter((s) => s.state === "connected").length} of ${servers.length} connected):`,
    ...lines,
    ...(signIn.length > 0 ? ["", `Sign in with /mcp login ${signIn[0]}`] : []),
  ].join("\n");
}
