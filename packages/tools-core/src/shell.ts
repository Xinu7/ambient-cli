import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The shell the `bash` tool runs commands in, chosen per machine so commands actually work everywhere:
 *  - macOS/Linux: a real `bash` from PATH (Debian/Ubuntu's `/bin/sh` is dash, which lacks bash syntax),
 *    falling back to `/bin/sh`.
 *  - Windows: Git Bash when installed (bash syntax works as the model expects; never WSL's System32 bash,
 *    which runs in a different filesystem), else PowerShell 7, else Windows PowerShell.
 * `AMBIENT_SHELL` overrides detection with an explicit executable.
 */
export type ShellKind = "bash" | "sh" | "pwsh" | "powershell";

export interface ShellInfo {
  kind: ShellKind;
  path: string;
  /** Human name for prompts/descriptions ("bash", "PowerShell"). */
  label: string;
}

type Env = Record<string, string | undefined>;

function onPath(name: string, env: Env, platform: NodeJS.Platform, exists: (p: string) => boolean) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  for (const d of dirs) {
    const full = p.join(d, name);
    if (exists(full)) return full;
  }
  return undefined;
}

function kindOf(exe: string): ShellKind {
  const base = exe.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? "";
  if (base.startsWith("pwsh")) return "pwsh";
  if (base.startsWith("powershell")) return "powershell";
  if (base === "sh" || base === "sh.exe" || base === "dash") return "sh";
  return "bash";
}

const LABEL: Record<ShellKind, string> = {
  bash: "bash",
  sh: "sh",
  pwsh: "PowerShell",
  powershell: "PowerShell",
};

export function detectShell(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): ShellInfo {
  const make = (kind: ShellKind, p: string): ShellInfo => ({ kind, path: p, label: LABEL[kind] });
  const override = env.AMBIENT_SHELL?.trim();
  if (override && exists(override)) return make(kindOf(override), override);

  if (platform !== "win32") {
    const bash = onPath("bash", env, platform, exists);
    return bash ? make("bash", bash) : make("sh", "/bin/sh");
  }

  const w = path.win32;
  const gitBash = [
    env.ProgramFiles && w.join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env["ProgramFiles(x86)"] &&
      w.join(env["ProgramFiles(x86)"] as string, "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].find((p): p is string => typeof p === "string" && exists(p));
  if (gitBash) return make("bash", gitBash);
  const pathBash = onPath("bash.exe", env, platform, exists);
  if (pathBash && !/\\(system32|windowsapps)\\/i.test(pathBash)) return make("bash", pathBash);
  const pwsh = onPath("pwsh.exe", env, platform, exists);
  if (pwsh) return make("pwsh", pwsh);
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return make(
    "powershell",
    w.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
}

/** Arguments that run `command` non-interactively in `shell`. PowerShell is told to emit UTF-8. */
export function shellInvocation(shell: ShellInfo, command: string): string[] {
  if (shell.kind === "pwsh" || shell.kind === "powershell") {
    return [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`,
    ];
  }
  return ["-c", command];
}

/** True when commands use POSIX shell syntax (the read-only command classifier only understands that). */
export function isPosixShell(shell: ShellInfo): boolean {
  return shell.kind === "bash" || shell.kind === "sh";
}

/** Kill a process and everything it started: the process group on POSIX, `taskkill /T` on Windows. */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGKILL"); // negative pid = the whole group (the child is its own group leader)
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

let cached: ShellInfo | undefined;
/** The shell for this machine, detected once per process. */
export function machineShell(): ShellInfo {
  cached ??= detectShell();
  return cached;
}
