import { posix, win32 } from "node:path";
import type { PermissionDecision, PermissionInput } from "@amb/protocol";
import { hasUnmodeledExpansion } from "./read-only-command.js";
import { parseShellCommands } from "./shell-tokens.js";

/**
 * Permission rules in Claude Code's syntax — `Bash(npm test:*)`, `Read(./secrets/**)`, `Edit(src/**)`,
 * `WebFetch(domain:example.com)`, `mcp__github`, or a bare tool name — layered over the mode ladder:
 *
 *   - a `deny` rule refuses the call in every mode (bypass included);
 *   - an `ask` rule makes the call ask even where it would run on its own (a denial stays a denial);
 *   - an `allow` rule answers a question the mode would have asked — it never lifts a denial (plan mode, the
 *     workspace boundary) and never overrides a deny or ask rule.
 */

export interface PermissionRule {
  /** The rule as written, for messages and listings. */
  text: string;
  /** Lower-cased tool name as written (`bash`, `read`, `mcp__github__search`). */
  tool: string;
  /** What's inside the parentheses, if anything. */
  specifier?: string;
}

export interface PermissionRules {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
}

export const NO_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

/** `Tool` or `Tool(specifier)`; anything else is not a rule. */
export function parseRule(text: string): PermissionRule | null {
  const t = text.trim();
  const m = /^([A-Za-z_][\w.-]*)(?:\((.*)\))?$/s.exec(t);
  if (!m?.[1]) return null;
  const specifier = m[2]?.trim();
  return {
    text: t,
    tool: m[1].toLowerCase(),
    ...(specifier && specifier !== "*" ? { specifier } : {}),
  };
}

export function parseRules(texts: readonly unknown[] | undefined): PermissionRule[] {
  return (texts ?? [])
    .filter((t): t is string => typeof t === "string")
    .map(parseRule)
    .filter((r): r is PermissionRule => r !== null);
}

/** Which ambient tools a rule's tool name covers (Claude's names cover every tool of that kind). */
const TOOL_ALIASES: Record<string, readonly string[]> = {
  bash: ["bash"],
  read: ["read", "grep", "glob", "list", "read_artifact"],
  grep: ["grep"],
  glob: ["glob"],
  ls: ["list"],
  list: ["list"],
  edit: ["edit", "apply_patch", "write"],
  multiedit: ["apply_patch"],
  apply_patch: ["apply_patch"],
  write: ["write"],
  notebookedit: ["notebook_edit"],
  webfetch: ["web_fetch"],
  web_fetch: ["web_fetch"],
  websearch: ["web_search"],
  web_search: ["web_search"],
  task: ["subagent"],
  agent: ["subagent"],
  subagent: ["subagent"],
};

function coversTool(rule: PermissionRule, toolName: string): boolean {
  const tool = toolName.toLowerCase();
  if (rule.tool.startsWith("mcp__")) {
    // `mcp__server` covers every tool of that server; `mcp__server__tool` just that one.
    return tool === rule.tool || tool.startsWith(`${rule.tool}__`);
  }
  return (TOOL_ALIASES[rule.tool] ?? [rule.tool]).includes(tool);
}

/** A glob (`*` within a path segment, `**` across segments, `?` one character) as a RegExp. */
function globToRegExp(glob: string, caseInsensitive: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, caseInsensitive ? "i" : "");
}

const toSlash = (p: string) => p.replace(/\\/g, "/");

/** Where a path pattern points: `//abs`, `~/in-home`, `/project-relative`, or relative to the project. */
function anchorPattern(pattern: string, root: string, home: string): string {
  const p = toSlash(pattern);
  const r = toSlash(root).replace(/\/+$/, "");
  if (p.startsWith("//")) return p.slice(1);
  if (/^[A-Za-z]:\//.test(p)) return p;
  if (p === "~" || p.startsWith("~/")) return `${toSlash(home).replace(/\/+$/, "")}${p.slice(1)}`;
  if (p.startsWith("/")) return `${r}${p}`;
  return `${r}/${p.replace(/^\.\//, "")}`;
}

/** A path matches a pattern when it, or a folder it's inside, does (so `./secrets` covers what's in it). */
function pathMatches(pattern: string, path: string, root: string, home: string): boolean {
  const insensitive = /^[A-Za-z]:/.test(root) || process.platform === "win32";
  const re = globToRegExp(anchorPattern(pattern, root, home), insensitive);
  const norm = toSlash(/^[A-Za-z]:/.test(path) ? win32.normalize(path) : posix.normalize(path));
  let p = norm.replace(/\/+$/, "");
  while (p) {
    if (re.test(p)) return true;
    const cut = p.lastIndexOf("/");
    if (cut <= 0) break;
    p = p.slice(0, cut);
  }
  return false;
}

/** The simple commands a shell line runs, each as its quote-stripped words joined by spaces. */
export function shellSegments(command: string): string[] {
  return parseShellCommands(command)
    .map((c) => c.argv.join(" ").trim())
    .filter(Boolean);
}

/** Whether a command redirects input or output (`>`, `<`, `>>`, `2>`) outside quotes — an allow rule for the
 *  command itself must not also cover writing wherever the redirection points. */
export function hasRedirection(command: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"') i++;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === ">" || c === "<") return true;
  }
  return false;
}

/** `npm test:*` = the command or anything starting with it; otherwise `*` wildcards over the whole command. */
function commandMatches(spec: string, segment: string): boolean {
  if (spec.endsWith(":*")) {
    const prefix = spec.slice(0, -2).trim();
    return segment === prefix || segment.startsWith(`${prefix} `);
  }
  if (!spec.includes("*")) return segment === spec.trim();
  const re = spec
    .trim()
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`, "s").test(segment);
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export interface RuleCall {
  toolName: string;
  args: Record<string, unknown>;
  /** Absolute paths the call touches. */
  resources: readonly string[];
  workspaceRoot: string;
  home: string;
}

/**
 * Whether a rule covers a call. `mode` decides how a compound shell line is judged: a deny or ask rule
 * covers it when ANY part matches; an allow rule only when EVERY part does (so `Bash(npm test:*)` never lets
 * `npm test && rm -rf ~` through) and nothing is hidden in a substitution or redirection.
 */
export function ruleCovers(rule: PermissionRule, call: RuleCall, mode: "any" | "all"): boolean {
  if (!coversTool(rule, call.toolName)) return false;
  const spec = rule.specifier;
  if (spec === undefined) return true;
  const tool = call.toolName.toLowerCase();
  if (tool === "bash") {
    const command = typeof call.args.command === "string" ? call.args.command : "";
    const parts = shellSegments(command);
    if (parts.length === 0) return false;
    if (mode === "all") {
      return (
        !hasUnmodeledExpansion(command) &&
        !hasRedirection(command) &&
        parts.every((p) => commandMatches(spec, p))
      );
    }
    return commandMatches(spec, command.trim()) || parts.some((p) => commandMatches(spec, p));
  }
  if (tool === "web_fetch") {
    const host = hostOf(call.args.url);
    const m = /^domain:(.+)$/i.exec(spec);
    if (!host || !m?.[1]) return false;
    const domain = m[1].trim().toLowerCase().replace(/^\*\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  }
  // File tools: the specifier is a path pattern checked against every path the call touches.
  if (call.resources.length === 0) return false;
  const test = (p: string) => pathMatches(spec, p, call.workspaceRoot, call.home);
  return mode === "all" ? call.resources.every(test) : call.resources.some(test);
}

/** Apply the rules to the mode's decision. */
export function applyRules(
  base: PermissionDecision,
  rules: PermissionRules,
  input: PermissionInput,
  home: string,
): PermissionDecision {
  const call: RuleCall = {
    toolName: input.toolName,
    args: input.normalizedArgs,
    resources: input.resolvedResources,
    workspaceRoot: input.workspaceRoot,
    home,
  };
  const denied = rules.deny.find((r) => ruleCovers(r, call, "any"));
  if (denied) return { effect: "deny", reason: `your rule ${denied.text}` };
  const asked = rules.ask.find((r) => ruleCovers(r, call, "any"));
  if (asked) {
    return base.effect === "deny"
      ? base
      : { effect: "ask", reason: `your rule ${asked.text} asks first` };
  }
  if (base.effect === "ask") {
    const allowed = rules.allow.find((r) => ruleCovers(r, call, "all"));
    if (allowed) return { effect: "allow", reason: `allowed by your rule ${allowed.text}` };
  }
  return base;
}
