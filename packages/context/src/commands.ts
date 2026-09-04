import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_DIR_ENTRIES, isRealDir, isRealFile, readTextCappedSafe } from "./fs-safe.js";

/**
 * Discover reusable SLASH COMMANDS from a user's existing Claude Code (`.claude/commands/**.md`) and Codex
 * (`~/.codex/prompts/*.md`) setups, plus ambient's `.ambient/commands`. Name = filename (subdirs namespace
 * `foo/bar.md → foo:bar`); optional frontmatter {description, argument-hint}; body = the prompt template with
 * `$1..$9` / `$ARGUMENTS` placeholders. Best-effort. SECURITY: the body is a template only — `!`cmd`` and
 * `@file` are NOT auto-expanded here (opt-in at the call site).
 */
export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  /** The prompt template (frontmatter stripped). */
  body: string;
  source: "project" | "user";
}

const MAX_BODY = 20_000;

function parse(name: string, text: string, source: "project" | "user"): SlashCommand {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const front = m ? (m[1] ?? "") : "";
  const body = (m ? (m[2] ?? "") : text).trim();
  const field = (key: string): string | undefined => {
    const fm = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return fm ? fm[1]?.trim().replace(/^["']|["']$/g, "") : undefined;
  };
  // When there's no frontmatter `description`, summarise from the body — so the palette shows what a command
  // DOES, not a generic "custom command" label. Prefer the first prose sentence (usually the real summary,
  // e.g. under a `# Title`); fall back to the heading title itself.
  const descFromBody = (): string | undefined => {
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          !l.startsWith("<") &&
          !l.startsWith("---") &&
          !l.startsWith("```") &&
          l !== "$ARGUMENTS",
      );
    const prose = lines.find((l) => !l.startsWith("#") && !l.startsWith("$"));
    const heading = lines.find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "");
    const pick = prose ?? heading;
    if (!pick) return undefined;
    const flat = pick.replace(/\s+/g, " ").replace(/[*_`]/g, "").trim();
    return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
  };
  const description = field("description") ?? descFromBody();
  return {
    name,
    ...(description ? { description } : {}),
    ...(field("argument-hint") ? { argumentHint: field("argument-hint") } : {}),
    body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
    source,
  };
}

function walk(dir: string, prefix: string, depth: number): { rel: string; full: string }[] {
  if (depth > 4 || !isRealDir(dir)) return [];
  const out: { rel: string; full: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  // `isRealDir`/`isRealFile` use lstat, so a symlinked entry is NEITHER a real dir nor a real file → skipped.
  // A committed `cmd.md -> ~/.ssh/id_rsa` can therefore never be walked into or read (exfiltration guard).
  for (const e of entries.slice(0, MAX_DIR_ENTRIES)) {
    const full = join(dir, e);
    if (isRealDir(full)) out.push(...walk(full, `${prefix}${e}:`, depth + 1));
    else if (e.endsWith(".md") && isRealFile(full))
      out.push({ rel: `${prefix}${e.replace(/\.md$/, "")}`, full });
  }
  return out;
}

/** Discover slash commands across roots (precedence: Claude project/user → Codex → ambient), first-wins. */
export function discoverCommands(workspaceRoot: string, home: string = homedir()): SlashCommand[] {
  const roots: { dir: string; source: "project" | "user" }[] = [
    { dir: join(workspaceRoot, ".claude", "commands"), source: "project" },
    { dir: join(home, ".claude", "commands"), source: "user" },
    { dir: join(workspaceRoot, ".codex", "prompts"), source: "project" },
    { dir: join(home, ".codex", "prompts"), source: "user" },
    { dir: join(workspaceRoot, ".ambient", "commands"), source: "project" },
  ];
  const byName = new Map<string, SlashCommand>();
  for (const { dir, source } of roots) {
    for (const { rel, full } of walk(dir, "", 0)) {
      if (byName.has(rel) || !/^[a-zA-Z0-9_.:-]+$/.test(rel)) continue;
      // no symlink follow (leaf or ancestor), contained under the command root, size-bounded, no giant read
      const text = readTextCappedSafe(full, { root: dir });
      if (text === null) continue;
      byName.set(rel, parse(rel, text, source));
    }
  }
  return [...byName.values()];
}

/**
 * Substitute `$1..$9` and `$ARGUMENTS` in a command body from the user's argument tokens. ONE pass with a
 * callback, so a substituted value is inserted LITERALLY — an argument like `$&` or `$2` is never re-read as
 * a replacement metacharacter and `$ARGUMENTS` is never expanded a second time.
 */
export function expandCommand(body: string, args: string[]): string {
  return body.replace(/\$ARGUMENTS\b|\$([1-9])\b/g, (_m, digit?: string) =>
    digit ? (args[Number(digit) - 1] ?? "") : args.join(" "),
  );
}
