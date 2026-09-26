import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkedTargetRisk, readOnlyBashHolds } from "../src/read-only-bash.js";

let dir: string;
let ws: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-robash-"));
  ws = join(dir, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "README.md"), "hi\n");
  writeFileSync(join(dir, "secret.txt"), "outside\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const holds = (cmd: string, readDenied?: (p: string) => boolean) =>
  readOnlyBashHolds(cmd, { workspaceRoot: ws, ...(readDenied ? { readDenied } : {}) });

describe.skipIf(process.platform === "win32")("a read-only shell command, checked on disk", () => {
  it("reads inside the workspace run without asking; outside ones ask", () => {
    expect(holds("cat README.md")).toBe(true);
    expect(holds("grep -rn /api/ .")).toBe(true); // a pattern, not a file
    expect(holds(`cat ${join(dir, "secret.txt")}`)).toBe(false);
    expect(holds("cat ../secret.txt")).toBe(false);
    expect(holds(`grep --file=${join(dir, "secret.txt")} README.md`)).toBe(false);
  });
  it("a link inside the workspace that leads outside asks", () => {
    symlinkSync(join(dir, "secret.txt"), join(ws, "notes.txt"));
    expect(holds("cat notes.txt")).toBe(false);
  });
  it("a file your Read deny rules cover asks", () => {
    writeFileSync(join(ws, ".env"), "KEY=1\n");
    expect(holds("cat .env", (p) => p.endsWith("/.env"))).toBe(false);
    expect(holds("cat README.md", (p) => p.endsWith("/.env"))).toBe(true);
  });
  it("git asks when the repository's config names a program git runs by itself", () => {
    execFileSync("git", ["init", "-q"], { cwd: ws });
    expect(holds("git status")).toBe(true);
    execFileSync("git", ["config", "core.fsmonitor", "true"], { cwd: ws });
    expect(holds("git status")).toBe(true); // git's own built-in monitor
    execFileSync("git", ["config", "core.fsmonitor", "./run-me.sh"], { cwd: ws });
    expect(holds("git status")).toBe(false);
    execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: ws });
    execFileSync("git", ["config", "diff.external", "./run-me.sh"], { cwd: ws });
    expect(holds("git diff")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("an edit through a symlink", () => {
  it("is judged by the file it really changes", () => {
    mkdirSync(join(ws, ".git"));
    writeFileSync(join(ws, ".git", "config"), "[core]\n");
    symlinkSync(join(ws, ".git", "config"), join(ws, "notes.txt"));
    expect(linkedTargetRisk("edit", { path: "notes.txt" }, ws).join()).toMatch(/\.git\/config/);
    expect(linkedTargetRisk("edit", { path: "README.md" }, ws)).toEqual([]);
    expect(linkedTargetRisk("write", { path: "new-file.ts" }, ws)).toEqual([]);
  });
});
