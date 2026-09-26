import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCheckers, diagnosticsTool } from "../src/tools/diagnostics.js";

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-diag-")));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const ctx = (): ToolContext => ({
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  secret: async () => "",
  emit: () => {},
});

// The repo's own TypeScript, linked into the throwaway project.
const typescriptDir = dirname(
  createRequire(join(process.cwd(), "package.json")).resolve("typescript/package.json"),
);

describe("diagnostics", () => {
  it("runs the project's TypeScript and returns its errors by file and line", async () => {
    mkdirSync(join(ws, "node_modules"));
    symlinkSync(typescriptDir, join(ws, "node_modules", "typescript"), "junction");
    writeFileSync(
      join(ws, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
    );
    mkdirSync(join(ws, "src"));
    writeFileSync(
      join(ws, "src", "a.ts"),
      "export const n: number = 1;\nexport const s: string = n;\n",
    );
    writeFileSync(join(ws, "src", "b.ts"), "export const ok = 1;\n");
    expect(detectCheckers(ws).map((p) => p.checker)).toEqual(["tsc"]);
    const r = await diagnosticsTool.execute({}, ctx());
    expect(r.checkers).toEqual(["tsc"]);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({
        checker: "tsc",
        file: "src/a.ts",
        line: 2,
        severity: "error",
        code: "TS2322",
      }),
    ]);
    expect((await diagnosticsTool.execute({ path: "src/b.ts" }, ctx())).diagnostics).toEqual([]);
  }, 60_000);

  it("says so when the project has no checker it can run", async () => {
    await expect(diagnosticsTool.execute({}, ctx())).rejects.toThrow(/found no checker/);
    await expect(diagnosticsTool.execute({ checker: "cargo" }, ctx())).rejects.toThrow(
      /doesn't use cargo/,
    );
  });
});
