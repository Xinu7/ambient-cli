import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTextCappedSafe } from "./fs-safe.js";

/**
 * Project memory — a Claude-Code-style `.ambient/MEMORY.md` at the workspace root that COMPOUNDS across
 * sessions. The agent reads it at the start of every run (durable context: goal / decisions / files / next
 * steps), and rewrites it from the structured summary whenever context is compacted. Best-effort: any I/O
 * failure is swallowed (memory is an optimization, never load-bearing).
 */

/** Ambient memory lives under `.ambient/` (matches the `ambient` command), NOT `.amb/`. */
export function memoryPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".ambient", "MEMORY.md");
}

/** Read the project memory (or undefined if none / unreadable). Symlink-safe + size-capped: MEMORY.md flows
 *  into the SYSTEM prompt, so a `.ambient/MEMORY.md` symlinked at a secret must not be followed, and a giant
 *  file must be bounded before it's read whole (fs-safe — parity with every other loader). */
export function readMemory(workspaceRoot: string): string | undefined {
  const text = readTextCappedSafe(memoryPath(workspaceRoot), {
    root: join(workspaceRoot, ".ambient"),
  })?.trim();
  return text && text.length > 0 ? text : undefined;
}

const MEMORY_HEADER = [
  "# Ambient memory",
  "",
  "> Auto-maintained across sessions from context compaction. The agent reads this at the start of each",
  "> run as durable project context. Treat it as notes to re-verify with tools, not ground truth.",
  "",
  "",
].join("\n");

/** The durable, model-curated section (written by the `remember` tool) — PRESERVED across the auto-summary
 *  overwrites so a deliberate note compounds across sessions instead of being erased on the next compaction. */
const NOTES_HEADER = "## Notes (curated by the agent — durable across sessions)";
const MAX_NOTES = 100;

/** Extract the curated Notes block (from its header to EOF), or "" if none. */
function extractNotes(content: string): string {
  const i = content.indexOf(NOTES_HEADER);
  return i >= 0 ? content.slice(i).trimEnd() : "";
}

/**
 * Rewrite the auto-summary portion of project memory from the latest structured summary, PRESERVING the
 * curated Notes section (writeMemory used to blank-overwrite, erasing deliberate notes). Best-effort.
 */
export function writeMemory(workspaceRoot: string, summary: string): void {
  const body = summary.trim();
  if (body.length === 0) return;
  try {
    const p = memoryPath(workspaceRoot);
    const notes = existsSync(p) ? extractNotes(readFileSync(p, "utf8")) : "";
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${MEMORY_HEADER}${body}\n${notes ? `\n${notes}\n` : ""}`, "utf8");
  } catch {
    // best-effort — memory is never load-bearing
  }
}

/**
 * Append a deliberate durable note to the curated Notes section (the `remember` tool). Merge-preserving: it
 * keeps the auto-summary above and the last MAX_NOTES bullets, so notes compound across sessions and can't
 * be wiped by the next compaction's writeMemory. Bounded + best-effort. Returns whether it recorded anything.
 */
export function rememberNote(workspaceRoot: string, note: string): boolean {
  const clean = note.replace(/\s+/g, " ").trim().slice(0, 500);
  if (clean.length === 0) return false;
  try {
    const p = memoryPath(workspaceRoot);
    const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
    const idx = existing.indexOf(NOTES_HEADER);
    const above = (idx >= 0 ? existing.slice(0, idx) : existing).trimEnd();
    const priorBullets = (idx >= 0 ? existing.slice(idx) : "")
      .split("\n")
      .filter((l) => l.startsWith("- "));
    const bullets = [...priorBullets, `- ${clean}`].slice(-MAX_NOTES);
    const head = above.length > 0 ? above : MEMORY_HEADER.trimEnd();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${head}\n\n${NOTES_HEADER}\n${bullets.join("\n")}\n`, "utf8");
    return true;
  } catch {
    return false; // best-effort — memory is never load-bearing
  }
}
