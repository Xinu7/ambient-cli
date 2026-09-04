import { capMode } from "@amb/permissions";
import { type Mode, type NewEvent, newSessionId } from "@amb/protocol";
import type { RoutedRole } from "@amb/reliability";
import type { ToolRegistry } from "@amb/tools-core";
import { capToolResult } from "./agent-support.js";
import { Agent } from "./agent.js";
import type {
  Approver,
  CapabilityPort,
  ChatClient,
  EffortSetting,
  RunOptions,
  VerifyPort,
  WorkspaceContextPort,
} from "./ports.js";

export type SubagentRole = "scout" | "oracle" | "builder";

export interface SubagentSpec {
  label: string;
  role: SubagentRole;
  prompt: string;
  preset?: string;
  model?: string;
  /** Ambient tool names a resolved preset restricts this child to (∩ the role's read/write constraint).
   *  Undefined ⇒ the role default (all read-only for scout/oracle, all builtins for builder). */
  allowedTools?: string[];
}

export interface SubagentFileChange {
  path: string;
  operation: "create" | "modify" | "delete";
}
export interface SubagentChildResult {
  label: string;
  role: SubagentRole;
  stopReason: string;
  turns: number;
  summary: string;
  files?: SubagentFileChange[];
}
export interface SubagentRunResult {
  summary: string;
  results: SubagentChildResult[];
  files?: SubagentFileChange[];
}

/** The parent-attempt correlation a subagent tool receives from its ToolContext. */
export interface SubagentCtx {
  scope: { sessionId: string; turnId: string; attemptId: string };
  toolCallId: string;
  emit: (ev: NewEvent) => void;
  signal: AbortSignal;
  cwd: string;
  workspaceRoot: string;
}

/** Everything the orchestrator needs, injected at the CLI edge (keeps the runtime pure w.r.t. fs). */
export interface SubagentDeps {
  client: ChatClient;
  workspace: WorkspaceContextPort;
  approve: Approver;
  parentMode: Mode;
  capabilities?: CapabilityPort;
  effort?: EffortSetting;
  /** The parent run's north-star goal — inherited so a child stays aligned to the same objective. */
  goal?: string;
  verify?: VerifyPort;
  /** Build a child's registry for a role — MUST NOT include the `subagent` tool (structural depth cap).
   *  `allowedTools` (from a resolved preset) further restricts the registry to that intersection. */
  buildChildRegistry: (role: SubagentRole, allowedTools?: string[]) => ToolRegistry;
  /** A durable event sink for a child's OWN session (persists to its own JSONL). */
  childSink: (childSessionId: string) => (ev: NewEvent) => void;
  /** Session-scoped artifact store for a child: given the child's session id, returns the offload/
   *  retrieve ports bound to THAT child's blob store — so a subagent's large tool outputs are recoverable via
   * read_artifact instead of lost, and its `read_artifact` builtin isn't a dead tool. */
  artifactStore?: (childSessionId: string) => {
    save: (content: string) => string | undefined;
    read: (handle: string) => string | undefined;
  };
  maxConcurrent?: number;
  now?: () => number;
}

const TIMEOUT_MS: Record<SubagentRole, number> = {
  scout: 120_000,
  oracle: 180_000,
  builder: 300_000,
};
const MAX_TURNS: Record<SubagentRole, number> = { scout: 12, oracle: 12, builder: 20 };
/** Fleet phase routing (#27): a subagent role maps to a routed role, so an `auto` child auto-picks a
 *  role-appropriate model from the live fleet — the oracle gets a strong reviewer, a builder the best coder. */
const ROUTED_ROLE: Record<SubagentRole, RoutedRole> = {
  scout: "planner",
  oracle: "reviewer",
  builder: "executor",
};
const SUMMARY_CAP = 1200;

/**
 * Run a wave of subagents concurrently (bounded), each in its OWN isolated Agent + session, re-emitting a
 * subset of each child's activity onto the PARENT stream as `subagent.*` events so the user SEES the work.
 * Returns the aggregated (hard-capped) summaries + any builder file changes. Never spawns grandchildren — the
 * child registry excludes the subagent tool.
 */
export async function runSubagents(
  specs: SubagentSpec[],
  ctx: SubagentCtx,
  deps: SubagentDeps,
): Promise<SubagentRunResult> {
  const now = deps.now ?? Date.now;
  const limit = Math.max(1, deps.maxConcurrent ?? 4);
  const results = new Array<SubagentChildResult>(specs.length);

  // Serialize child approval prompts: the parent approver has a SINGLE resolver slot, so two builder children
  // asking concurrently would clobber each other (one promise never settles). A per-run promise chain queues
  // asks cleanly while non-asking scouts stay fully parallel.
  let approveChain: Promise<unknown> = Promise.resolve();
  const gatedApprove: Approver = (req) => {
    const run = approveChain.then(() => deps.approve(req));
    approveChain = run.catch(() => undefined);
    return run;
  };
  const childDeps: SubagentDeps = { ...deps, approve: gatedApprove };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= specs.length) return;
      results[i] = await runOneChild(specs[i] as SubagentSpec, ctx, childDeps, now);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, specs.length) }, worker));

  const files = results.flatMap((r) => r.files ?? []);
  const summary = results.map((r) => `↳ [${r.label}] ${r.summary}`).join("\n\n");
  return { summary, results, ...(files.length > 0 ? { files } : {}) };
}

function runOneChild(
  spec: SubagentSpec,
  ctx: SubagentCtx,
  deps: SubagentDeps,
  now: () => number,
): Promise<SubagentChildResult> {
  const childSessionId = newSessionId();
  const role = spec.role;
  const model = spec.model ?? "auto";
  const readOnly = role !== "builder";
  const started = now();
  const durableSink = deps.childSink(childSessionId);

  const base = {
    schemaVersion: 1 as const,
    sessionId: ctx.scope.sessionId,
    turnId: ctx.scope.turnId,
    attemptId: ctx.scope.attemptId,
    toolCallId: ctx.toolCallId,
  };

  // Re-tag: persist EVERY child event to its own log, and translate a legible subset onto the PARENT stream.
  const toolNames = new Map<string, string>();
  const filesMutated: SubagentFileChange[] = [];
  let toolCount = 0;
  const childEmit = (ev: NewEvent): void => {
    durableSink(ev);
    if (ev.kind === "file.mutation") {
      filesMutated.push({ path: ev.path, operation: ev.operation });
    } else if (ev.kind === "tool.started") {
      toolCount += 1;
      toolNames.set(ev.toolCallId, ev.toolName);
      ctx.emit({
        ...base,
        kind: "subagent.tool",
        childSessionId,
        childToolCallId: ev.toolCallId,
        toolName: ev.toolName,
        status: "running",
      });
    } else if (ev.kind === "tool.result") {
      ctx.emit({
        ...base,
        kind: "subagent.tool",
        childSessionId,
        childToolCallId: ev.toolCallId,
        toolName: toolNames.get(ev.toolCallId) ?? "tool",
        status: ev.ok ? "ok" : "fail",
        ...(ev.preview ? { preview: ev.preview } : {}),
      });
    } else if (ev.kind === "assistant.delta") {
      ctx.emit({ ...base, kind: "subagent.delta", text: ev.text });
    }
  };

  ctx.emit({
    ...base,
    kind: "subagent.started",
    childSessionId,
    role,
    label: spec.label,
    model,
    readOnly,
    prompt: capToolResult(spec.prompt, 500),
  });

  // Linked cancellation: the parent signal OR a per-role wall-clock timeout aborts the child.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  ctx.signal.addEventListener("abort", onAbort);
  if (ctx.signal.aborted) ac.abort();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS[role]);

  // Bind the child's artifact ports to its OWN session's blob store, so read_artifact resolves and a
  // subagent's truncated outputs aren't lost. Absent factory → the ports stay undefined (offload is a no-op).
  const store = deps.artifactStore?.(childSessionId);
  const childOpts: RunOptions = {
    sessionId: childSessionId,
    mode: capMode(deps.parentMode, role),
    requestedModel: model,
    maxTurns: MAX_TURNS[role],
    cwd: ctx.cwd,
    workspaceRoot: ctx.workspaceRoot,
    signal: ac.signal,
    emit: childEmit,
    approve: deps.approve,
    workspace: deps.workspace,
    ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
    ...(deps.effort ? { effort: deps.effort } : {}),
    ...(deps.goal ? { goal: deps.goal } : {}),
    ...(role === "builder" && deps.verify ? { verify: deps.verify } : {}),
    ...(store ? { artifact: store.save, readArtifact: store.read } : {}),
    // Route by role when the model is on `auto` — including an explicit `spec.model === "auto"` that a Claude
    // preset produced (opus/sonnet/haiku map to "auto"); only a CONCRETE model id suppresses routing.
    ...(spec.model && spec.model !== "auto" ? {} : { routedRole: ROUTED_ROLE[role] }),
  };

  return new Agent(deps.client, deps.buildChildRegistry(role, spec.allowedTools))
    .run(spec.prompt, childOpts)
    .catch((e: unknown) => ({
      stopReason: "error" as const,
      turns: 0,
      finalText: `subagent error: ${(e as Error).message}`,
    }))
    .then((result) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      const summary = capToolResult(result.finalText || "(no output)", SUMMARY_CAP);
      ctx.emit({
        ...base,
        kind: "subagent.finished",
        childSessionId,
        stopReason: result.stopReason,
        turns: result.turns,
        toolCount,
        summary,
        durationMs: Math.max(0, now() - started),
      });
      return {
        label: spec.label,
        role,
        stopReason: result.stopReason,
        turns: result.turns,
        summary,
        ...(filesMutated.length > 0 ? { files: filesMutated } : {}),
      };
    });
}
