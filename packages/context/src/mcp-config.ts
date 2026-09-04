import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readTextCappedSafe } from "./fs-safe.js";

/**
 * A normalized MCP server spec — the single shape both the Claude `.mcp.json` dialect and the Codex
 * `config.toml [mcp_servers]` dialect reduce to, so a user's EXISTING setup (from either ecosystem) works on
 * Ambient models with no reconfiguration. Best-effort: a missing/malformed source contributes nothing.
 */
export interface McpServerSpec {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** project = a workspace file (higher trust surface — the CLI gates these before spawning). */
  source: "project" | "user";
}

/** Expand `${VAR}` from the environment inside a string (leaves an unset var as-is). */
function expand(s: string, env: Record<string, string | undefined>): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, k) => env[k] ?? whole);
}
function expandArgs(args: unknown, env: Record<string, string | undefined>): string[] | undefined {
  if (!Array.isArray(args)) return undefined;
  return args.filter((a): a is string => typeof a === "string").map((a) => expand(a, env));
}
function expandEnv(
  obj: unknown,
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out[k] = expand(v, env);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalize one raw server entry (either dialect) into a spec, or null if unusable. */
function toSpec(
  name: string,
  raw: unknown,
  source: "project" | "user",
  env: Record<string, string | undefined>,
): McpServerSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.enabled === false) return null;
  const url = typeof r.url === "string" ? expand(r.url, env) : undefined;
  const declared = typeof r.type === "string" ? r.type : undefined;
  const transport: McpServerSpec["transport"] =
    declared === "sse" ? "sse" : declared === "http" || url ? "http" : "stdio";
  if (transport === "stdio") {
    if (typeof r.command !== "string") return null;
    return {
      name,
      transport: "stdio",
      command: expand(r.command, env),
      ...(expandArgs(r.args, env) ? { args: expandArgs(r.args, env) } : {}),
      ...(expandEnv(r.env, env) ? { env: expandEnv(r.env, env) } : {}),
      source,
    };
  }
  return url ? { name, transport, url, source } : null;
}

/** A value shaped like a single server entry — it must carry a usable `command` or `url`. */
function looksLikeServerEntry(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.command === "string" || typeof o.url === "string";
}

/**
 * True when `mcpServers` is a WRAPPER (a map of named servers) rather than one server literally named
 * `mcpServers` in a bare file. The disambiguation is by the GRANDCHILDREN: a wrapper's values are themselves
 * server-entry objects; a bare server's values are its own fields (strings/booleans/arrays). This correctly
 * handles a wrapped config whose server is named `env`/`enabled`/… (values ARE server entries ⇒ wrapper) AND
 * a bare disabled `{mcpServers:{enabled:false}}` (value `false` is NOT a server entry ⇒ bare). (audit)
 */
function isWrapperMap(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const values = Object.values(v as Record<string, unknown>);
  return values.length > 0 && values.every(looksLikeServerEntry);
}

/** Read a Claude-style `.mcp.json` — accepts BOTH the wrapped `{mcpServers:{…}}` and the bare `{…}` shape. */
function readJsonServers(path: string, root: string): Record<string, unknown> {
  const text = readTextCappedSafe(path, { root }); // size-bounded + symlink-safe (leaf + ancestor)
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // Treat `mcpServers` as the wrapper ONLY when its VALUES are server entries — not when it is itself one
    // server named "mcpServers" in a bare file (which would otherwise swallow that entry + all its siblings).
    if (isWrapperMap(parsed.mcpServers)) return parsed.mcpServers as Record<string, unknown>;
    return parsed;
  } catch {
    return {};
  }
}

/** Read a Codex `config.toml`'s `[mcp_servers]` table. */
function readTomlServers(path: string, root: string): Record<string, unknown> {
  const text = readTextCappedSafe(path, { root }); // size-bounded + symlink-safe (leaf + ancestor)
  if (text === null) return {};
  try {
    const parsed = parseToml(text) as Record<string, unknown>;
    const t = parsed.mcp_servers;
    return t && typeof t === "object" ? (t as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Load MCP server specs from all supported locations. Precedence (a name seen first WINS): project
 * `.mcp.json` → project `.ambient/mcp.json` → `~/.claude.json` (mcpServers) → `~/.codex/config.toml`.
 */
export function loadMcpConfig(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): McpServerSpec[] {
  const sources: {
    path: string;
    read: (p: string, root: string) => Record<string, unknown>;
    source: "project" | "user";
    /** Containment root the config file's real parent must stay under (symlinked-ancestor guard). */
    root: string;
  }[] = [
    {
      path: join(workspaceRoot, ".mcp.json"),
      read: readJsonServers,
      source: "project",
      root: workspaceRoot,
    },
    {
      path: join(workspaceRoot, ".ambient", "mcp.json"),
      read: readJsonServers,
      source: "project",
      root: workspaceRoot,
    },
    { path: join(home, ".claude.json"), read: readJsonServers, source: "user", root: home },
    {
      path: join(home, ".codex", "config.toml"),
      read: readTomlServers,
      source: "user",
      root: home,
    },
  ];
  const byName = new Map<string, McpServerSpec>();
  const claimed = new Set<string>(); // names RESERVED by a higher-precedence file (even if disabled/malformed)
  for (const src of sources) {
    for (const [name, raw] of Object.entries(src.read(src.path, src.root))) {
      if (claimed.has(name) || !/^[a-zA-Z0-9_.-]+$/.test(name)) continue; // first-wins + safe names only
      if (!raw || typeof raw !== "object") continue; // scalar junk doesn't reserve a name for a lower file
      // A deliberate higher-precedence declaration claims the name even when disabled: a project
      // `docs:{enabled:false}` must suppress a lower-precedence global `docs` server.
      claimed.add(name);
      const spec = toSpec(name, raw, src.source, env);
      if (spec) byName.set(name, spec);
    }
  }
  return [...byName.values()];
}
