import {
  discoverInjectableSkills,
  loadInstructions,
  readMemory,
  repoMap,
  writeMemory,
} from "@amb/context";
import type { WorkspaceContextPort } from "@amb/runtime";
import { gitState } from "./git-state.js";

/**
 * The real workspace-context port: routes the runtime's fs/env reads (project instructions, durable memory,
 * clock, platform) through @amb/context + node at the CLI edge — so the runtime state machine itself stays
 * free of direct effects and remains deterministic/replayable. `now` is injectable for tests.
 */
export function makeWorkspaceContextPort(now: () => Date = () => new Date()): WorkspaceContextPort {
  return {
    instructions: (cwd) => loadInstructions(cwd).text,
    readMemory: (workspaceRoot) => readMemory(workspaceRoot),
    writeMemory: (workspaceRoot, summary) => writeMemory(workspaceRoot, summary),
    date: () => now().toISOString().slice(0, 10),
    platform: () => process.platform,
    // Only the CURATED skills auto-load into the prompt (the user's own) — the hundreds of bundled plugin +
    // Codex skills are discoverable via `ambient skills` and evocable by name, not force-fed every turn.
    skills: (workspaceRoot) => discoverInjectableSkills(workspaceRoot),
    repoMap: (workspaceRoot, tokenBudget) => repoMap(workspaceRoot, tokenBudget),
    // Read-only git snapshot (branch / changed files / recent commits) at run start — so the agent isn't
    // blind to git without spending tool calls. Undefined outside a repo.
    git: (cwd) => gitState(cwd),
  };
}
