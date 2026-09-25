import type { ToolContext } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { type StartOptions, type Transport, startMcpServers } from "../src/index.js";

/** A fake server with resources, prompts, and a tool list it can change (and announce). */
function fakeServer() {
  let toolNames = ["search"];
  let push: (m: unknown) => void = () => {};
  const replies: unknown[] = [];
  const spawn: StartOptions["spawn"] = () => {
    let onMsg: (m: unknown) => void = () => {};
    push = (m) => queueMicrotask(() => onMsg(m));
    const transport: Transport = {
      send: (line) => {
        const req = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          result?: unknown;
        };
        if (req.method === undefined) {
          replies.push(req); // our answer to a request the server made
          return;
        }
        if (req.id === undefined) return;
        const result = (() => {
          switch (req.method) {
            case "initialize":
              return { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } };
            case "tools/list":
              return { tools: toolNames.map((name) => ({ name })) };
            case "resources/list":
              return { resources: [{ uri: "file:///notes.md", name: "Notes" }] };
            case "resources/read":
              return {
                contents: [
                  { uri: req.params?.uri, text: `contents of ${String(req.params?.uri)}` },
                  { blob: "AAAA", mimeType: "image/png" },
                ],
              };
            case "prompts/list":
              return {
                prompts: [
                  {
                    name: "review",
                    description: "Review a PR",
                    arguments: [{ name: "pr", required: true }, { name: "focus" }],
                  },
                ],
              };
            case "prompts/get":
              return {
                messages: [
                  {
                    role: "user",
                    content: {
                      type: "text",
                      text: `Review PR ${JSON.stringify(req.params?.arguments)}`,
                    },
                  },
                ],
              };
            default:
              return {};
          }
        })();
        push({ jsonrpc: "2.0", id: req.id, result });
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
      onClose: () => {},
      close: () => {},
    };
    return { transport };
  };
  return {
    spawn,
    changeTools: (names: string[]) => {
      toolNames = names;
      push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    },
    ping: () => push({ jsonrpc: "2.0", id: 99, method: "ping" }),
    replies,
  };
}

const ctx = {} as ToolContext;
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("MCP resources and prompts", () => {
  it("offers resources through two read-only tools", async () => {
    const srv = fakeServer();
    const s = await startMcpServers([{ name: "docs", config: { command: "x" } }], {
      spawn: srv.spawn,
    });
    const list = s.tools.find((t) => t.manifest.name === "mcp_list_resources");
    const read = s.tools.find((t) => t.manifest.name === "mcp_read_resource");
    expect(list?.manifest.effects).toEqual(["read"]);
    expect(await list?.execute({}, ctx)).toEqual({ content: "docs\tfile:///notes.md\tNotes" });
    expect(await read?.execute({ server: "docs", uri: "file:///notes.md" }, ctx)).toEqual({
      content: "contents of file:///notes.md\n[binary image/png, 3 bytes]",
    });
    await expect(read?.execute({ server: "nope", uri: "x" }, ctx)).rejects.toThrow(
      /no MCP server named nope/,
    );
    s.close();
  });

  it("lists prompts and fills one in", async () => {
    const srv = fakeServer();
    const s = await startMcpServers([{ name: "gh", config: { command: "x" } }], {
      spawn: srv.spawn,
    });
    expect(s.prompts.map((p) => `${p.server}/${p.prompt.name}`)).toEqual(["gh/review"]);
    expect(await s.getPrompt("gh", "review", { pr: "42" })).toBe('Review PR {"pr":"42"}');
    s.close();
  });

  it("re-reads a server's tools when it says they changed, and answers its pings", async () => {
    const srv = fakeServer();
    const s = await startMcpServers([{ name: "live", config: { command: "x" } }], {
      spawn: srv.spawn,
    });
    const names = () =>
      s
        .currentTools()
        .map((t) => t.manifest.name)
        .filter((n) => n.startsWith("mcp__"));
    expect(names()).toEqual(["mcp__live__search"]);
    srv.changeTools(["search", "fetch"]);
    await settle();
    expect(names()).toEqual(["mcp__live__search", "mcp__live__fetch"]);
    srv.ping();
    await settle();
    expect(srv.replies).toEqual([{ jsonrpc: "2.0", id: 99, result: {} }]);
    s.close();
  });
});
