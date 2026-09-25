import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type HookCommand,
  type McpServerSpec,
  type RuleLists,
  discoverHooks,
  discoverRuleLists,
  hooksFingerprint,
  loadMcpConfig,
} from "@amb/context";
import { type PermissionRules, parseRules } from "@amb/permissions";
import type { HooksPort } from "@amb/runtime";
import { hooksPort } from "./hooks.js";

/**
 * What a workspace's settings files ask for — hooks and permission rules — and whether each part applies.
 * Anything that only RESTRICTS (deny and ask rules) applies from every source. Anything that runs commands
 * or loosens approval does not apply from a project's own files (which arrive with a clone) until the user
 * trusts exactly that configuration, nor from ~/.claude and plugins (written for Claude Code) until the user
 * opts in with `claudeSettings`.
 */

export interface SettingsConfig {
  hooks?: unknown;
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  claudeSettings?: boolean;
}

/** Where trusted project settings are remembered, by workspace. */
export function trustFilePath(configFolder: string): string {
  return join(configFolder, "trusted-projects.json");
}

function readTrust(file: string): Record<string, string> {
  try {
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** What identifies a project MCP server for trust: what it runs or where it connects (not secret values). */
function mcpIdentity(s: McpServerSpec): unknown[] {
  return [
    s.name,
    s.transport,
    s.command ?? "",
    s.args ?? [],
    s.url ?? "",
    Object.keys(s.env ?? {}).sort(),
    Object.keys(s.headers ?? {}).sort(),
  ];
}

/** Trust is granted to exactly this configuration: the project's hooks, allow rules and MCP servers. */
export function projectFingerprint(
  hooks: readonly HookCommand[],
  allow: readonly string[],
  mcp: readonly McpServerSpec[] = [],
): string {
  return createHash("sha256")
    .update(JSON.stringify([hooksFingerprint(hooks), allow, mcp.map(mcpIdentity)]))
    .digest("hex")
    .slice(0, 32);
}

function saveTrust(file: string, workspaceRoot: string, fingerprint: string): void {
  const next = { ...readTrust(file), [workspaceRoot]: fingerprint };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const HOOK_SOURCE: Record<HookCommand["source"], string> = {
  ambient: "ambient config",
  project: "this project (.claude/settings)",
  "claude-user": "~/.claude/settings.json",
  plugin: "a Claude Code plugin",
};

function describeHook(h: HookCommand): string {
  const on = h.matcher && h.matcher !== "*" ? `${h.event}(${h.matcher})` : h.event;
  const cmd = h.command.length > 70 ? `${h.command.slice(0, 69)}…` : h.command;
  return `  ${on} → ${cmd}`;
}

interface Snapshot {
  activeHooks: HookCommand[];
  waitingHooks: HookCommand[];
  offHooks: number;
  rules: PermissionRules;
  ruleSources: Array<{ label: string; lists: RuleLists; allowApplies: boolean }>;
  waitingAllow: string[];
  offAllow: number;
  projectHooks: HookCommand[];
  projectAllow: string[];
  projectMcp: McpServerSpec[];
  trusted: boolean;
}

/** The workspace's settings, re-read on every use so edits and trust changes apply without a restart. */
export interface WorkspaceSettings {
  /** The hooks for the next run (undefined when none would run). */
  hooksPort(sessionId: () => string): HooksPort | undefined;
  /** The permission rules for the next run (undefined when there are none). */
  rules(): PermissionRules | undefined;
  /** What `/hooks` shows. */
  hooksSummary(): string[];
  /** What `/permissions` shows. */
  permissionsSummary(): string[];
  /** What the project's own settings would add if trusted (for review before `/trust yes`). */
  trustSummary(): string[];
  /** Trust the project's current hooks and allow rules; returns what happened. */
  trust(): string;
  /** How many project hooks, allow rules and MCP servers are waiting to be trusted. */
  untrustedCount(): number;
  /** Whether the project's own settings (hooks, allow rules, MCP servers) are trusted as they are now. */
  projectTrusted(): boolean;
}

export function makeWorkspaceSettings(opts: {
  workspaceRoot: string;
  config: SettingsConfig;
  trustFile: string;
  home?: string;
}): WorkspaceSettings {
  const home = opts.home ?? homedir();
  const claude = opts.config.claudeSettings === true;

  const snapshot = (): Snapshot => {
    const hooks = discoverHooks({
      workspaceRoot: opts.workspaceRoot,
      home,
      ambientSettings: opts.config.hooks ? { hooks: opts.config.hooks } : undefined,
    });
    const lists = discoverRuleLists({ workspaceRoot: opts.workspaceRoot, home });
    const ambient: RuleLists = {
      allow: opts.config.permissions?.allow ?? [],
      deny: opts.config.permissions?.deny ?? [],
      ask: opts.config.permissions?.ask ?? [],
    };
    const projectMcp = loadMcpConfig(opts.workspaceRoot, process.env, home).filter(
      (m) => m.source === "project",
    );
    const trusted =
      (hooks.project.length > 0 || lists.project.allow.length > 0 || projectMcp.length > 0) &&
      readTrust(opts.trustFile)[opts.workspaceRoot] ===
        projectFingerprint(hooks.project, lists.project.allow, projectMcp);
    const ruleSources = [
      { label: "ambient config", lists: ambient, allowApplies: true },
      { label: "this project (.claude/settings)", lists: lists.project, allowApplies: trusted },
      { label: "~/.claude/settings.json", lists: lists.claudeUser, allowApplies: claude },
    ];
    const all = (k: keyof RuleLists) => ruleSources.flatMap((s) => s.lists[k]);
    return {
      activeHooks: [
        ...hooks.ambient,
        ...(trusted ? hooks.project : []),
        ...(claude ? [...hooks.claudeUser, ...hooks.plugins] : []),
      ],
      waitingHooks: trusted ? [] : hooks.project,
      offHooks: claude ? 0 : hooks.claudeUser.length + hooks.plugins.length,
      rules: {
        allow: parseRules(ruleSources.filter((s) => s.allowApplies).flatMap((s) => s.lists.allow)),
        deny: parseRules(all("deny")),
        ask: parseRules(all("ask")),
      },
      ruleSources,
      waitingAllow: trusted ? [] : lists.project.allow,
      offAllow: claude ? 0 : lists.claudeUser.allow.length,
      projectHooks: hooks.project,
      projectAllow: lists.project.allow,
      projectMcp,
      trusted,
    };
  };

  const trustHint = (lines: string[], s: Snapshot) => {
    const waiting = s.waitingHooks.length + s.waitingAllow.length;
    if (waiting === 0) return;
    lines.push(
      "Review them with /trust (ambient trust in a shell). A later change needs trusting again.",
    );
  };
  const gap = (lines: string[]) => {
    if (lines.length > 0) lines.push("");
  };

  return {
    hooksPort: (sessionId) => hooksPort(snapshot().activeHooks, opts.workspaceRoot, sessionId),
    rules() {
      const { rules } = snapshot();
      return rules.allow.length + rules.deny.length + rules.ask.length > 0 ? rules : undefined;
    },
    hooksSummary() {
      const s = snapshot();
      const lines: string[] = [];
      if (s.activeHooks.length === 0 && s.waitingHooks.length === 0)
        lines.push("No hooks will run.");
      else if (s.activeHooks.length > 0) {
        lines.push(`${plural(s.activeHooks.length, "hook")} will run:`);
        for (const source of Object.keys(HOOK_SOURCE) as HookCommand["source"][]) {
          const group = s.activeHooks.filter((h) => h.source === source);
          if (group.length === 0) continue;
          lines.push(` From ${HOOK_SOURCE[source]}:`);
          for (const h of group) lines.push(describeHook(h));
        }
      }
      const waiting = s.waitingHooks.length;
      if (waiting > 0) {
        gap(lines);
        lines.push(
          `This project has ${plural(waiting, "hook")} that won't run until you trust ${waiting === 1 ? "it" : "them"}:`,
        );
        for (const h of s.waitingHooks) lines.push(describeHook(h));
        trustHint(lines, s);
      }
      if (s.offHooks > 0) {
        gap(lines);
        lines.push(
          `${plural(s.offHooks, "Claude Code hook")} from ~/.claude and plugins ${s.offHooks === 1 ? "is" : "are"} off. Set "claudeSettings": true in ambient's config to use them.`,
        );
      }
      return lines;
    },
    permissionsSummary() {
      const s = snapshot();
      const lines: string[] = [];
      for (const src of s.ruleSources) {
        const { allow, deny, ask } = src.lists;
        if (allow.length + deny.length + ask.length === 0) continue;
        gap(lines);
        lines.push(`From ${src.label}:`);
        if (deny.length > 0) lines.push(`  deny   ${deny.join(" · ")}`);
        if (ask.length > 0) lines.push(`  ask    ${ask.join(" · ")}`);
        if (allow.length > 0)
          lines.push(`  allow  ${allow.join(" · ")}${src.allowApplies ? "" : "  (not applied)"}`);
      }
      if (lines.length === 0) {
        lines.push(
          'No permission rules. Add them under "permissions" in ambient\'s config, e.g. {"allow": ["Bash(npm test:*)"], "deny": ["Read(./.env)"]}.',
        );
        return lines;
      }
      if (s.waitingAllow.length > 0) {
        gap(lines);
        lines.push("This project's allow rules apply once you trust them.");
        trustHint(lines, s);
      }
      if (s.offAllow > 0) {
        gap(lines);
        lines.push(
          `Allow rules from ~/.claude apply when you set "claudeSettings": true in ambient's config.`,
        );
      }
      return lines;
    },
    untrustedCount() {
      const s = snapshot();
      return s.trusted ? 0 : s.projectHooks.length + s.projectAllow.length + s.projectMcp.length;
    },
    projectTrusted: () => snapshot().trusted,
    trustSummary() {
      const s = snapshot();
      const total = s.projectHooks.length + s.projectAllow.length + s.projectMcp.length;
      if (total === 0) return ["This project has no hooks, allow rules or MCP servers of its own."];
      const lines: string[] = [
        s.trusted
          ? "This project's settings are trusted:"
          : "This project's settings ask for the following, which won't apply until you trust them:",
      ];
      if (s.projectHooks.length > 0) {
        lines.push(" Hooks (commands that run on your machine):");
        for (const h of s.projectHooks) lines.push(describeHook(h));
      }
      if (s.projectAllow.length > 0) {
        lines.push(" Allow rules (calls that run without asking):");
        for (const r of s.projectAllow) lines.push(`  ${r}`);
      }
      if (s.projectMcp.length > 0) {
        lines.push(" MCP servers:");
        for (const m of s.projectMcp) {
          const what = m.command ? [m.command, ...(m.args ?? [])].join(" ") : (m.url ?? "");
          lines.push(`  ${m.name} → ${what.length > 70 ? `${what.slice(0, 69)}…` : what}`);
        }
      }
      if (!s.trusted)
        lines.push("", "Type /trust yes to trust exactly this (ambient trust yes in a shell).");
      return lines;
    },
    trust() {
      const s = snapshot();
      const hooks = s.projectHooks.length;
      const allow = s.projectAllow.length;
      const mcp = s.projectMcp.length;
      if (hooks + allow + mcp === 0)
        return "This project has no hooks, allow rules or MCP servers to trust.";
      if (s.trusted) return "This project's settings are already trusted.";
      try {
        saveTrust(
          opts.trustFile,
          opts.workspaceRoot,
          projectFingerprint(s.projectHooks, s.projectAllow, s.projectMcp),
        );
      } catch (e) {
        return `Couldn't save the trust setting: ${(e as Error).message}`;
      }
      const parts = [
        ...(hooks > 0 ? [plural(hooks, "hook")] : []),
        ...(allow > 0 ? [plural(allow, "allow rule")] : []),
        ...(mcp > 0 ? [plural(mcp, "MCP server")] : []),
      ];
      const list =
        parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
      return `Trusted this project's ${list}. ${mcp > 0 ? "MCP servers connect the next time ambient starts; the rest apply" : "They apply"} from the next message.`;
    },
  };
}

/** The workspace's settings as ambient's config sets them up (the one place CLI entry points build them). */
export function workspaceSettings(
  workspaceRoot: string,
  config: SettingsConfig,
  configFolder: string,
): WorkspaceSettings {
  return makeWorkspaceSettings({ workspaceRoot, config, trustFile: trustFilePath(configFolder) });
}

/** A one-line heads-up when the project has settings that won't apply yet (headless runs can't ask). */
export function untrustedNote(settings: WorkspaceSettings): string | undefined {
  return settings.untrustedCount() > 0
    ? "This project has hooks, allow rules or MCP servers that won't apply until you trust them (ambient trust)."
    : undefined;
}
