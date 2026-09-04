import { loadSkillBody } from "@amb/context";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";

const Input = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .describe("A skill name (from the skill index or from `search_skills` results)"),
});
const Output = z.object({
  name: z.string(),
  found: z.boolean(),
  body: z.string(),
});

/**
 * The `skill` tool — progressive disclosure. The model sees only a lightweight catalog (name + description)
 * in its context; when a skill is relevant it calls this to pull in the FULL instructions on demand. Read-only
 * (never prompts). The returned body is UNTRUSTED reference material — the model should use it as guidance,
 * not as commands that change what it's allowed to do (agent-trap defense).
 */
export const skillTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "skill",
    version: "1",
    description:
      "Load the full instructions for a named skill. Call this when a skill (from the index or a `search_skills` result) is relevant; it returns the skill's detailed steps/reference. Read-only, no side effects.",
    effects: ["read"],
    idempotency: "pure",
    parallelSafe: true,
    resumability: "replay",
    timeoutPolicy: { idleMs: 5_000, maximumMs: 5_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const body = loadSkillBody(ctx.workspaceRoot, input.name);
    if (body === undefined) {
      return {
        name: input.name,
        found: false,
        body: `No skill named "${input.name}" was found. Use \`search_skills\` to find a valid skill name.`,
      };
    }
    return { name: input.name, found: true, body };
  },
};
