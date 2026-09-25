import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpConnection } from "../src/agent/mcp-connect.js";
import { makeMcpControl, mcpReport } from "../src/agent/mcp-control.js";
import { makeTokenStore } from "../src/mcp-auth/token-store.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "amb-mcpctl-"));
  writeFileSync(
    join(ws, ".mcp.json"),
    JSON.stringify({
      remote: { type: "http", url: "https://mcp.example/mcp" },
      local: { command: "x" },
    }),
  );
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("MCP status and sign-in in a session", () => {
  it("reports each server, then signs in and reconnects so the tools arrive", async () => {
    let signedIn = false;
    let closed = 0;
    const connectImpl = async (): Promise<McpConnection> => ({
      tools: [],
      notices: [],
      close: () => {
        closed++;
      },
      servers: [
        signedIn
          ? { name: "remote", source: "project", transport: "http", state: "connected", tools: 3 }
          : {
              name: "remote",
              source: "project",
              transport: "http",
              state: "needs-sign-in",
              tools: 0,
            },
        {
          name: "local",
          source: "project",
          transport: "stdio",
          state: "failed",
          tools: 0,
          detail: "exited",
        },
      ],
    });
    const ctl = makeMcpControl({
      workspaceRoot: ws,
      connect: {},
      store: makeTokenStore({ platform: "linux", configDir: ws }),
      connectImpl,
      signInImpl: async () => {
        signedIn = true;
        return {};
      },
    });
    expect(mcpReport(ctl.status())).toBe("MCP servers are still connecting…");
    await ctl.start();
    const report = mcpReport(ctl.status());
    expect(report).toContain("MCP servers (0 of 2 connected):");
    expect(report).toContain("remote  needs sign-in");
    expect(report).toContain("local   failed · exited");
    expect(report).toContain("Sign in with /mcp login remote");

    expect(await ctl.login("local", () => {})).toBe(
      "local runs on this machine and has no sign-in.",
    );
    expect(await ctl.login("nope", () => {})).toContain('No MCP server named "nope"');
    expect(await ctl.login("remote", () => {})).toBe("Signed in to remote · 3 tools ready.");
    expect(closed).toBe(1); // the old connection was closed when the new one took over
    ctl.close();
    expect(closed).toBe(2);
  });

  it("says when no servers are configured", () => {
    expect(mcpReport([])).toBe("No MCP servers configured.");
  });
});
