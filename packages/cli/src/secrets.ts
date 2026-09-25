import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KEYCHAIN_SERVICE } from "@amb/ambient-api";

/** The friendly "you're not signed in" message — shown by commands that need a key in a non-interactive shell. */
export const NOT_SIGNED_IN = [
  "You're not signed in to Ambient yet.",
  "",
  "  Run:  ambient login",
  "",
  "That opens your Ambient keys page and saves your key securely on this machine.",
  "(Or set AMBIENT_API_KEY in your environment.)",
].join("\n");

/** Shown when Ambient rejects the saved key mid-use (revoked, expired or mistyped). */
export const KEY_REJECTED = [
  "Ambient rejected your API key — it may have been revoked or mistyped.",
  "  Fix it:  ambient login      (or type /login inside ambient)",
].join("\n");

/** Keychain account for our own entry — shared by save so replacement (`-U`) always targets the same item. */
export const KEYCHAIN_ACCOUNT = "amb";

/** Runs a system command, optionally feeding `input` on stdin; returns stdout. Injectable for tests. */
export type SecretRunner = (cmd: string, args: string[], input?: string) => string;

export interface SecretEnv {
  platform?: NodeJS.Platform;
  run?: SecretRunner;
  /** Directory for the credentials file on platforms without a keychain. */
  configDir?: string;
}

export type KeySource = "env" | "keychain" | "file";

const defaultRun: SecretRunner = (cmd, args, input) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "ignore"],
  });

function defaultConfigDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.AMB_CONFIG_HOME ?? env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "amb");
}

const resolveEnv = (e: SecretEnv) => ({
  platform: e.platform ?? process.platform,
  run: e.run ?? defaultRun,
  configDir: e.configDir ?? defaultConfigDir(),
});

const credentialsPath = (dir: string) => join(dir, "credentials.json");

/** A pasted key must be a single token of printable characters (catches a botched multi-line paste). */
function assertKeyShape(key: string): void {
  if (!/^[\x21-\x7e]{8,512}$/.test(key)) {
    throw new Error("that doesn't look like an API key (it should be one line with no spaces)");
  }
}

/** Quote a value for the `security -i` command reader (double quotes, escaping `\` and `"`). */
function securityQuote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Persist the API key. macOS: the login keychain, written through `security -i` with the command on STDIN, so
 * the key never appears in a process argument list (visible to other processes via `ps`). Elsewhere: a
 * credentials file readable only by the user (0600). Errors are secret-free.
 */
export function saveApiKey(key: string, e: SecretEnv = {}): void {
  const clean = key.trim();
  assertKeyShape(clean);
  const { platform, run, configDir } = resolveEnv(e);
  if (platform === "darwin") {
    const cmd = `add-generic-password -U -s ${securityQuote(KEYCHAIN_SERVICE)} -a ${securityQuote(KEYCHAIN_ACCOUNT)} -w ${securityQuote(clean)}\n`;
    try {
      run("security", ["-i"], cmd);
    } catch {
      throw new Error("could not write to the macOS keychain (is it unlocked?)");
    }
    return;
  }
  const p = credentialsPath(configDir);
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, `${JSON.stringify({ apiKey: clean })}\n`, { mode: 0o600 });
    chmodSync(p, 0o600); // an existing file keeps its old mode on write — tighten it explicitly
  } catch {
    throw new Error(`could not write ${p}`);
  }
}

/** Remove the stored key (keychain entry and/or credentials file). Idempotent. */
export function deleteApiKey(e: SecretEnv = {}): void {
  const { platform, run, configDir } = resolveEnv(e);
  if (platform === "darwin") {
    try {
      run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
    } catch {
      // no entry — fine
    }
  }
  rmSync(credentialsPath(configDir), { force: true });
}

/** Resolve the key and where it came from: env AMBIENT_API_KEY, then the keychain (macOS), then the file. */
export function resolveApiKeyWithSource(
  env: Record<string, string | undefined> = process.env,
  e: SecretEnv = {},
): { key: string; source: KeySource } | undefined {
  const fromEnv = env.AMBIENT_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const { platform, run, configDir } = resolveEnv(e);
  if (platform === "darwin") {
    try {
      const key = run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]).trim();
      if (key) return { key, source: "keychain" };
    } catch {
      // no keychain entry — fall through
    }
  }
  const p = credentialsPath(configDir);
  if (existsSync(p)) {
    try {
      const key = String(
        (JSON.parse(readFileSync(p, "utf8")) as { apiKey?: unknown }).apiKey ?? "",
      ).trim();
      if (key) return { key, source: "file" };
    } catch {
      // unreadable/corrupt — treat as signed out
    }
  }
  return undefined;
}

/** Resolve the Ambient API key (env, keychain, credentials file). Never logs the value. */
export function resolveApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return resolveApiKeyWithSource(env)?.key;
}

/** Show only the last 4 characters of a key. */
export function maskKey(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : "…";
}
