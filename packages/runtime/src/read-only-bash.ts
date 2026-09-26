import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { classifyToolRisk, isWithinWorkspace, parseShellCommands } from "@amb/permissions";

/**
 * The checks that need the disk, for a shell command the classifier already judged read-only (so it runs
 * without asking, even in plan mode). The classifier only sees text; this confirms the command also:
 *  - reads nothing outside the workspace (`cat /Users/me/.aws/credentials` asks like any outside read),
 *  - reads nothing your Read deny rules cover (`cat .env` with `Read(./.env)` denied),
 *  - touches no credential file (the risk check's own list),
 *  - isn't a git command in a repository whose config names a program git would run on its own
 *    (`core.fsmonitor`, `diff.external`, a textconv or diff driver, a filter) — a cloned repository with
 *    its `.git` folder can set those.
 * Anything it can't confirm keeps the command's full effects, so it asks.
 */
export function readOnlyBashHolds(
  command: string,
  ctx: { workspaceRoot: string; readDenied?: (absPath: string) => boolean },
): boolean {
  if (classifyToolRisk("bash", { command }).level !== "none") return false;
  const root = ctx.workspaceRoot;
  for (const seg of parseShellCommands(command)) {
    for (const word of seg.argv.slice(1)) {
      let value = word;
      if (word.startsWith("-")) {
        // A plain flag names no file; an option's value can (`--file=/etc/x`).
        const eq = word.indexOf("=");
        if (eq < 0) continue;
        value = word.slice(eq + 1);
      }
      if (value && !readsWithinWorkspace(value, root, ctx.readDenied)) return false;
    }
    if (seg.argv[0]?.split("/").pop() === "git" && gitRunsConfiguredPrograms(root)) return false;
  }
  return true;
}

/** False when `word`, read as a path, names something outside the workspace or something you denied. */
function readsWithinWorkspace(
  word: string,
  root: string,
  readDenied?: (absPath: string) => boolean,
): boolean {
  const abs = resolve(root, word);
  // Nothing there to read: a search pattern (`/api/`), a revision, a missing file.
  if (!existsSync(abs)) return true;
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return false;
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  if (!isWithinWorkspace(realRoot, real)) return false;
  if (readDenied && (readDenied(abs) || readDenied(resolve(root, relative(realRoot, real)))))
    return false;
  return true;
}

/** Config keys naming a program git runs by itself during status/diff/log/show/blame/grep. */
const GIT_PROGRAM_KEYS =
  "^(core\\.fsmonitor|core\\.pager|diff\\.external|diff\\..*\\.(textconv|command)|filter\\..*\\.(clean|smudge|process)|pager\\..*)$";

/** Whether the repository's own config (and what it includes) names a program git would run. */
export function gitRunsConfiguredPrograms(cwd: string): boolean {
  const r = spawnSync(
    "git",
    ["config", "--local", "--includes", "--get-regexp", GIT_PROGRAM_KEYS],
    { cwd, encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (r.error) return true; // couldn't check → don't wave it through
  // Exit 1 = none set; 128 = not a repository (git then reads no local config).
  if (r.status === 1 || r.status === 128) return false;
  if (r.status !== 0) return true;
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const [key = "", value = ""] = line.split(/\s(.*)/s);
      // `core.fsmonitor true` is git's own built-in monitor, not a program.
      return !(key === "core.fsmonitor" && /^(true|false)$/i.test(value.trim()));
    });
}

/**
 * The risk of a file edit judged by where its paths really lead: a committed symlink `notes.txt ->
 * .git/config` must get the same "writes a sensitive file" check as naming `.git/config` itself.
 * Returns the reasons when a real target is sensitive and the spelled path wasn't flagged for it.
 */
export function linkedTargetRisk(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
): string[] {
  if (toolName !== "write" && toolName !== "edit" && toolName !== "apply_patch") return [];
  const spelled: string[] = [];
  if (typeof args.path === "string") spelled.push(args.path);
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) {
      const p = (e as { path?: unknown } | null)?.path;
      if (typeof p === "string") spelled.push(p);
    }
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch {
    return [];
  }
  const real = spelled.flatMap((p) => {
    try {
      const r = realpathSync(resolve(workspaceRoot, p));
      const rel = relative(realRoot, r);
      return rel && rel !== p ? [rel.split("\\").join("/")] : [];
    } catch {
      return []; // doesn't exist yet: nothing to follow
    }
  });
  if (real.length === 0) return [];
  return classifyToolRisk("write", { edits: real.map((path) => ({ path })) }).reasons;
}
