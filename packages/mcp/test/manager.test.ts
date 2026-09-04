import { describe, expect, it } from "vitest";
import { type StartOptions, type Transport, startMcpServers } from "../src/index.js";

/** A fake in-process MCP server as a transport factory (no child process). */
const fakeSpawn =
  (tools: Record<string, { name: string }[]>, dead = new Set<string>()): StartOptions["spawn"] =>
  (cfg) => {
    const server = ("args" in cfg ? (cfg.args?.[0] as string) : undefined) ?? "";
    let onMsg: (m: unknown) => void = () => {};
    let onClose: (e?: Error) => void = () => {};
    const transport: Transport = {
      send: (line) => {
        const req = JSON.parse(line) as { id?: number; method: string };
        if (dead.has(server)) {
          queueMicrotask(() => onClose(new Error("server crashed")));
          return;
        }
        if (req.id === undefined) return;
        const result =
          req.method === "tools/list" ? { tools: tools[server] ?? [] } : { capabilities: {} };
        queueMicrotask(() => onMsg({ jsonrpc: "2.0", id: req.id, result }));
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
      onClose: (cb) => {
        onClose = cb;
      },
      close: () => {},
    };
    return { transport };
  };

describe("startMcpServers", () => {
  it("starts servers, namespaces their tools, and returns them for registration", async () => {
    const spawn = fakeSpawn({
      docs: [{ name: "search" }, { name: "fetch" }],
      db: [{ name: "query" }],
    });
    const session = await startMcpServers(
      [
        { name: "docs", config: { command: "x", args: ["docs"] } },
        { name: "db", config: { command: "x", args: ["db"] } },
      ],
      { spawn },
    );
    expect(session.tools.map((t) => t.manifest.name).sort()).toEqual([
      "mcp__db__query",
      "mcp__docs__fetch",
      "mcp__docs__search",
    ]);
    session.close();
  });

  it("skips a failing server without killing the others", async () => {
    const logs: string[] = [];
    const spawn = fakeSpawn({ good: [{ name: "ok" }] }, new Set(["bad"]));
    const session = await startMcpServers(
      [
        { name: "bad", config: { command: "x", args: ["bad"] } },
        { name: "good", config: { command: "x", args: ["good"] } },
      ],
      { spawn, onLog: (m) => logs.push(m), initTimeoutMs: 100 },
    );
    expect(session.tools.map((t) => t.manifest.name)).toEqual(["mcp__good__ok"]);
    expect(logs.some((l) => l.includes("bad") && l.includes("skipped"))).toBe(true);
  });

  it("closes the transport of a server that fails to initialize (no zombie child)", async () => {
    let closed = false;
    // A transport that immediately reports the pipe dying on the first request, then records close().
    const spawn: StartOptions["spawn"] = () => {
      let onClose: (e?: Error) => void = () => {};
      const transport: Transport = {
        send: () => queueMicrotask(() => onClose(new Error("boom"))),
        onMessage: () => {},
        onClose: (cb) => {
          onClose = cb;
        },
        close: () => {
          closed = true;
        },
      };
      return { transport };
    };
    await startMcpServers([{ name: "bad", config: { command: "x" } }], { spawn });
    expect(closed).toBe(true);
  });

  it("skips a duplicate tool id from one server instead of crashing the run", async () => {
    const logs: string[] = [];
    const spawn = fakeSpawn({ dup: [{ name: "same" }, { name: "same" }] });
    const session = await startMcpServers(
      [{ name: "dup", config: { command: "x", args: ["dup"] } }],
      {
        spawn,
        onLog: (m) => logs.push(m),
      },
    );
    expect(session.tools.map((t) => t.manifest.name)).toEqual(["mcp__dup__same"]);
    expect(logs.some((l) => l.includes("duplicates"))).toBe(true);
  });
});
