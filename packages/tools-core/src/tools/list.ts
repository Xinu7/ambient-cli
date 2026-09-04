import { readdir } from "node:fs/promises";
import { relative } from "node:path";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { resolveInWorkspace } from "../paths.js";

const Input = z.object({
  path: z.string().default(".").describe("Directory relative to the workspace root"),
});
const Output = z.object({
  path: z.string(),
  entries: z.array(z.object({ name: z.string(), dir: z.boolean() })),
});

const IGNORE = new Set([".git", "node_modules", "dist", ".DS_Store"]);

export const listTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "list",
    version: "1",
    description: "List the entries of a directory in the workspace (skips .git/node_modules/dist).",
    effects: ["read"],
    idempotency: "pure",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 10_000, maximumMs: 15_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const abs = resolveInWorkspace(ctx.workspaceRoot, input.path);
    const dirents = await readdir(abs, { withFileTypes: true });
    const entries = dirents
      .filter((d) => !IGNORE.has(d.name))
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { path: relative(ctx.workspaceRoot, abs) || ".", entries };
  },
};
