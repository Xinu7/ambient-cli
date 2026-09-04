import { relative } from "node:path";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { resolveInWorkspace } from "../paths.js";
import { walkFiles } from "../walk-files.js";

const Input = z.object({
  pattern: z.string().describe("Glob-ish pattern, e.g. **/*.ts or src/*.json"),
  limit: z.number().int().positive().default(200),
});
const Output = z.object({
  pattern: z.string(),
  matches: z.array(z.string()),
  truncated: z.boolean(),
});

/** Translate a simple glob (`**`, `*`, `?`) into a RegExp anchored to the whole relative path. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c && "\\^$.|+()[]{}".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export const globTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "glob",
    version: "1",
    description:
      "Find files matching a glob pattern (supports ** and *). Paths are workspace-relative.",
    effects: ["read"],
    idempotency: "pure",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 15_000, maximumMs: 30_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const root = resolveInWorkspace(ctx.workspaceRoot, ".");
    const re = globToRegExp(input.pattern);
    const matches: string[] = [];
    let truncated = false;
    for await (const rel of walkFiles(root, { signal: ctx.signal })) {
      if (re.test(rel)) {
        matches.push(rel);
        if (matches.length >= input.limit) {
          truncated = true;
          break;
        }
      }
    }
    matches.sort();
    return { pattern: input.pattern, matches: matches.map((m) => relative(".", m)), truncated };
  },
};
