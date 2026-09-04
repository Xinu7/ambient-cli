import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/commands/tui.js";
import { configPath, grantsFromConfig, loadConfig, tuiAxesFromMode } from "../src/config.js";

let home: string;
let env: Record<string, string | undefined>;

function writeConfig(text: string): void {
  const p = configPath(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "amb-config-"));
  env = { AMB_CONFIG_HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns {} when the file is absent (all defaults)", () => {
    expect(loadConfig(env, () => {})).toEqual({});
  });

  it("parses a valid config", () => {
    writeConfig(
      JSON.stringify({ model: "z-ai/glm-5.2", effort: "high", mode: "accept-edits", maxTurns: 50 }),
    );
    expect(loadConfig(env, () => {})).toEqual({
      model: "z-ai/glm-5.2",
      effort: "high",
      mode: "accept-edits",
      maxTurns: 50,
    });
  });

  it("WARNS and ignores non-JSON rather than throwing", () => {
    writeConfig("{ not json");
    const warnings: string[] = [];
    expect(loadConfig(env, (m) => warnings.push(m))).toEqual({});
    expect(warnings[0]).toContain("not valid JSON");
  });

  it("WARNS and ignores a schema-invalid value (e.g. a bogus effort)", () => {
    writeConfig(JSON.stringify({ effort: "ludicrous" }));
    const warnings: string[] = [];
    expect(loadConfig(env, (m) => warnings.push(m))).toEqual({});
    expect(warnings[0]).toContain("invalid");
  });

  it("rejects an out-of-range maxTurns", () => {
    writeConfig(JSON.stringify({ maxTurns: 99999 }));
    expect(loadConfig(env, () => {})).toEqual({});
  });

  it("strips unknown keys (forward-compatible)", () => {
    writeConfig(JSON.stringify({ model: "a/b", futureField: true }));
    expect(loadConfig(env, () => {})).toEqual({ model: "a/b" });
  });
});

describe("tuiAxesFromMode", () => {
  it("maps plan to the read-only agent mode", () => {
    expect(tuiAxesFromMode("plan")).toEqual({ agentMode: "plan", permission: "ask" });
  });
  it("maps the permission modes onto the permission axis with agentMode=build", () => {
    expect(tuiAxesFromMode("ask")).toEqual({ agentMode: "build", permission: "ask" });
    expect(tuiAxesFromMode("accept-edits")).toEqual({
      agentMode: "build",
      permission: "accept-edits",
    });
    expect(tuiAxesFromMode("bypass")).toEqual({ agentMode: "build", permission: "bypass" });
  });
});

describe("grantsFromConfig", () => {
  it("seeds session-scoped grants from the allowlist", () => {
    expect(grantsFromConfig({ allow: ["bash", "web_fetch"] })).toEqual([
      { scope: "session", toolName: "bash" },
      { scope: "session", toolName: "web_fetch" },
    ]);
  });
  it("is empty when no allowlist is set", () => {
    expect(grantsFromConfig({})).toEqual([]);
  });
});

describe("config precedence — config sets defaults, a flag overrides", () => {
  it("uses config values when no flag is present", () => {
    const a = parseArgs([], { model: "z-ai/glm-5.2", effort: "high", mode: "bypass", maxTurns: 7 });
    expect(a.model).toBe("z-ai/glm-5.2");
    expect(a.effort).toBe("high");
    expect(a.permission).toBe("bypass");
    expect(a.agentMode).toBe("build");
    expect(a.maxTurns).toBe(7);
  });

  it("a flag WINS over the config default", () => {
    const a = parseArgs(["--model", "moonshotai/kimi-k2.7-code", "--effort", "off", "--plan"], {
      model: "z-ai/glm-5.2",
      effort: "high",
      mode: "bypass",
    });
    expect(a.model).toBe("moonshotai/kimi-k2.7-code"); // --model beat config.model
    expect(a.effort).toBe("off"); // --effort beat config.effort
    expect(a.agentMode).toBe("plan"); // --plan beat config.mode=bypass
  });

  it("falls back to built-in defaults with no config and no flags", () => {
    const a = parseArgs([]);
    expect(a.effort).toBe("auto");
    expect(a.permission).toBe("ask");
    expect(a.agentMode).toBe("build");
    expect(a.maxTurns).toBe(30);
  });

  it("parses --goal (and -g) into a length-capped north-star", () => {
    expect(parseArgs(["--goal", "ship the CSV export"]).goal).toBe("ship the CSV export");
    expect(parseArgs(["-g", "  trim me  "]).goal).toBe("trim me");
    expect(parseArgs([]).goal).toBeUndefined();
    expect(parseArgs(["--goal", "x".repeat(400)]).goal?.length).toBe(280);
  });
});
