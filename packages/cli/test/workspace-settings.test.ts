import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeWorkspaceSettings, untrustedNote } from "../src/agent/workspace-settings.js";

let dir: string;
let ws: string;
let home: string;
let trustFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-settings-"));
  ws = join(dir, "ws");
  home = join(dir, "home");
  trustFile = join(dir, "cfg", "trusted-projects.json");
  mkdirSync(join(ws, ".claude"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeSettings = (folder: string, name: string, value: unknown) =>
  writeFileSync(join(folder, ".claude", name), JSON.stringify(value));
const texts = (rules: ReturnType<ReturnType<typeof makeWorkspaceSettings>["rules"]>) => ({
  allow: rules?.allow.map((r) => r.text) ?? [],
  deny: rules?.deny.map((r) => r.text) ?? [],
  ask: rules?.ask.map((r) => r.text) ?? [],
});

describe("permission rules from every source", () => {
  it("deny and ask apply from anywhere; a project's allow rules wait for trust", () => {
    writeSettings(ws, "settings.json", {
      permissions: { allow: ["Bash(make:*)"], deny: ["Read(./.env)"] },
    });
    writeSettings(ws, "settings.local.json", { permissions: { ask: ["Bash(git push:*)"] } });
    const s = makeWorkspaceSettings({
      workspaceRoot: ws,
      home,
      trustFile,
      config: { permissions: { allow: ["Bash(npm test:*)"] } },
    });
    expect(texts(s.rules())).toEqual({
      allow: ["Bash(npm test:*)"],
      deny: ["Read(./.env)"],
      ask: ["Bash(git push:*)"],
    });
    expect(s.untrustedCount()).toBe(1);
    expect(untrustedNote(s)).toContain("won't apply until you trust them");
    expect(s.permissionsSummary().join("\n")).toContain("allow  Bash(make:*)  (not applied)");

    expect(s.trust()).toBe(
      "Trusted this project's 1 allow rule. They apply from the next message.",
    );
    expect(texts(s.rules()).allow).toEqual(["Bash(npm test:*)", "Bash(make:*)"]);

    // A new allow rule after trusting is a different configuration: it waits again.
    writeSettings(ws, "settings.json", { permissions: { allow: ["Bash(make:*)", "Bash(*)"] } });
    expect(texts(s.rules()).allow).toEqual(["Bash(npm test:*)"]);
  });

  it("~/.claude allow rules apply only with claudeSettings; its denials always do", () => {
    writeSettings(home, "settings.json", {
      permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(curl:*)"] },
    });
    const off = makeWorkspaceSettings({ workspaceRoot: ws, home, trustFile, config: {} });
    expect(texts(off.rules())).toEqual({ allow: [], deny: ["Bash(curl:*)"], ask: [] });
    expect(off.permissionsSummary().join("\n")).toContain('"claudeSettings": true');
    const on = makeWorkspaceSettings({
      workspaceRoot: ws,
      home,
      trustFile,
      config: { claudeSettings: true },
    });
    expect(texts(on.rules()).allow).toEqual(["Bash(ls:*)"]);
  });

  it("run from the home folder, ~/.claude is the user's settings, never a project's", () => {
    writeSettings(home, "settings.json", { permissions: { allow: ["Bash(ls:*)"] } });
    const s = makeWorkspaceSettings({ workspaceRoot: home, home, trustFile, config: {} });
    expect(s.untrustedCount()).toBe(0);
    expect(s.rules()).toBeUndefined();
  });

  it("no rules anywhere says how to add them", () => {
    const s = makeWorkspaceSettings({ workspaceRoot: ws, home, trustFile, config: {} });
    expect(s.rules()).toBeUndefined();
    expect(s.permissionsSummary()[0]).toContain('under "permissions"');
    expect(s.trust()).toBe("This project has no hooks, allow rules or MCP servers to trust.");
  });
});
