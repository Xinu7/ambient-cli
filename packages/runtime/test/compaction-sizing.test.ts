import { estimateMessagesTokens } from "@amb/context";
import { describe, expect, it } from "vitest";
import { SUMMARY_MARKER } from "../src/agent-support.js";
import { compact } from "../src/compaction-runner.js";
import type { Msg } from "../src/ports.js";
import { FixtureClient, TEXT_200K, catalogOf, raw } from "./fixtures/catalog.js";

/** A conversation whose middle (~60K tokens) is far larger than a small compactor's window. */
function hugeConversation(): Msg[] {
  const msgs: Msg[] = [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "the task", pinned: true },
  ];
  for (let i = 0; i < 80; i++) {
    msgs.push({ role: i % 2 ? "user" : "assistant", content: `turn ${i} ${"w ".repeat(1400)}` });
  }
  return msgs;
}

describe("compaction summary sizing", () => {
  it("splits a middle larger than the compactor's window into requests that each FIT it", async () => {
    // Pricing makes the small model the cheapest → it is routed the compaction.
    const tiny = raw({
      id: "fixture/tiny-8k",
      context_length: 8_192,
      max_output_length: 2_048,
      pricing: { input: 0.01, output: 0.01 },
    });
    const catalog = catalogOf(TEXT_200K, tiny);
    const client = new FixtureClient(
      catalog,
      Array.from({ length: 40 }, (_, i) => ({
        content: `## Goal\nrolling summary ${i}`,
        toolCalls: [],
      })),
    );
    const out = await compact(
      client,
      hugeConversation(),
      TEXT_200K.id,
      catalog,
      "ses_s",
      "trn_s",
      () => {},
      new AbortController().signal,
      () => {},
      60_000,
      "",
    );
    const calls = client.calls.filter((c) => c.model === "fixture/tiny-8k");
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(estimateMessagesTokens(c.messages) + c.maxTokens).toBeLessThanOrEqual(8_192);
    }
    // The final summary is the LAST rolling summary (each chunk refines the previous one).
    const summary = (out ?? []).find(
      (m) => typeof m.content === "string" && m.content.startsWith(SUMMARY_MARKER),
    );
    expect(String(summary?.content)).toContain(`rolling summary ${calls.length - 1}`);
  });

  it("sizes the summary output from the compactor's catalog output cap, not a fixed 2048", async () => {
    const catalog = catalogOf(TEXT_200K);
    const client = new FixtureClient(catalog, [{ content: "## Goal\nx", toolCalls: [] }]);
    await compact(
      client,
      hugeConversation(),
      TEXT_200K.id,
      catalog,
      "ses_s",
      "trn_s",
      () => {},
      new AbortController().signal,
      () => {},
      60_000,
      "",
    );
    expect(client.calls[0]?.maxTokens).toBeGreaterThan(2048);
    expect(client.calls[0]?.maxTokens).toBeLessThanOrEqual(8192);
  });
});
