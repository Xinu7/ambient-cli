import type { Effect, Grant, Mode, PermissionDecision, PermissionInput } from "@amb/protocol";
import { classifyToolRisk } from "./risk.js";

/**
 * The DD-1 permission engine. Evaluated deny-first, then the mode ladder, then a local risk overlay.
 *
 * Order:
 *   1. Read-only effects are always allowed (reads never mutate).
 *   2. Bypass allows everything else (the user explicitly trusts this run).
 *   3. Hard refusal (non-bypass): write/exec touching a path outside the workspace boundary.
 *   4. A matching prior grant allows.
 *   5. The mode decides: plan = deny (read-only), ask = ask, accept-edits = auto file edits / ask shell.
 *   6. Risk overlay: a call the classifier flags turns an otherwise-automatic allow into an ask, and
 *      annotates asks — but NEVER overrides bypass or an explicit grant (DD-1).
 *
 * The model can never grant itself authority — grants come only from a human decision or config.
 */

function isReadOnly(effects: Effect[]): boolean {
  return effects.length > 0 && effects.every((e) => e === "read");
}

function withinWorkspace(root: string, p: string): boolean {
  const nr = root.endsWith("/") ? root : `${root}/`;
  return p === root || p.startsWith(nr);
}

function anyOutside(resources: string[], root: string): boolean {
  return resources.some((r) => !withinWorkspace(root, r));
}

function matchingGrant(input: PermissionInput): Grant | undefined {
  return input.grants.find((g) => {
    if (g.toolName !== input.toolName && g.toolName !== "*") return false;
    if (g.scope === "resource") {
      return g.resource !== undefined && input.resolvedResources.includes(g.resource);
    }
    return true; // once / session / project apply to the tool broadly
  });
}

const allow = (
  reason: string,
  grantScope?: PermissionDecision["grantScope"],
): PermissionDecision =>
  grantScope === undefined ? { effect: "allow", reason } : { effect: "allow", reason, grantScope };
const ask = (reason: string): PermissionDecision => ({ effect: "ask", reason });
const deny = (reason: string): PermissionDecision => ({ effect: "deny", reason });

function baseDecide(input: PermissionInput): PermissionDecision {
  const { mode, effects } = input;

  if (isReadOnly(effects)) return allow("read-only");
  // A tool declaring ZERO effects has, by its own manifest, no fs/process/network/secret side effect — there
  // is nothing to gate (e.g. `ask_user`, which only asks the human a question). Safe because our MCP→tool
  // mapping never emits empty effects for untrusted tools (readOnlyHint → read, else process).
  if (effects.length === 0) return allow("no side effect");
  if (mode === "bypass") return allow("bypass mode");

  const mutatesFs = effects.includes("write") || effects.includes("process");
  if (mutatesFs && anyOutside(input.resolvedResources, input.workspaceRoot)) {
    return deny(
      "write/exec outside the workspace boundary is refused (switch to bypass to override)",
    );
  }

  const grant = matchingGrant(input);
  if (grant) return allow("covered by an existing grant", grant.scope);

  switch (mode) {
    case "plan":
      return deny("plan mode is read-only");
    case "accept-edits":
      return effects.every((e) => e === "read" || e === "write")
        ? allow("accept-edits: auto-approved file edit")
        : ask("accept-edits gates shell / network / secrets");
    default:
      return ask("approval required");
  }
}

/**
 * A brake on runaway autonomy: after this many consecutive auto-approved mutations in accept-edits, the
 * next one becomes a human checkpoint. Does NOT apply to bypass (DD-1: bypass = no prompts).
 */
export const MAX_CONSECUTIVE_AUTO_APPROVALS = 25;

function applyRisk(base: PermissionDecision, input: PermissionInput): PermissionDecision {
  const risk = classifyToolRisk(input.toolName, input.normalizedArgs);
  if (risk.level === "none") return base;
  const note = `${risk.level === "critical" ? "CRITICAL risk" : "elevated risk"}: ${risk.reasons.join("; ")}`;
  if (base.effect === "allow") {
    // DD-1: bypass + explicit grants + pure reads are honored as-is (no prompt, no downgrade).
    if (input.mode === "bypass" || matchingGrant(input) || isReadOnly(input.effects)) return base;
    // An accept-edits auto-approval of a risky write must get a human look.
    return ask(`${base.reason}; ${note}`);
  }
  if (base.effect === "ask") return ask(`${base.reason}; ${note}`);
  return base; // a deny stays a deny
}

/**
 * The mode a SUBAGENT runs under, given its parent's mode + role. A child is NEVER more permissive than its
 * parent (safety): read-only scouts/oracles are forced to `plan` (their write attempts are denied without
 * even opening an ask); a builder inherits the parent's mode. Pure.
 */
export function capMode(parentMode: Mode, role: "scout" | "oracle" | "builder"): Mode {
  if (role === "scout" || role === "oracle") return "plan";
  return parentMode; // builder: same as the parent, never widened
}

export function decide(input: PermissionInput): PermissionDecision {
  const afterRisk = applyRisk(baseDecide(input), input);
  // Autonomy brake: a long unbroken run of auto-approved edits gets a periodic human checkpoint. Only in
  // accept-edits (bypass is untouched per DD-1) and only for mutations (reads are free and never counted).
  const cap = input.autoApprovalCap ?? MAX_CONSECUTIVE_AUTO_APPROVALS;
  if (
    afterRisk.effect === "allow" &&
    input.mode === "accept-edits" &&
    !isReadOnly(input.effects) &&
    !matchingGrant(input) && // DD-1: an explicit grant is never re-prompted, even at the cap (audit #13)
    (input.autoApprovalStreak ?? 0) >= cap
  ) {
    return ask(`periodic review checkpoint after ${cap} auto-approved edits`);
  }
  return afterRisk;
}
