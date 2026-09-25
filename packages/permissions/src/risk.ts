import { baseName, parseShellCommands } from "./shell-tokens.js";

/**
 * A LOCAL, deterministic risk classifier for a tool call's INPUT — the input-side complement
 * to the output-side injection scan. It runs before execution and lets `decide()` ESCALATE a call that a
 * permissive mode would otherwise auto-approve (e.g. accept-edits silently writing to ~/.ssh), and enriches
 * every approval prompt with a plain-English reason the human can act on.
 *
 * Design line (honors the permission model): risk NEVER overrides `bypass` or an explicit grant. It only turns an otherwise-
 * automatic `allow` into an `ask`, and annotates `ask`s. Bash is matched on TOKENS (linear, quote-aware) so a
 * hostile long line can't cause quadratic work and quoted text (`printf 'sudo'`) is never mistaken for a
 * command. Heuristic first line, not a sandbox — curated to avoid crying wolf on ordinary dev commands.
 */

export type RiskLevel = "none" | "elevated" | "critical";
export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}

/** The classic fork bomb is awkward to tokenize — match its fixed shape with a bounded (linear) regex. */
const FORK_BOMB = /:\s*\(\s*\)\s*\{[^}]{0,60}[|][^}]{0,60}&[^}]{0,60}\}\s*;?\s*:/;

/** Delete targets that are catastrophic regardless of intent: the root, home, or a top-level system dir. */
function isCatastrophicTarget(a: string): boolean {
  if (a === "/" || a === "/*" || a === "~" || a === "~/" || a === "$HOME" || a === "$HOME/")
    return true;
  if (
    /^\/(bin|boot|dev|etc|lib|lib64|proc|root|sbin|sys|usr|var|System|Applications|Users|home)(\/|$)/.test(
      a,
    )
  ) {
    return true;
  }
  // Git Bash spellings of a Windows drive root or its system folders (`/c/`, `/c/Users`).
  return /^\/[a-z](\/(\*|users|windows|program files|programdata)?)?\/?$/i.test(a);
}

/** Windows delete targets that are catastrophic: a drive root, the user profile, or a system folder. */
function isCatastrophicWindowsTarget(a: string): boolean {
  const t = a.trim().replace(/^["']|["']$/g, "");
  return (
    /^[a-z]:[\\/]?\*?$/i.test(t) ||
    /^(%userprofile%|\$env:userprofile|%homedrive%%homepath%|%systemroot%|\$env:systemroot|\$home|~)([\\/]\*?)?$/i.test(
      t,
    ) ||
    /^[a-z]:[\\/](windows|users|program files( \(x86\))?|programdata)[\\/]?$/i.test(t) ||
    /^[a-z]:[\\/]users[\\/][^\\/]+[\\/]?$/i.test(t) // one user's whole profile
  );
}

/** cmd options may be written together (`/s/q`); split them so each is recognized. */
const splitCmdOptions = (argv: string[]) =>
  argv.flatMap((a) => (/^\/[^\\/]/.test(a) ? a.split(/(?=\/)/) : [a]));
/** A PowerShell parameter written as any unambiguous prefix (`-Rec`, `-Fo`). */
const psParam = (opt: string, name: string, minLength: number) =>
  opt.length >= minLength && name.startsWith(opt);

/**
 * Windows (cmd / PowerShell) destructive commands, tokenized the Windows way: backslashes are literal path
 * separators (the POSIX tokenizer would eat them as escapes) and only double quotes group words. Wrapped
 * commands (`cmd /c …`, `powershell -Command …`) are classified too.
 */
function windowsCommandRisk(command: string, risk: Risk, depth = 0): void {
  // cmd's escape character (`r^d`) doesn't change which command runs.
  for (const segment of command.replace(/\^(?=\S)/g, "").split(/&&|\|\||[&|;\n]/)) {
    const argv = segment.match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, "")) ?? [];
    if (argv.length === 0) continue;
    const base = baseName(argv[0] as string)
      .toLowerCase()
      .replace(/\.exe$/, "");
    if (depth < 2 && base === "cmd") {
      // `/c`, Git Bash's `//c`, or `/c"rd …"` glued to the command.
      const i = argv.findIndex((a) => /^\/\/?[ck]/i.test(a));
      if (i >= 0) {
        const rest = (argv[i] as string).replace(/^\/\/?[ck]/i, "");
        windowsCommandRisk([rest, ...argv.slice(i + 1)].join(" "), risk, depth + 1);
      }
      continue;
    }
    if (depth < 2 && (base === "powershell" || base === "pwsh")) {
      const opts = argv.slice(1).map((a) => a.toLowerCase());
      if (
        opts.some((o) =>
          psParam(o, "-encodedcommand", 2) && o !== "-e" ? true : o === "-e" || o === "-ec",
        )
      ) {
        risk.add("elevated", "runs an encoded PowerShell command that can't be read here");
      }
      // The script follows -Command, or is simply the rest of the line when no parameter names it.
      const i = opts.findIndex((o) => o === "-c" || psParam(o, "-command", 4));
      const start = i >= 0 ? i + 1 : opts.findIndex((o) => !o.startsWith("-")) + 1;
      if (start > 0) windowsCommandRisk(argv.slice(start).join(" "), risk, depth + 1);
      continue;
    }
    windowsRisk(base, argv, risk);
  }
}

/** Classify one Windows command. `base` is lower-cased without `.exe`. */
function windowsRisk(base: string, argv: string[], risk: Risk): void {
  const opts = splitCmdOptions(argv.slice(1)).map((a) => a.toLowerCase());
  // A target is anything that isn't an option (a drive-rooted path like C:\ is a target, never an option).
  const targets = argv.slice(1).filter((a) => !/^-/.test(a) && !/^\/[a-z?]{1,2}$/i.test(a));
  const has = (...names: string[]) => opts.some((o) => names.includes(o));
  const catastrophic = targets.some(isCatastrophicWindowsTarget);
  const psRecurse = opts.some((o) => psParam(o, "-recurse", 2));
  const psForce = opts.some((o) => o === "-f" || psParam(o, "-force", 3));
  if ((base === "rd" || base === "rmdir") && has("/s")) {
    risk.add(
      catastrophic ? "critical" : "elevated",
      catastrophic ? "recursive delete of a drive or profile root" : "recursively deletes a folder",
    );
  } else if ((base === "del" || base === "erase") && has("/s")) {
    risk.add(catastrophic ? "critical" : "elevated", "recursively deletes files");
  } else if (
    ["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"].includes(base) &&
    psRecurse &&
    (psForce || catastrophic)
  ) {
    // PowerShell's Remove-Item and its aliases.
    risk.add(
      catastrophic ? "critical" : "elevated",
      catastrophic ? "recursive delete of a drive or system folder" : "force-deletes a folder tree",
    );
  } else if (
    base === "format" ||
    base === "diskpart" ||
    base === "format-volume" ||
    base === "clear-disk"
  ) {
    risk.add("critical", "formats or repartitions a disk");
  }
}

const CREDENTIAL_PATH =
  /(?:^|\/)(?:\.ssh\/|\.aws\/|\.gnupg\/|id_[rd]sa|\.env(?:$|\.)|\.npmrc|\.netrc|\.pypirc)/;

class Risk {
  level: RiskLevel = "none";
  reasons: string[] = [];
  add(level: "elevated" | "critical", why: string): void {
    if (level === "critical") this.level = "critical";
    else if (this.level === "none") this.level = "elevated";
    this.reasons.push(why);
  }
}

const PRIV_WRAPPERS = new Set(["sudo", "doas"]);
const ENV_WRAPPERS = new Set(["env", "nice", "time", "nohup", "setsid", "stdbuf"]);
/** Wrapper flags that consume the FOLLOWING token as their value (so we skip it too when unwrapping). */
const VALUE_FLAGS = new Set(["-u", "-g", "-p", "-C", "-U", "-r", "-t", "-T", "-R", "-D", "-h"]);

/** Unwrap privilege/env wrappers (`sudo rm …`, `sudo -u root rm …`, `env FOO=1 rm …`) to the REAL command.
 *  Returns whether a privilege wrapper (sudo/doas) was present, plus the effective argv (command + its args). */
function unwrap(argv: string[]): { sawPriv: boolean; argv: string[] } {
  let cur = argv;
  let sawPriv = false;
  for (let guard = 0; guard < 8 && cur.length > 0; guard++) {
    const head = baseName(cur[0] as string);
    if (PRIV_WRAPPERS.has(head)) sawPriv = true;
    else if (!ENV_WRAPPERS.has(head)) break;
    // Skip the wrapper's own flags (and any value they consume) + env VAR=VALUE, to the next command word.
    let k = 1;
    while (k < cur.length) {
      const tok = cur[k] as string;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
        k++;
      } else if (tok.startsWith("-")) {
        k += VALUE_FLAGS.has(tok) ? 2 : 1;
      } else {
        break;
      }
    }
    cur = cur.slice(k);
  }
  return { sawPriv, argv: cur };
}

const flagsOf = (argv: string[]) => argv.slice(1).filter((t) => t.startsWith("-"));
const argsOf = (argv: string[]) => argv.slice(1).filter((t) => !t.startsWith("-"));
const hasRecursive = (flags: string[]) =>
  flags.some((f) => /^--recursive$/.test(f) || /^-[a-zA-Z]*[rR]/.test(f));
const hasForce = (flags: string[]) =>
  flags.some((f) => /^--force$/.test(f) || /^-[a-zA-Z]*f/.test(f));

function classifyBash(command: string): RiskAssessment {
  const risk = new Risk();
  const bounded = command.length > 16_000 ? command.slice(0, 16_000) : command;
  if (FORK_BOMB.test(bounded)) risk.add("critical", "looks like a fork bomb");

  windowsCommandRisk(bounded, risk);
  const cmds = parseShellCommands(command);
  const effectiveNames: string[] = [];

  for (const c of cmds) {
    if (c.quotedFirst) continue; // quoted first word = data, not a command
    const { sawPriv, argv } = unwrap(c.argv);
    if (sawPriv) risk.add("elevated", "runs with elevated privileges");
    if (argv.length === 0) continue;
    const base = baseName(argv[0] as string);
    effectiveNames.push(base);
    const flags = flagsOf(argv);
    const args = argsOf(argv);

    if (
      base === "rm" &&
      hasRecursive(flags) &&
      hasForce(flags) &&
      args.some(isCatastrophicTarget)
    ) {
      risk.add("critical", "recursive delete of a root/home path");
    } else if (base === "dd" && args.some((a) => /^of=\/dev\/(?:sd|disk|nvme|hd|rdisk)/.test(a))) {
      risk.add("critical", "writes raw bytes to a disk device");
    } else if (base === "mkfs" || base.startsWith("mkfs.")) {
      risk.add("critical", "formats a filesystem");
    } else if (base === "chmod" && args.includes("777") && args.some(isCatastrophicTarget)) {
      risk.add("critical", "world-writable on a system path");
    } else if (
      base === "git" &&
      args[0] === "push" &&
      (hasForce(flags) || flags.includes("--force-with-lease"))
    ) {
      risk.add("elevated", "force-pushes git history");
    } else if (base === "git" && args[0] === "reset" && flags.includes("--hard")) {
      risk.add("elevated", "discards local changes");
    } else if (base === "shutdown" || base === "reboot" || base === "halt" || base === "poweroff") {
      risk.add("elevated", "powers off / reboots the machine");
    } else if (base === "eval" || base === "source") {
      risk.add("elevated", "evaluates dynamically-built shell");
    }
    if (args.some((a) => CREDENTIAL_PATH.test(a))) {
      risk.add("elevated", "touches credential / key files");
    }
  }

  // Piping a download straight into a shell (curl … | sh). Any downloader + any shell in the pipeline.
  const downloaders = new Set(["curl", "wget", "fetch"]);
  const shells = new Set(["sh", "bash", "zsh", "python", "python3"]);
  if (effectiveNames.some((n) => downloaders.has(n)) && effectiveNames.some((n) => shells.has(n))) {
    risk.add("elevated", "pipes a download straight into a shell");
  }
  return { level: risk.level, reasons: [...new Set(risk.reasons)] };
}

/** Sensitive file targets for write/edit/apply_patch — writing here can grant access or hijack execution
 *  (`.ambient/verify*` runs automatically after the model edits files). */
const SENSITIVE_PATH =
  /(?:^|\/)(?:\.ssh\/|\.aws\/|\.gnupg\/|authorized_keys|id_[rd]sa|\.env(?:$|\.)|\.git\/(?:hooks|config)|\.ambient\/verify|\.github\/workflows\/|\.bashrc|\.zshrc|\.profile|\.npmrc|\.pypirc|\.netrc|sudoers|\/etc\/)/;

function pathsOf(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof args.path === "string") out.push(args.path);
  if (typeof args.file === "string") out.push(args.file);
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) {
      if (e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string") {
        out.push((e as { path: string }).path);
      }
    }
  }
  return out;
}

/** Classify the risk of a tool call from its name + already-validated args. Pure + deterministic. */
export function classifyToolRisk(toolName: string, args: Record<string, unknown>): RiskAssessment {
  if (toolName === "bash" && typeof args.command === "string") {
    return classifyBash(args.command);
  }

  if (toolName === "write" || toolName === "edit" || toolName === "apply_patch") {
    const reasons: string[] = [];
    for (const p of pathsOf(args)) {
      // Normalize Windows separators + case before matching. Over-flagging a case-variant (`.ENV`) on a
      // case-sensitive host is an acceptable false positive (a harmless extra ask), never a security hole.
      if (SENSITIVE_PATH.test(p.replace(/\\/g, "/").toLowerCase())) {
        reasons.push(`writes a sensitive file: ${p}`);
      }
    }
    return { level: reasons.length > 0 ? "elevated" : "none", reasons: [...new Set(reasons)] };
  }

  return { level: "none", reasons: [] };
}
