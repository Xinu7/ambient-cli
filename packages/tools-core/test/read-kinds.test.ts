import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "../src/tools/read.js";

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-readkinds-")));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));
const ctx = (): ToolContext => ({
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  secret: async () => "",
  emit: () => {},
});

describe("read on files that aren't text", () => {
  it("says plainly it can't read a PDF (even one without the extension)", async () => {
    writeFileSync(join(ws, "spec.pdf"), "%PDF-1.7 rest");
    writeFileSync(join(ws, "noext"), "%PDF-1.4 rest");
    await expect(readTool.execute({ path: "spec.pdf" }, ctx())).rejects.toThrow(
      /is a PDF — ambient can only read text files/,
    );
    await expect(readTool.execute({ path: "noext" }, ctx())).rejects.toThrow(/is a PDF/);
  });

  it("points an image at view_image, and names binary files instead of returning garbage", async () => {
    writeFileSync(join(ws, "shot.PNG"), "x");
    writeFileSync(join(ws, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    await expect(readTool.execute({ path: "shot.PNG" }, ctx())).rejects.toThrow(/view_image/);
    await expect(readTool.execute({ path: "blob.bin" }, ctx())).rejects.toThrow(
      /binary file \(4 bytes\)/,
    );
  });

  it("still reads text", async () => {
    writeFileSync(join(ws, "a.txt"), "one\r\ntwo");
    expect((await readTool.execute({ path: "a.txt" }, ctx())).content).toBe("1\tone\n2\ttwo");
  });
});
