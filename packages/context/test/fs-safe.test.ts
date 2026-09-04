import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTextCappedSafe } from "../src/fs-safe.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "amb-fssafe-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readTextCappedSafe", () => {
  it("reads a normal regular file's full bytes (incl. multibyte UTF-8)", () => {
    const p = join(dir, "f.txt");
    const content = "hello — café 🌍\nsecond line";
    writeFileSync(p, content);
    expect(readTextCappedSafe(p)).toBe(content);
  });

  it("returns null for a missing file, a directory, and an over-cap file", () => {
    expect(readTextCappedSafe(join(dir, "nope.txt"))).toBeNull();
    expect(readTextCappedSafe(dir)).toBeNull(); // a directory
    const big = join(dir, "big.txt");
    writeFileSync(big, "z".repeat(2048));
    expect(readTextCappedSafe(big, { maxBytes: 1024 })).toBeNull();
  });

  it("never follows a symlinked LEAF", () => {
    const secret = join(dir, "secret");
    writeFileSync(secret, "SECRET");
    const link = join(dir, "link.txt");
    symlinkSync(secret, link);
    expect(readTextCappedSafe(link)).toBeNull();
  });

  it("rejects a file reached via a symlinked ANCESTOR that escapes the root", () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "f.txt"), "leaked");
    const rootDir = join(dir, "root");
    mkdirSync(rootDir);
    symlinkSync(outside, join(rootDir, "sub")); // root/sub -> outside
    const target = join(rootDir, "sub", "f.txt");
    // With no root: leaf isn't a symlink (f.txt is real inside outside), so it reads.
    expect(readTextCappedSafe(target)).toBe("leaked");
    // With containment root: the real parent (outside) is not under root ⇒ rejected.
    expect(readTextCappedSafe(target, { root: rootDir })).toBeNull();
  });

  it("allows a real file under a root that ends in the separator (e.g. filesystem root)", () => {
    const p = join(dir, "f.txt");
    writeFileSync(p, "ok");
    expect(readTextCappedSafe(p, { root: "/" })).toBe("ok"); // "/" + sep must not become "//"
  });
});
