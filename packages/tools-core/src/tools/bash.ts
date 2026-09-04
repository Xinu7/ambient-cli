import { spawn } from "node:child_process";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { BoundedCapture } from "../capture.js";

const Input = z.object({
  command: z.string().describe("Shell command to run in the workspace"),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
});
const Output = z.object({
  command: z.string(),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
});

const MAX_OUTPUT = 100_000; // chars per stream before truncation

export const bashTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "bash",
    version: "1",
    description: "Run a shell command in the workspace and capture stdout/stderr/exit code.",
    effects: ["process", "read", "write"],
    idempotency: "non-idempotent",
    parallelSafe: false,
    resumability: "never-replay",
    timeoutPolicy: { idleMs: 120_000, maximumMs: 600_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  execute(input, ctx: ToolContext) {
    return new Promise((resolve, reject) => {
      // `detached: true` makes the shell its OWN process-group leader so a timeout/abort can kill the WHOLE
      // tree. Without it `child.kill()` hits only `/bin/sh`; a command that spawns children (a dev server, a
      // background job, `npm test` → node) leaves them running (leak) AND holding the stdout pipe, so `close`
      // never fires and the tool promise HANGS forever (same class as the MCP-server leak).
      const child = spawn(input.command, {
        cwd: ctx.cwd,
        shell: true,
        env: process.env,
        detached: true,
      });
      const outCap = new BoundedCapture(MAX_OUTPUT);
      const errCap = new BoundedCapture(MAX_OUTPUT);
      let timedOut = false;

      const killTree = () => {
        try {
          if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL"); // negative pid = the group
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, input.timeoutMs);

      const onAbort = () => killTree();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (d: Buffer) => {
        outCap.write(d.toString("utf8"));
      });
      child.stderr.on("data", (d: Buffer) => {
        errCap.write(d.toString("utf8"));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({
          command: input.command,
          exitCode: code,
          stdout: outCap.text(),
          stderr: errCap.text(),
          truncated: outCap.truncated || errCap.truncated,
          timedOut,
        });
      });
    });
  },
};
