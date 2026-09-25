import { estimateMessagesTokens } from "@amb/context";
import type { NewEvent } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { Msg } from "../src/ports.js";
import {
  FixtureClient,
  TEXT_1M,
  TEXT_200K,
  VISION_32K,
  catalogOf,
  runOpts,
} from "./fixtures/catalog.js";

const readCall = (n: number) => ({
  content: "",
  toolCalls: [{ id: `tc_${n}`, name: "list", args: { path: "." }, rawArgs: "{}" }],
});

describe("switching models mid-run", () => {
  it("applies a /model switch at the next turn boundary and says so", async () => {
    const events: NewEvent[] = [];
    let pending: string | undefined;
    const client = new FixtureClient(catalogOf(TEXT_200K, TEXT_1M), [
      (p) => {
        pending = TEXT_1M.id; // the user flips models while the first turn is in flight
        return readCall(1);
      },
      { content: "done on the 1M model", toolCalls: [] },
    ]);
    const res = await new Agent(client).run(
      "build it",
      runOpts({
        requestedModel: TEXT_200K.id,
        emit: (e) => events.push(e),
        nextModel: () => {
          const m = pending;
          pending = undefined;
          return m;
        },
      }),
    );
    expect(client.calls.map((c) => c.model)).toEqual([TEXT_200K.id, TEXT_1M.id]);
    expect(res.finalText).toBe("done on the 1M model");
    const h = events.find((e) => e.kind === "handoff") as
      | { from: string; to: string; role: string }
      | undefined;
    expect(h).toMatchObject({ from: TEXT_200K.id, to: TEXT_1M.id, role: "user" });
  });

  it("1M → 32K mid-run re-fits the conversation so the next request FITS the small window", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const ws = await mkdtemp(join(tmpdir(), "amb-switch-"));
    try {
      for (const n of [1, 2, 3])
        await writeFile(
          join(ws, `big${n}.txt`),
          `file ${n}: line of source code here\n`.repeat(3_000),
        ); // ~100 KB
      const readBig = (n: number) => ({
        content: "",
        toolCalls: [
          {
            id: `tc_${n}`,
            name: "read",
            args: { path: `big${n}.txt` },
            rawArgs: `{"path":"big${n}.txt"}`,
          },
        ],
      });
      let pending: string | undefined;
      const client = new FixtureClient(catalogOf(TEXT_1M, VISION_32K), [
        readBig(1),
        readBig(2),
        () => {
          pending = VISION_32K.id;
          return readBig(3);
        },
        ...Array.from({ length: 6 }, () => ({ content: "## Goal\nsummary / done", toolCalls: [] })),
      ]);
      await new Agent(client).run(
        "survey the repo",
        runOpts({
          requestedModel: TEXT_1M.id,
          maxTurns: 8,
          cwd: ws,
          workspaceRoot: ws,
          nextModel: () => {
            const m = pending;
            pending = undefined;
            return m;
          },
        }),
      );
      const small = client.calls.filter((c) => c.model === VISION_32K.id && c.tools.length > 0);
      expect(small.length).toBeGreaterThan(0);
      for (const c of small) {
        expect(estimateMessagesTokens(c.messages as Msg[]) + c.maxTokens).toBeLessThanOrEqual(
          32_768,
        );
      }
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("switching from a vision model to a blind one stubs the image parts (no 400)", async () => {
    let pending: string | undefined;
    const client = new FixtureClient(catalogOf(VISION_32K, TEXT_200K), [
      (p) => {
        pending = TEXT_200K.id;
        return readCall(1);
      },
      { content: "ok", toolCalls: [] },
    ]);
    await new Agent(client).run(
      "what's in the picture?",
      runOpts({
        requestedModel: VISION_32K.id,
        attachments: [
          {
            id: "img1",
            mediaType: "image/png",
            dataBase64: "iVBORw0KGgo=",
            bytes: 8,
            sha256: "abc",
            source: "file",
          },
        ],
        nextModel: () => {
          const m = pending;
          pending = undefined;
          return m;
        },
      }),
    );
    const blind = client.calls.find((c) => c.model === TEXT_200K.id);
    expect(blind).toBeDefined();
    const hasImage = (blind?.messages ?? []).some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => (p as { type?: string }).type === "image_url"),
    );
    expect(hasImage).toBe(false);
    expect(client.calls[0]?.messages.some((m) => Array.isArray(m.content))).toBe(true); // it WAS sent natively first
  });
});
