import { readFile } from "node:fs/promises";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { resolveReadable } from "../paths.js";

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
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|ico)$/i;

/** Whether bytes look like binary data rather than text (a NUL byte early on). */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

export const readTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "read",
    version: "1",
    description:
      "Read a text file from the workspace (numbered lines). For an image, use view_image.",
    effects: ["read"],
    idempotency: "pure",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 10_000, maximumMs: 15_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const abs = resolveReadable(ctx.workspaceRoot, input.path, ctx.readRoots?.list());
    if (ctx.readDenied?.(abs)) throw new Error(`${input.path}: reading it is denied by your rules`);
    if (IMAGE_EXT.test(abs)) {
      throw new Error(`${input.path} is an image — look at it with view_image`);
    }
    const bytes = await readFile(abs);
    // Documents like PDFs aren't read here: ambient reads text files only (the same as its web app, which
    // doesn't read document uploads yet). Say so plainly instead of returning unreadable bytes.
    if (/\.pdf$/i.test(abs) || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
      throw new Error(
        `${input.path} is a PDF — ambient can only read text files, so it can't read this one`,
      );
    }
    if (looksBinary(bytes)) {
      throw new Error(`${input.path} is a binary file (${bytes.byteLength} bytes), not text`);
    }
    const raw = bytes.toString("utf8");
    const all = raw.split(/\r?\n/); // CRLF files show the same clean lines as LF ones
    const start = input.offset ? input.offset - 1 : 0;
    const end = Math.min(all.length, start + (input.limit ?? MAX_LINES));
    const slice = all.slice(start, end);
    const truncated = end < all.length || slice.length > MAX_LINES;
    const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
    return { path: input.path, lines: slice.length, content: numbered, truncated };
  },
};
