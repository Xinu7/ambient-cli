import type { Effect } from "@amb/protocol";
import { baseName, parseShellCommands } from "./shell-tokens.js";

/**
 * A conservative classifier that recognizes a bash command as PURELY read-only, so the permission engine can
 * treat it as a `read` (auto-allowed, and permitted in plan mode) instead of a full `process` call that always
 * prompts. This NARROWS a security check, so the rules are deliberately strict — any doubt returns the
 * command's declared effects unchanged (i.e. it still prompts). Erring toward "prompt" is always safe here.
 *
 * A command downgrades to read-only ONLY when EVERY pipeline/sequence segment is a known read-only invocation
 * AND the raw command contains no redirection or command-substitution metacharacters.
 */

// Non-git commands that have NO file-writing form at all (output goes to stdout; redirection is blocked
// separately). Deliberately excludes anything with a write flag/positional (sed -i, awk, sort -o, uniq OUT,
// tee, find -delete/-exec, yq -i, dd, cp, mv, rm, …).
const READ_ONLY_CMDS = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "stat",
  "file",
  "tree",
  "echo",
  "printf",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "which",
  "whoami",
  "id",
  "date",
  "uname",
  "hostname",
  "du",
  "df",
  "diff",
  "cmp",
]);

// git subcommands that are read-only in EVERY form (no mutating variant, no flag that writes a ref/file).
// Notably EXCLUDES the overloaded ones (branch/tag/stash/remote/config: each has a delete/create/set form),
// symbolic-ref (can rewrite HEAD), and ls-remote/fetch/pull (network). `--output` is rejected separately
// because it's a diff write-flag that applies to diff/show/log.
const READ_ONLY_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "describe",
  "blame",
  "shortlog",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-list",
  "merge-base",
  "whatchanged",
  "name-rev",
  "for-each-ref",
  "count-objects",
  "cherry",
  "grep",
]);

/** Metacharacters that write files or execute arbitrary commands, and which the segment tokenizer does not
 *  split on — their mere presence in the raw command disqualifies the read-only downgrade. */
function hasDangerousMeta(command: string): boolean {
  return (
    command.includes(">") || // redirection (also covers >>)
    command.includes("<") || // redirection / here-strings
    command.includes("`") || // command substitution
    command.includes("$(") // command substitution
  );
}

/** True iff `command` is composed ENTIRELY of read-only invocations (see the rules above). */
export function isReadOnlyCommand(command: string): boolean {
  if (hasDangerousMeta(command)) return false;
  const segments = parseShellCommands(command);
  if (segments.length === 0) return false; // empty/whitespace — nothing to downgrade

  for (const seg of segments) {
    if (seg.quotedFirst) return false; // a fully-quoted first word is data, not a safe invocation
    const cmd = baseName(seg.argv[0] ?? "");
    if (!cmd) return false;
    // A diff-family write flag (`--output=<file>`) writes a file regardless of the subcommand — reject it.
    if (seg.argv.some((t) => t.startsWith("--output"))) return false;

    if (cmd === "git") {
      // Require the SAFE subcommand immediately after `git` (no global options like `-c alias=!cmd` before it).
      const sub = seg.argv[1];
      if (!sub || sub.startsWith("-") || !READ_ONLY_GIT.has(sub)) return false;
      continue;
    }
    if (!READ_ONLY_CMDS.has(cmd)) return false;
  }
  return true;
}

/**
 * The effects to use for a bash call: read-only when `isReadOnlyCommand`, else the tool's declared effects.
 * Applies ONLY to the `bash` tool — every other tool keeps its manifest effects.
 */
export function refineBashEffects(toolName: string, args: unknown, declared: Effect[]): Effect[] {
  if (toolName !== "bash") return declared;
  const command = (args as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return declared;
  return isReadOnlyCommand(command) ? ["read"] : declared;
}
