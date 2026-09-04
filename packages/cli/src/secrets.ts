import { execFileSync } from "node:child_process";
import { KEYCHAIN_SERVICE } from "@amb/ambient-api";

/** The friendly "you're not signed in" message — shown by every command that needs a key. */
export const NOT_SIGNED_IN = [
  "You're not signed in to Ambient yet.",
  "",
  "  Run:  ambient login",
  "",
  "That opens your Ambient keys page and saves your key to the macOS keychain.",
  "(Or set AMBIENT_API_KEY in your environment.)",
].join("\n");

/** Keychain account for our own entry — shared by save so replacement (`-U`) always targets the same item. */
export const KEYCHAIN_ACCOUNT = "amb";

/**
 * Persist the API key to the macOS keychain (service = KEYCHAIN_SERVICE). Overwrites any existing entry.
 * On failure we throw a SECRET-FREE error: the raw `security … -w <key>` command (which contains the key)
 * must never reach a log or the screen.
 */
export function saveApiKey(key: string): void {
  try {
    execFileSync(
      "security",
      ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", key, "-U"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  } catch {
    // Deliberately discard the original error — it embeds the key in its `command` string.
    throw new Error("could not write to the macOS keychain (is it unlocked?)");
  }
}

/**
 * Resolve the Ambient API key: env AMBIENT_API_KEY first, then the macOS keychain
 * (service `KEYCHAIN_SERVICE`). Never logs the value. Returns undefined if none is found.
 */
export function resolveApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const fromEnv = env.AMBIENT_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "darwin") {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const key = out.trim();
      if (key) return key;
    } catch {
      // no keychain entry — fall through
    }
  }
  return undefined;
}
