import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchSlash } from "../src/tui/components/SlashPalette.js";
import { fuzzyRank, fuzzyScore } from "../src/tui/fuzzy.js";
import {
  IDLE_NAV,
  appendHistory,
  historyPath,
  loadHistory,
  navNewer,
  navOlder,
  searchHistory,
} from "../src/tui/history.js";

describe("fuzzy matching", () => {
  it("matches subsequences and prefers word starts and prefixes", () => {
    expect(fuzzyScore("mdl", "/model")).toBeDefined();
    expect(fuzzyScore("xyz", "/model")).toBeUndefined();
    const ranked = fuzzyRank("mo", ["/memory", "/model", "/compact"], (s) => s);
    expect(ranked[0]).toBe("/model");
    expect(fuzzyRank("ports", ["src/support/x.ts", "src/agent/ports.ts"], (s) => s)[0]).toBe(
      "src/agent/ports.ts",
    );
  });
});

describe("slash menu matching", () => {
  it("falls back to loose matching only when no command starts with what was typed", () => {
    expect(matchSlash("/mod").map((c) => c.name)).toEqual(["/model"]);
    expect(matchSlash("/thnk")[0]?.name).toBe("/thinking");
    expect(matchSlash("/lgot")[0]?.name).toBe("/logout");
  });
  it("never loosely matches a path typed at the start of a prompt", () => {
    expect(matchSlash("/tmp/shot.png what is this")).toEqual([]);
    expect(matchSlash("/Users/me/notes.md")).toEqual([]);
    expect(matchSlash("/q")).toEqual([{ name: "/quit", desc: "Exit ambient" }]);
  });
});

describe("prompt history", () => {
  it("persists per workspace, skips consecutive duplicates, and searches newest-first", () => {
    const home = mkdtempSync(join(tmpdir(), "amb-hist-"));
    try {
      const p = historyPath("/w/proj", home);
      for (const t of ["fix the parser", "fix the parser", "add tests", "fix the lexer"])
        appendHistory(p, t);
      expect(loadHistory(p)).toEqual(["fix the parser", "add tests", "fix the lexer"]);
      expect(historyPath("/w/other", home)).not.toBe(p);
      const entries = loadHistory(p);
      expect(searchHistory(entries, "fix")?.text).toBe("fix the lexer");
      expect(searchHistory(entries, "fix", 2)?.text).toBe("fix the parser");
      expect(searchHistory(entries, "nothing")).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("history navigation", () => {
  const entries = ["one", "two", "three"];
  it("walks older from the newest, keeps the draft, and restores it past the newest", () => {
    let r = navOlder(entries, IDLE_NAV, "half-typed");
    expect(r.text).toBe("three");
    r = navOlder(entries, r.nav, "three");
    expect(r.text).toBe("two");
    r = navOlder(entries, r.nav, "two");
    r = navOlder(entries, r.nav, "one");
    expect(r.text).toBeUndefined(); // already at the oldest
    let n = navNewer(entries, r.nav);
    expect(n.text).toBe("two");
    n = navNewer(entries, n.nav);
    n = navNewer(entries, n.nav);
    expect(n.text).toBe("half-typed");
    expect(n.nav.index).toBeUndefined();
    expect(navNewer(entries, n.nav).text).toBeUndefined();
  });
  it("does nothing with an empty history", () => {
    expect(navOlder([], IDLE_NAV, "x").text).toBeUndefined();
  });
});
