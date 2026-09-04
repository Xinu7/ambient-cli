import { type ChildProcess, spawn } from "node:child_process";
import { LineFramer, type Transport } from "./jsonrpc.js";

/** Config for one stdio MCP server (the shape both Claude `.mcp.json` and Codex `[mcp_servers]` reduce to). */
export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Spawn an MCP server as a child process and wire its stdin/stdout as a newline-delimited JSON transport.
 * stderr is captured (bounded) for diagnostics but never parsed as protocol. The child is killed on close.
 */
export function spawnStdioTransport(cfg: StdioServerConfig): {
  transport: Transport;
  child: ChildProcess;
} {
  // `detached: true` makes the child its OWN process-group leader, so wrapper launchers (`npm exec`, `npx`,
  // `uvx`) put the REAL server in the same group. On close we kill the whole group — otherwise SIGKILL hits
  // only the wrapper and the reparented grandchild both (a) becomes an orphan and (b) keeps our inherited
  // stdout pipe open, so the CLI's event loop never drains and `ambient run` HANGS after printing [complete].
  const child = spawn(cfg.command, cfg.args ?? [], {
    cwd: cfg.cwd,
    env: { ...process.env, ...cfg.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  let onMsg: (m: unknown) => void = () => {};
  let onClose: (err?: Error) => void = () => {};
  let closed = false;
  const framer = new LineFramer((m) => onMsg(m));

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => framer.push(d));
  // DRAIN stderr — a piped stream Node never reads fills the OS pipe (~64 KiB) and DEADLOCKS a child that
  // blocks on write(2) to fd 2 (MCP servers are told to log to stderr since stdout is the protocol channel).
  // An undrained chatty server would stall `initialize` to the timeout and read as "unavailable — skipped"
  // (a big contributor to slow startup). Keep only a bounded tail for diagnostics.
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    stderrTail = (stderrTail + d).slice(-4000);
  });
  child.stderr?.on("error", () => {}); // never let an EPIPE on the diagnostic stream crash us
  void stderrTail; // captured for future diagnostics; the read itself is what prevents the deadlock
  const fireClose = (err?: Error) => {
    if (closed) return;
    closed = true;
    onClose(err);
  };
  child.on("exit", (code, signal) =>
    fireClose(new Error(`MCP server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`)),
  );
  child.on("error", (e) => fireClose(e));

  const transport: Transport = {
    send: (line) => {
      if (!closed) child.stdin?.write(line);
    },
    onMessage: (cb) => {
      onMsg = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    close: () => {
      closed = true;
      // Kill the whole process GROUP (negative pid) so wrapper-launched grandchildren die too — then destroy
      // our ends of the pipes so no stream ref keeps the event loop alive. Runs even if `exit` already fired,
      // to reap any group member that outlived the leader. Best-effort: ESRCH (already gone) is fine.
      try {
        if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    },
  };
  return { transport, child };
}
