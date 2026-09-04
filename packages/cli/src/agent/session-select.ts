import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSession, sessionsDir, turnCount } from "@amb/sessions";

/**
 * Resolve a session id from a user argument. `"latest"` (or empty) picks the most-recently-modified session
 * that actually has a user turn; anything else must match an existing session id exactly. Shared by
 * `amb resume` and `amb rewind`. Returns undefined when nothing matches.
 */
export function resolveSessionId(idOrLatest: string): string | undefined {
  const dir = sessionsDir();
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.replace(/\.jsonl$/, ""), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (idOrLatest && idOrLatest !== "latest") return files.find((f) => f.id === idOrLatest)?.id;
  for (const f of files) {
    if (turnCount(readSession(f.id).events) > 0) return f.id;
  }
  return undefined;
}
