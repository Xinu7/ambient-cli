import { readFile } from "node:fs/promises";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { resolveInWorkspace } from "../paths.js";

const Input = z.object({
  path: z.string().describe("File path relative to the workspace root"),
  offset: z.number().int().nonnegative().optional().describe("1-based line to start from"),
  limit: z.number().int().positive().optional().describe("Max lines to read"),
});
const Output = z.object({
  path: z.string(),
  lines: z.number(),
  content: z.string(),
  truncated: z.boolean(),
});

const MAX_LINES = 2000;

export const readTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "read",
    version: "1",
    description: "Read a UTF-8 text file from the workspace. Returns numbered lines.",
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
    const raw = await readFile(abs, "utf8");
    const all = raw.split("\n");
    const start = input.offset ? input.offset - 1 : 0;
    const end = Math.min(all.length, start + (input.limit ?? MAX_LINES));
    const slice = all.slice(start, end);
    const truncated = end < all.length || slice.length > MAX_LINES;
    const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
    return { path: input.path, lines: slice.length, content: numbered, truncated };
  },
};
