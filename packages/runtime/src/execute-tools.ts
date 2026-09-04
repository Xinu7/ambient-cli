import { decide, refineBashEffects } from "@amb/permissions";
import {
  type Grant,
  type NewEvent,
  type PermissionInput,
  type ToolContext,
  type ToolDefinition,
  isReadOnly,
  newToolCallId,
} from "@amb/protocol";
import { type ToolRegistry, sha256 } from "@amb/tools-core";
import type { Approver, RunOptions, ToolCall } from "./ports.js";

export interface ToolOutcome {
  /** The branded event id (tc_…) used in the durable log. */
  toolCallId: string;
  /** The provider's wire id — MUST match the assistant message's tool_calls[].id when sending the result. */
  wireId: string;
  toolName: string;
  ok: boolean;
  result: unknown;
  error?: string;
  durationMs: number;
}

/** IDs that scope the attempt these tool calls belong to. */
export interface Scope {
  sessionId: string;
  turnId: string;
  attemptId: string;
}

/** Resolve the resource paths a tool touches (best-effort, for the workspace-boundary check). */
function resourcesOf(args: unknown): string[] {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const out: string[] = [];
    for (const key of ["path", "file"]) {
      if (typeof a[key] === "string") out.push(a[key] as string);
    }
    return out;
  }
  return [];
}

async function runOne(
  call: ToolCall,
  toolCallId: string,
  tool: ToolDefinition,
  opts: RunOptions,
  scope: Scope,
  grants: Grant[],
  approve: Approver,
  makeToolCtx: (toolCallId: string) => ToolContext,
  autoApproval: { streak: number; cap?: number },
): Promise<ToolOutcome> {
  const started = Date.now();
  const dur = () => Date.now() - started;
  const emit = (ev: NewEvent) => opts.emit(ev);
  const wireId = call.id;

  // 1. validate args
  const parsed = tool.inputSchema.safeParse(call.args);
  emit({
    schemaVersion: 1,
    kind: "tool.validated",
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    attemptId: scope.attemptId,
    toolCallId,
    ok: parsed.success,
    ...(parsed.success ? {} : { error: "invalid arguments" }),
  });
  if (!parsed.success) {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: `invalid arguments: ${parsed.error.message}`,
      durationMs: dur(),
    };
  }

  // 2. permission (DD-1) — honors existing session/project grants
  // A read-only bash command (git status / log / diff, ls, cat, grep …) is downgraded to a `read` effect so
  // it auto-allows and works in plan mode, instead of prompting like an arbitrary shell call. The classifier
  // is deliberately strict — any redirection / substitution / mutating form keeps the full process effects.
  const effectiveEffects = refineBashEffects(
    tool.manifest.name,
    parsed.data,
    tool.manifest.effects,
  );
  const readOnlyCall = effectiveEffects.length > 0 && effectiveEffects.every((e) => e === "read");
  const permInput: PermissionInput = {
    principal: "model",
    mode: opts.mode,
    toolName: tool.manifest.name,
    effects: effectiveEffects,
    normalizedArgs: parsed.data as Record<string, unknown>,
    resolvedResources: resourcesOf(parsed.data).map((r) =>
      r.startsWith("/") ? r : `${opts.workspaceRoot}/${r}`,
    ),
    workspaceRoot: opts.workspaceRoot,
    grants,
    autoApprovalStreak: autoApproval.streak,
    ...(autoApproval.cap !== undefined ? { autoApprovalCap: autoApproval.cap } : {}),
  };
  const decision = decide(permInput);
  let effect = decision.effect;
  let scopeGranted: "session" | undefined;
  if (effect === "ask") {
    const ans = await approve({
      toolName: tool.manifest.name,
      args: parsed.data,
      effects: effectiveEffects,
      decision,
    });
    effect = ans === "deny" ? "deny" : "allow";
    if (ans === "allow-session") {
      grants.push({ scope: "session", toolName: tool.manifest.name });
      scopeGranted = "session";
    }
  }
  // Autonomy-brake bookkeeping (accept-edits): a human interaction (any ask) resets the run; an unattended
  // auto-approved mutation advances the streak toward the periodic checkpoint. Reads never count.
  if (decision.effect === "ask") {
    autoApproval.streak = 0;
  } else if (decision.effect === "allow" && !readOnlyCall && !isReadOnly(tool.manifest)) {
    autoApproval.streak++;
  }
  emit({
    schemaVersion: 1,
    kind: "tool.permission",
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    attemptId: scope.attemptId,
    toolCallId,
    effect,
    ...(scopeGranted ? { scope: scopeGranted } : {}),
    reason: decision.reason,
  });
  if (effect === "deny") {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: `denied: ${decision.reason}`,
      durationMs: dur(),
    };
  }

  // 3. execute — honor a late Ctrl-C right before the side effect
  if (opts.signal.aborted) {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: "cancelled before execution",
      durationMs: dur(),
    };
  }
  emit({
    schemaVersion: 1,
    kind: "tool.started",
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    attemptId: scope.attemptId,
    toolCallId,
    toolName: tool.manifest.name,
  });
  // Re-check AFTER recording intent: if persisting `tool.started` failed, the sink aborts the run, and
  // we must not execute a mutation whose write-ahead intent didn't land.
  if (opts.signal.aborted) {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: "cancelled before execution",
      durationMs: dur(),
    };
  }
  try {
    const result = await runBounded(tool, parsed.data, makeToolCtx(toolCallId), opts.signal);
    // Validate the tool's OWN output for shape. A mismatch is OUR bug, not the model's — the side
    // effect ALREADY happened, so we must NOT report ok:false (that would invite a duplicate mutation,
    // new-audit #4). We keep ok:true, surface the raw result, and note the mismatch.
    const outParsed = tool.outputSchema.safeParse(result);
    if (!outParsed.success) {
      return {
        toolCallId,
        wireId,
        toolName: call.name,
        ok: true,
        result,
        error: `note: tool result did not match its output schema (${outParsed.error.message})`,
        durationMs: dur(),
      };
    }
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: true,
      result: outParsed.data,
      durationMs: dur(),
    };
  } catch (err) {
    return {
      toolCallId,
      wireId,
      toolName: call.name,
      ok: false,
      result: null,
      error: (err as Error).message,
      durationMs: dur(),
    };
  }
}

/**
 * Run a tool's execute() bounded by its declared `timeoutPolicy.maximumMs`. The race guarantees the loop
 * proceeds at the deadline even if a badly-behaved tool ignores the abort signal (its promise then leaks,
 * but the run is not held hostage); a well-behaved tool cancels via the linked signal. No policy ⇒ no bound.
 */
async function runBounded(
  tool: ToolDefinition,
  args: unknown,
  ctx: ToolContext,
  outerSignal: AbortSignal,
): Promise<unknown> {
  const maxMs = tool.manifest.timeoutPolicy?.maximumMs;
  if (!(typeof maxMs === "number" && Number.isFinite(maxMs) && maxMs > 0)) {
    return tool.execute(args, ctx);
  }
  const linked = new AbortController();
  const onOuterAbort = () => linked.abort();
  if (outerSignal.aborted) linked.abort();
  else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        linked.abort();
        reject(new Error(`tool '${tool.manifest.name}' exceeded its ${maxMs}ms limit`));
      }, maxMs);
      Promise.resolve(tool.execute(args, { ...ctx, signal: linked.signal })).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    outerSignal.removeEventListener("abort", onOuterAbort);
  }
}

/** A tool call may run concurrently with its neighbours only if it is read-only AND parallelSafe. */
function canRunConcurrently(tool: ToolDefinition): boolean {
  return isReadOnly(tool.manifest) && tool.manifest.parallelSafe;
}

/**
 * Execute a batch of tool calls IN ORDER, running consecutive read-only+parallelSafe calls concurrently
 * and treating any mutating (or non-parallel-safe) call as a barrier. This preserves the model's intended
 * ordering — e.g. write(x) then read(x) sees the new contents — while still parallelising safe reads.
 * Unknown tools and validation/permission failures become error outcomes (never abort the loop).
 */
export async function executeTools(
  calls: ToolCall[],
  registry: ToolRegistry,
  opts: RunOptions,
  scope: Scope,
  grants: Grant[] = [],
  autoApproval: { streak: number; cap?: number } = { streak: 0 },
): Promise<ToolOutcome[]> {
  const makeToolCtx = (toolCallId: string): ToolContext => ({
    cwd: opts.cwd,
    workspaceRoot: opts.workspaceRoot,
    signal: opts.signal,
    secret: async () => "",
    emit: opts.emit,
    ...(opts.checkpoint ? { checkpoint: opts.checkpoint } : {}),
    ...(opts.readArtifact ? { readArtifact: opts.readArtifact } : {}),
    // The interactive-question port (backs `ask_user`) — present only at the top level, so a subagent child
    // never blocks on a human it can't reach (its ctx omits `ask`, and the tool returns a proceed note).
    ...(opts.ask ? { ask: opts.ask } : {}),
    // Correlation for tools that author nested events (e.g. the subagent tool → subagent.* on the parent).
    scope: { sessionId: scope.sessionId, turnId: scope.turnId, attemptId: scope.attemptId },
    toolCallId,
  });

  const ids = calls.map((c) => (c.id.startsWith("tc_") ? c.id : newToolCallId()));
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i] as ToolCall;
    opts.emit({
      schemaVersion: 1,
      kind: "tool.proposed",
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      attemptId: scope.attemptId,
      toolCallId: ids[i] as string,
      wireId: call.id,
      toolName: call.name,
      args: normalizeArgs(call.args),
      rawArgs: call.rawArgs,
      argsHash: sha256(call.rawArgs),
    });
  }

  // Emit a tool's result the MOMENT it settles (never batched at end) so a finished tool's row never
  // shows 'running', and a crash after a mutation still has both tool.started AND tool.result durable.
  // Carries the unified diff (from the tool's OUTPUT — write/edit return it) so the UI can render it, and
  // emits file.mutation for any tool that reports a {path, operation} (the durable mutation record).
  const emitResult = (o: ToolOutcome): void => {
    const preview = previewOf(o);
    const r =
      o.ok && o.result && typeof o.result === "object"
        ? (o.result as Record<string, unknown>)
        : undefined;
    const diff = typeof r?.diff === "string" && r.diff.length > 0 ? capDiff(r.diff) : undefined;
    opts.emit({
      schemaVersion: 1,
      kind: "tool.result",
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      attemptId: scope.attemptId,
      toolCallId: o.toolCallId,
      ok: o.ok,
      durationMs: o.durationMs,
      ...(o.error ? { error: o.error } : {}),
      ...(preview ? { preview } : {}),
      ...(diff ? { diff } : {}),
    });
    // Emit a durable file.mutation for each changed file. A {files:[...]} result (apply_patch) carries the
    // per-file records; otherwise a top-level {path, operation} (write/edit) is the single mutation. Prefer
    // files[] when present so a hybrid shape can't double-emit the same file (audit).
    if (r && Array.isArray(r.files)) {
      for (const f of r.files)
        if (f && typeof f === "object") emitMutation(f as Record<string, unknown>);
    } else if (r) {
      emitMutation(r);
    }
  };

  const emitMutation = (r: Record<string, unknown>): void => {
    if (
      typeof r.path !== "string" ||
      (r.operation !== "create" && r.operation !== "modify" && r.operation !== "delete")
    ) {
      return;
    }
    opts.emit({
      schemaVersion: 1,
      kind: "file.mutation",
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      attemptId: scope.attemptId,
      path: r.path,
      operation: r.operation,
      ...(typeof r.preimageHash === "string" ? { preimageHash: r.preimageHash } : {}),
      ...(typeof r.postimageHash === "string" ? { postimageHash: r.postimageHash } : {}),
    });
  };

  const outcomes = new Array<ToolOutcome | undefined>(calls.length);
  const run = (i: number): Promise<ToolOutcome> => {
    const call = calls[i] as ToolCall;
    const toolCallId = ids[i] as string;
    const tool = registry.get(call.name);
    if (!tool) {
      return Promise.resolve({
        toolCallId,
        wireId: call.id,
        toolName: call.name,
        ok: false,
        result: null,
        error: `unknown tool: ${call.name}`,
        durationMs: 0,
      });
    }
    return runOne(
      call,
      toolCallId,
      tool,
      opts,
      scope,
      grants,
      opts.approve,
      makeToolCtx,
      autoApproval,
    );
  };

  let i = 0;
  while (i < calls.length) {
    // Gather a run of consecutive concurrency-safe calls.
    const batch: number[] = [];
    while (i < calls.length) {
      const tool = registry.get((calls[i] as ToolCall).name);
      const safe = tool ? canRunConcurrently(tool) : false;
      if (safe) {
        batch.push(i);
        i++;
      } else {
        break;
      }
    }
    if (batch.length > 0) {
      // Emit each result the MOMENT its own call settles — a fast read in the batch must not keep its row
      // 'running' until a slow neighbour finishes. `outcomes[]` stays index-keyed for model-facing order.
      await Promise.all(
        batch.map(async (idx) => {
          const o = await run(idx);
          outcomes[idx] = o;
          emitResult(o);
        }),
      );
    }
    if (i < calls.length) {
      const o = await run(i);
      outcomes[i] = o;
      emitResult(o);
      i++;
    }
  }

  return outcomes.filter((o): o is ToolOutcome => o !== undefined);
}

/** Never store `undefined` in an event (breaks the checksum canonicalizer vs JSON.stringify). */
function normalizeArgs(args: unknown): unknown {
  return args === undefined ? null : args;
}

const MAX_DIFF_LINES = 500; // hard ceiling on the STORED diff, INCLUDING any truncation marker line
const MAX_DIFF_CHARS = 64_000;
/**
 * Bound the emitted diff so a pathological write (a multi-MB file) can't put a huge string in the durable
 * log or make every Ink rerender re-split it. Reserves ONE line for a single honest marker if EITHER the
 * char-cap or the line-cap fired, so the result is always ≤ MAX_DIFF_LINES and never silently under-marks.
 */
function capDiff(diff: string): string {
  const charTruncated = diff.length > MAX_DIFF_CHARS;
  const base = charTruncated ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  const lines = base.split("\n");
  const lineTruncated = lines.length > MAX_DIFF_LINES; // EXCEEDS the ceiling (exactly 500 is fine as-is)
  if (!charTruncated && !lineTruncated) return diff;
  // A marker line WILL be added, so keep at most MAX_DIFF_LINES-1 real lines → total is always ≤ the ceiling
  // (slice keeps fewer when the base is short). Generic marker: the exact remaining count is unreliable once
  // chars were sliced first.
  const kept = lines.slice(0, MAX_DIFF_LINES - 1);
  return `${kept.join("\n")}\n… (diff truncated)`;
}

function previewOf(o: ToolOutcome): string | undefined {
  if (o.error) return o.error.slice(0, 400);
  let s: string;
  try {
    s = typeof o.result === "string" ? o.result : JSON.stringify(o.result);
  } catch {
    s = "[unserializable result]";
  }
  return s ? s.slice(0, 400) : undefined;
}
