import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_DIR_ENTRIES, isRealDir, readTextCappedSafe } from "./fs-safe.js";

/**
 * Discover reusable SUBAGENT presets from a user's existing Claude Code setup (`.claude/agents/*.md`) plus
 * ambient's own `.ambient/agents/`. Each file = frontmatter {name, description, tools?, model?} + a body that
 * becomes the child's system prompt. The name/description are UNTRUSTED (flattened+bounded before use);
 * tool + model names are mapped onto ambient equivalents. Best-effort — a bad file is skipped.
 */
export interface AgentPreset {
  name: string;
  description: string;
  /** The system-prompt body for the subagent. */
  body: string;
  /** Ambient tool names this preset restricts the child to (empty ⇒ role default). */
  tools?: string[];
  /** Ambient model id (or "auto"). */
  model?: string;
}

const CLAUDE_TO_AMBIENT_TOOL: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Grep: "grep",
  Glob: "glob",
  Bash: "bash",
  WebFetch: "web_fetch",
  Task: "subagent",
};

function flatten(s: string, max: number): string {
  const f = s
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return f.length > max ? `${f.slice(0, max - 1)}…` : f;
}

function mapModel(m: string | undefined): string | undefined {
  if (!m) return undefined;
  const lower = m.toLowerCase();
  if (lower === "inherit") return undefined;
  // Claude tiers map to "auto" (Ambient auto-picks its best model); an explicit HF-style id passes through.
  if (["opus", "sonnet", "haiku"].includes(lower)) return "auto";
  return m;
}

function parseAgent(text: string): AgentPreset | null {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const front = m[1] ?? "";
  const body = (m[2] ?? "").trim();
  const field = (key: string): string | undefined => {
    const fm = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return fm ? fm[1]?.trim().replace(/^["']|["']$/g, "") : undefined;
  };
  const name = field("name");
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) return null;
  const toolsRaw = field("tools");
  const tools = toolsRaw
    ? toolsRaw
        .split(",")
        .map((t) => CLAUDE_TO_AMBIENT_TOOL[t.trim()] ?? t.trim().toLowerCase())
        .filter((t) => t.length > 0)
    : undefined;
  return {
    name,
    description: flatten(field("description") ?? name, 200),
    body: body.length > 16_000 ? body.slice(0, 16_000) : body,
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(mapModel(field("model")) ? { model: mapModel(field("model")) } : {}),
  };
}

/** Discover agent presets across roots (project > user), first-wins by name. */
export function discoverAgents(workspaceRoot: string, home: string = homedir()): AgentPreset[] {
  const roots = [
    join(workspaceRoot, ".ambient", "agents"),
    join(workspaceRoot, ".claude", "agents"),
    join(home, ".claude", "agents"),
  ];
  const byName = new Map<string, AgentPreset>();
  for (const dir of roots) {
    if (!isRealDir(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .slice(0, MAX_DIR_ENTRIES);
    } catch {
      continue;
    }
    for (const f of files) {
      // no symlink follow (leaf or ancestor), contained under the agents root, size-bounded
      const text = readTextCappedSafe(join(dir, f), { root: dir });
      if (text === null) continue;
      const preset = parseAgent(text);
      if (preset && !byName.has(preset.name)) byName.set(preset.name, preset);
    }
  }
  return [...byName.values()];
}
