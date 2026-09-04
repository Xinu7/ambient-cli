import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const MAX_SYMLINK_DEPTH = 40;

/**
 * Resolve a possibly-relative path against the workspace root and return a CANONICAL absolute path that
 * is guaranteed to stay inside the workspace — resolving EVERY symlink component (existing, intermediate,
 * chained, or dangling) and checking containment at each step. Throws on any escape.
 *
 * A lexical or one-level check is not enough: `a -> b -> /outside`, or a dangling intermediate symlink,
 * both escape a naive check. We walk root→target segment by segment; whenever a component is a symlink we
 * fully resolve its target (recursively) and re-verify containment before continuing.
 */
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  const rootReal = realpathSyncSafe(resolve(workspaceRoot));
  const abs = isAbsolute(p) ? resolve(p) : resolve(rootReal, p);
  if (!contains(rootReal, abs)) throw new Error(`path escapes the workspace: ${p}`);
  return resolveChecked(rootReal, abs, 0);
}

/**
 * Resolve `target` (assumed lexically inside `rootReal`) by walking its components from the root,
 * following symlinks and verifying containment at every step. Returns the canonical resolved path.
 */
function resolveChecked(rootReal: string, target: string, depth: number): string {
  if (depth > MAX_SYMLINK_DEPTH) throw new Error("symlink resolution too deep (possible loop)");
  const segments = relativeSegments(rootReal, target);
  let cur = rootReal;
  for (let i = 0; i < segments.length; i++) {
    const next = `${cur}${sep}${segments[i]}`;
    if (!contains(rootReal, next)) throw new Error(`path escapes the workspace: ${target}`);
    const link = symlinkTargetIfAny(next);
    if (link === undefined) {
      // Not a symlink (or does not exist yet). If it doesn't exist, the remaining segments can't be
      // symlinks either — append them lexically, re-checking containment, and finish.
      cur = next;
      if (!existsPath(next)) {
        for (let j = i + 1; j < segments.length; j++) {
          cur = `${cur}${sep}${segments[j]}`;
          if (!contains(rootReal, cur)) throw new Error(`path escapes the workspace: ${target}`);
        }
        return cur;
      }
    } else {
      const linkTarget = isAbsolute(link) ? link : resolve(cur, link);
      if (!contains(rootReal, linkTarget))
        throw new Error(`path escapes the workspace via a symlink: ${target}`);
      // Fully resolve the (possibly chained / dangling) link target, then continue from there.
      cur = resolveChecked(rootReal, linkTarget, depth + 1);
      if (!contains(rootReal, cur))
        throw new Error(`path escapes the workspace via a symlink: ${target}`);
    }
  }
  return cur;
  // NOTE: residual check/use TOCTOU remains (another process could swap a component to a symlink between
  // this resolution and the fs op). The local single-user CLI threat model accepts this; full closure
  // needs O_NOFOLLOW at open time (Phase 5).
}

/** Segments of `target` relative to `root` (target must be lexically inside root). */
function relativeSegments(root: string, target: string): string[] {
  if (target === root) return [];
  const withSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return target
    .slice(withSep.length)
    .split(sep)
    .filter((s) => s.length > 0 && s !== ".");
}

/** If `p` is a symlink (even dangling), return its raw link target; otherwise undefined. */
function symlinkTargetIfAny(p: string): string | undefined {
  try {
    if (lstatSync(p).isSymbolicLink()) return readlinkSync(p);
  } catch {
    // does not exist — not a symlink
  }
  return undefined;
}

function existsPath(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function contains(root: string, target: string): boolean {
  const withSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(withSep);
}

function realpathSyncSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
