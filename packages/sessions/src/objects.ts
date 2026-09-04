import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeSessionId, sessionsDir } from "./paths.js";

/**
 * A per-session content-addressed blob store — the substrate for `amb rewind`. Each mutating tool saves a
 * file's PRE-image here before overwriting it; the durable event log already records that content's hash
 * (preimageHash), so rewinding a session = look up each event's preimageHash → restore the blob. Keyed by
 * the SAME `sha256:<hex>` the tools compute, so an event's hash addresses its blob directly.
 *
 * Content-addressed ⇒ writing the same content twice is idempotent (dedup), and a blob is immutable.
 */

/** The hash the tools + event log use (must match tools-core `sha256`): `sha256:<hex>`. */
export function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** The per-session objects directory (sibling of the session's JSONL). */
export function objectsDir(sessionId: string, env?: Record<string, string | undefined>): string {
  assertSafeSessionId(sessionId);
  return join(sessionsDir(env), `${sessionId}.objects`);
}

/** A `sha256:<hex>` key → its on-disk filename (drop the colon so it's a safe single component). */
function blobFile(dir: string, hashKey: string): string {
  const hex = hashKey.startsWith("sha256:") ? hashKey.slice("sha256:".length) : hashKey;
  if (!/^[0-9a-f]{64}$/.test(hex))
    throw new Error(`invalid content hash ${JSON.stringify(hashKey)}`);
  return join(dir, hex);
}

/** Save a blob (idempotent). Returns its `sha256:<hex>` key — identical to the tools' preimageHash. */
export function saveObject(
  sessionId: string,
  content: string,
  env?: Record<string, string | undefined>,
): string {
  const key = contentHash(content);
  const dir = objectsDir(sessionId, env);
  const file = blobFile(dir, key);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  return key;
}

/** Read a blob by its `sha256:<hex>` key, or undefined if absent (e.g. never checkpointed). */
export function readObject(
  sessionId: string,
  hashKey: string,
  env?: Record<string, string | undefined>,
): string | undefined {
  try {
    return readFileSync(blobFile(objectsDir(sessionId, env), hashKey), "utf8");
  } catch {
    return undefined;
  }
}
