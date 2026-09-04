import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VerifyOutcome, VerifyPort } from "@amb/runtime";

/**
 * The project's verification is an OPT-IN executable at `.ambient/verify` (a script the user provides — e.g.
 * `pnpm test && pnpm typecheck`). We never guess or auto-run `npm test`: if the file is absent, verification
 * is simply off (the runtime skips the gate — honest, never faked). The script runs after the model finishes
 * a file-mutating turn; exit 0 = verified, non-zero = re-ask the model with the captured output.
 */
const VERIFY_SCRIPT = ".ambient/verify";
const MAX_SUMMARY_CHARS = 6_000; // the FAILURE tail fed back to the model
const TIMEOUT_MS = 180_000;

export function makeVerifyPort(workspaceRoot: string): VerifyPort | undefined {
  const script = join(workspaceRoot, VERIFY_SCRIPT);
  if (!existsSync(script)) return undefined;
  return (signal) => runVerifyScript(script, workspaceRoot, signal);
}

function runVerifyScript(
  script: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<VerifyOutcome> {
  return new Promise((resolve) => {
    let out = "";
    const append = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      // Keep only the TAIL — verification failures print at the end, and this bounds memory.
      if (out.length > MAX_SUMMARY_CHARS * 2) out = out.slice(-MAX_SUMMARY_CHARS * 2);
    };
    // `detached` puts the script in its OWN process group so we can kill the WHOLE tree (its children too)
    // on timeout or Ctrl-C — a plain child.kill would orphan grandchildren (e.g. `pnpm test`'s workers).
    const child = spawn("/bin/sh", [script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL"); // negative pid ⇒ the whole process group
      } catch {
        child.kill("SIGKILL");
      }
    };
    let reason: "timeout" | "cancelled" | undefined;
    const timer = setTimeout(() => {
      reason = "timeout";
      killTree();
    }, TIMEOUT_MS);
    const onAbort = () => {
      reason = "cancelled";
      killTree();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, summary: `could not run ${VERIFY_SCRIPT}: ${e.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (reason === "timeout") {
        resolve({
          ok: false,
          summary: `${VERIFY_SCRIPT} timed out after ${TIMEOUT_MS / 1000}s\n${tail(out)}`,
        });
      } else if (reason === "cancelled") {
        resolve({ ok: false, summary: "verification cancelled" });
      } else {
        resolve({ ok: code === 0, summary: code === 0 ? "" : tail(out) });
      }
    });
  });
}

function tail(s: string): string {
  return s.length > MAX_SUMMARY_CHARS ? `…${s.slice(-MAX_SUMMARY_CHARS)}` : s;
}
