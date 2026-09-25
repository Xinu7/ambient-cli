import { describe, expect, it } from "vitest";
import { compactConversation } from "../src/index.js";
import type { Msg } from "../src/ports.js";
import { FixtureClient, TEXT_200K, catalogOf } from "./fixtures/catalog.js";

/** A short session — far below what automatic compaction would ever touch on a 200K model. */
const session = (): Msg[] => [
  { role: "system", content: "rules" },
  ...Array.from({ length: 12 }, (_, i): Msg[] => [
    { role: "user", content: `step ${i}: ${"detail ".repeat(200)}` },
    { role: "assistant", content: `did step ${i} ${"done ".repeat(200)}` },
  ]).flat(),
];

const run = (
  client: FixtureClient,
  messages: Msg[],
  opts?: { keepRecentTokens?: number; focus?: string },
) =>
  compactConversation(
    client,
    messages,
    TEXT_200K.id,
    catalogOf(TEXT_200K),
    "ses_c",
    "trn_c",
    () => {},
    new AbortController().signal,
    () => {},
    200_000,
    "",
    opts,
  );

describe("compacting on request", () => {
  it("automatic settings leave a short session alone, a request compacts it", async () => {
    const auto = await run(new FixtureClient(catalogOf(TEXT_200K), []), session());
    expect(auto).toBeNull();
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      { content: "## Goal\nsteps\n## Progress\nall twelve", toolCalls: [] },
    ]);
    const next = await run(client, session(), {
      keepRecentTokens: 500,
      focus: "the parser changes",
    });
    expect(next).not.toBeNull();
    expect(next?.length).toBeLessThan(session().length);
    const instruction = String(client.calls[0]?.messages[0]?.content);
    expect(instruction).toContain("focus on: the parser changes");
  });
});
