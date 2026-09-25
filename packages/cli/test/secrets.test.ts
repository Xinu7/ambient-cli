import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SecretRunner,
  deleteApiKey,
  maskKey,
  resolveApiKeyWithSource,
  saveApiKey,
} from "../src/secrets.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-secrets-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("saving the API key", () => {
  it("macOS: the key goes to the keychain via STDIN, never in a command-line argument", () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const run: SecretRunner = (cmd, args, input) => {
      calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) });
      return "";
    };
    saveApiKey("sk-SECRET-123", { platform: "darwin", run, configDir: dir });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("security");
    expect(calls[0]?.args.join(" ")).not.toContain("sk-SECRET-123");
    expect(calls[0]?.input).toContain("sk-SECRET-123");
  });

  it("other platforms: a credentials file only the user can read (0600)", () => {
    saveApiKey("sk-LINUX", { platform: "linux", run: () => "", configDir: dir });
    const p = join(dir, "credentials.json");
    expect(JSON.parse(readFileSync(p, "utf8")).apiKey).toBe("sk-LINUX");
    expect(statSync(p).mode & 0o077).toBe(0);
    expect(
      resolveApiKeyWithSource({}, { platform: "linux", run: () => "", configDir: dir }),
    ).toEqual({
      key: "sk-LINUX",
      source: "file",
    });
  });

  it("rejects a key with whitespace or control characters (a botched paste)", () => {
    expect(() =>
      saveApiKey("sk bad\nkey", { platform: "linux", run: () => "", configDir: dir }),
    ).toThrow(/doesn't look like an API key/);
  });
});

describe("resolving + removing the key", () => {
  it("env wins and is reported as the source", () => {
    expect(
      resolveApiKeyWithSource(
        { AMBIENT_API_KEY: "sk-ENV" },
        { platform: "linux", run: () => "", configDir: dir },
      ),
    ).toEqual({ key: "sk-ENV", source: "env" });
  });
  it("logout removes the stored file", () => {
    saveApiKey("sk-XXXXXXXXXX", { platform: "linux", run: () => "", configDir: dir });
    deleteApiKey({ platform: "linux", run: () => "", configDir: dir });
    expect(
      resolveApiKeyWithSource({}, { platform: "linux", run: () => "", configDir: dir }),
    ).toBeUndefined();
  });
  it("masks all but the last 4 characters", () => {
    expect(maskKey("sk-abcdef123456")).toBe("…3456");
    expect(maskKey("abc")).toBe("…");
  });
});
