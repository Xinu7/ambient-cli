import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ancestorDirs, loadInstructions } from "../src/instructions.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "amb-instr-"));
  mkdirSync(join(root, ".git"), { recursive: true }); // mark repo root
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ancestorDirs", () => {
  it("stops at the repo root", () => {
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    const dirs = ancestorDirs(sub);
    expect(dirs[0]).toBe(sub);
    expect(dirs.at(-1)).toBe(root); // .git is here
  });
});

describe("loadInstructions", () => {
  it("loads nearest-first, dedupes identical content, records sources", () => {
    writeFileSync(join(root, "AMB.md"), "Root rules: use tabs.");
    const sub = join(root, "pkg");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "AGENTS.md"), "Package rules: run vitest.");
    const out = loadInstructions(sub);
    expect(out.text).toContain("Package rules");
    expect(out.text).toContain("Root rules");
    expect(out.sources).toHaveLength(2);
    // nearest first
    expect(out.text.indexOf("Package rules")).toBeLessThan(out.text.indexOf("Root rules"));
  });

  it("returns empty when there are no instruction files", () => {
    expect(loadInstructions(root).text).toBe("");
  });

  it("does NOT follow a symlinked instruction file (a committed CLAUDE.md -> secret must not reach the prompt)", () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "TOP-SECRET-KEY-abc123");
    // a repo-committable instruction file that is actually a symlink at the secret
    symlinkSync(secret, join(root, "CLAUDE.md"));
    const out = loadInstructions(root);
    expect(out.text).not.toContain("TOP-SECRET-KEY"); // the symlinked file is skipped, not read into context
    expect(out.sources).toHaveLength(0);
  });
});
