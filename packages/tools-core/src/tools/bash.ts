import { spawn } from "node:child_process";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { BoundedCapture } from "../capture.js";
import { killProcessTree, machineShell, shellInvocation } from "../shell.js";

const SHELL = machineShell();

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
    description:
      SHELL.kind === "pwsh" || SHELL.kind === "powershell"
        ? "Run a command in the workspace and capture stdout/stderr/exit code. This machine's shell is PowerShell — write PowerShell syntax (e.g. Get-ChildItem, Select-String, $env:VAR), not bash."
        : `Run a shell command in the workspace (${SHELL.label}) and capture stdout/stderr/exit code.`,
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
      // On POSIX `detached: true` makes the shell its OWN process-group leader so a timeout/abort can kill the
      // WHOLE tree (a dev server or `npm test` → node would otherwise keep the stdout pipe open and hang the
      // tool). On Windows `detached` would open a console window; the tree is killed with `taskkill /T`.
      const child = spawn(SHELL.path, shellInvocation(SHELL, input.command), {
        cwd: ctx.cwd,
        env: process.env,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const outCap = new BoundedCapture(MAX_OUTPUT);
      const errCap = new BoundedCapture(MAX_OUTPUT);
      let timedOut = false;

      const killTree = () => {
        if (typeof child.pid === "number") killProcessTree(child.pid);
        else child.kill("SIGKILL");
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
          stdout: cleanTerminalOutput(outCap.text()),
          stderr: cleanTerminalOutput(errCap.text()),
          truncated: outCap.truncated || errCap.truncated,
          timedOut,
        });
      });
    });
  },
};

/**
 * Make captured terminal output readable as text: CRLF → LF, a line redrawn with bare `\r` (progress bars)
 * keeps only its final state, and ANSI color/cursor sequences are removed.
 */
export function cleanTerminalOutput(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real terminal escape sequences
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => {
        const parts = line.split("\r");
        return parts[parts.length - 1] ?? "";
      })
      .join("\n")
  );
}
