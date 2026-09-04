import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTextCappedSafe } from "./fs-safe.js";

/**
 * Instruction-file discovery (Claude-Code pattern). Walk up from cwd to the repo root,
 * collecting project instruction files in precedence order, deduping identical content, and bounding
 * total size so project rules never blow the token budget.
 */

// AGENTS.md is the OPEN standard (primary); CLAUDE.md/.clinerules/.goosehints are migrator-compat aliases so
// existing repos work day one (don't invent a proprietary name). AMBIENT.md is our own opt-in.
export const INSTRUCTION_FILENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".clinerules",
  ".goosehints",
  "AMB.md",
  "AMBIENT.md",
  ".ambient/AMBIENT.md",
] as const;
export const MAX_PER_FILE = 4_000;
export const MAX_TOTAL = 12_000;

function isRepoRoot(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Directories from cwd up to (and including) the repo root, or the filesystem root if none. */
export function ancestorDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let cur = cwd;
  for (;;) {
    dirs.push(cur);
    if (isRepoRoot(cur)) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

export interface LoadedInstructions {
  text: string;
  sources: string[];
}

/** Load + concatenate instruction files (nearest dir first), deduped and budget-bounded. */
export function loadInstructions(cwd: string): LoadedInstructions {
  const seen = new Set<string>();
  const chunks: string[] = [];
  const sources: string[] = [];
  let total = 0;

  for (const dir of ancestorDirs(cwd)) {
    for (const name of INSTRUCTION_FILENAMES) {
      const path = join(dir, name);
      // Route through the SAME symlink-safe, size-capped reader every other loader uses (fs-safe): an
      // instruction file is repo-committable and flows into the SYSTEM prompt, so a committed symlink
      // `CLAUDE.md -> ~/.ssh/id_rsa` must NOT be followed (secret exfil) and a giant file must be bounded
      // BEFORE it's read whole. Returns null for missing/symlinked-leaf/oversized/dir/denied.
      const content = readTextCappedSafe(path, { root: dir });
      if (content === null) continue;
      const trimmed = content.trim();
      if (!trimmed) continue;
      const key = trimmed.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      const bounded =
        trimmed.length > MAX_PER_FILE ? `${trimmed.slice(0, MAX_PER_FILE)}\n…(truncated)` : trimmed;
      if (total + bounded.length > MAX_TOTAL) break;
      total += bounded.length;
      chunks.push(`# From ${name}\n${bounded}`);
      sources.push(path);
    }
    if (total >= MAX_TOTAL) break;
  }

  return { text: chunks.join("\n\n"), sources };
}
