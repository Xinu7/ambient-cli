import { z } from "zod";
import { AttachmentRefSchema } from "./attachment.js";
import { AmbErrorKindSchema } from "./errors.js";
import { LaneSchema } from "./model-profile.js";
import { GrantScopeSchema, PermissionEffectSchema } from "./permission.js";

/**
 * Event protocol v1 (append-only, versioned). This is the durable source of truth; the UI and the
 * SQLite index are projections. Designed so a crashed session can reconstruct the exact model-facing
 * transcript and decide safely whether a side effect ran.
 *
 * Scoping is enforced by the schema: session-scoped events carry no turn; turn-scoped carry `turnId`;
 * attempt-scoped (a single inference attempt) carry `turnId` + `attemptId`. Events are STRICT — an
 * unknown/misspelled field fails validation rather than being silently dropped.
 *
 * Note: `reasoning.delta` is a TRANSIENT UI event and is NOT written to the durable log (it would
 * bloat the log and conflicts with the "no hidden-reasoning UI" guardrail); the session writer filters it.
 */

export const StopReasonSchema = z.enum([
  "complete",
  "max_turns",
  "max_budget",
  "cancelled",
  "blocked",
  "verify_failed",
  "looping", // the model repeated the SAME tool calls with no progress — stopped early to save the budget
  "error",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

const isoTs = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "ts must be an ISO datetime",
});
const idStr = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_`), { message: `id must start with ${prefix}_` });

const sessionBase = {
  schemaVersion: z.literal(1),
  eventId: idStr("evt"),
  sessionId: idStr("ses"),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ts: isoTs,
  prevChecksum: z.string().optional(),
  checksum: z.string().optional(),
} as const;
const turnBase = { ...sessionBase, turnId: idStr("trn") } as const;
const attemptBase = { ...turnBase, attemptId: idStr("att") } as const;

const sev = <K extends string, P extends z.ZodRawShape>(kind: K, p: P) =>
  z.strictObject({ ...sessionBase, kind: z.literal(kind), ...p });
const tev = <K extends string, P extends z.ZodRawShape>(kind: K, p: P) =>
  z.strictObject({ ...turnBase, kind: z.literal(kind), ...p });
const aev = <K extends string, P extends z.ZodRawShape>(kind: K, p: P) =>
  z.strictObject({ ...attemptBase, kind: z.literal(kind), ...p });

export const FileOperationSchema = z.enum(["create", "modify", "delete"]);

// RESERVED durable-log kinds (schema defined, producer intentionally deferred to a later phase, NOT dead
// UI wiring): `session.resumed` / `session.branched` (session-lifecycle records for resume/fork),
// `tool.output` (large-artifact offload via artifactRef), `file.conflict` (edit preimage-mismatch record —
// today surfaced to the model as a tool error). They are safe to persist; nothing renders them yet.
export const EventSchema = z.discriminatedUnion("kind", [
  // ── session-scoped ───────────────────────────────────────────────────────
  sev("session.started", {
    cwd: z.string(),
    workspaceRoot: z.string(),
    model: z.string().optional(),
  }),
  sev("session.resumed", { fromEventId: z.string().optional() }),
  sev("session.branched", { fromSessionId: z.string(), atSeq: z.number().int().nonnegative() }),
  sev("session.paused", { reason: z.string() }),
  // A user-set session-long north-star objective. Durable so `amb resume` can restore it. An empty string is
  // a CLEAR (the /goal clear command). The latest goal.set in the log wins.
  sev("goal.set", { text: z.string() }),
  sev("catalog.snapshot", { hash: z.string(), modelCount: z.number().int().nonnegative() }),
  sev("error", {
    errorKind: AmbErrorKindSchema,
    message: z.string(),
    model: z.string().optional(),
    // Whether the runtime will retry / fail over after this error. `false` = TERMINAL (the run ends now), so a
    // UI must NOT render it as "retrying / failing over…". Undefined = unspecified (fall back to kind).
    retryable: z.boolean().optional(),
  }),

  // ── turn-scoped ──────────────────────────────────────────────────────────
  tev("turn.started", {
    input: z.string(),
    // References only (mime/bytes/sha256/source) — NEVER the base64 bytes, which would bloat the durable log.
    attachments: z.array(AttachmentRefSchema).optional(),
  }),
  tev("turn.finished", { stopReason: StopReasonSchema }),
  // How an attached image was handled: seen NATIVELY by a vision model, DESCRIBED via a relay vision model,
  // or degraded (no vision model / cold / failed). Drives a single calm UI line; never carries image bytes.
  tev("vision.relay", {
    targetModel: z.string(),
    imageCount: z.number().int().nonnegative(),
    outcome: z.enum(["native", "described", "no-model", "cold", "failed"]),
    visionModel: z.string().optional(),
  }),
  tev("model.resolved", {
    requestedModel: z.string(),
    targetModel: z.string(),
    lane: LaneSchema,
    rule: z.string(),
    reason: z.string().optional(),
  }),
  tev("handoff", {
    from: z.string(),
    to: z.string(),
    role: z.string(),
    reason: z.string().optional(),
    lane: LaneSchema.optional(),
  }),
  tev("context.preflight", {
    model: z.string(),
    contextWindow: z.number().int().positive().optional(),
    promptEstimate: z.number().int().nonnegative(),
    reserve: z.number().int().nonnegative(),
    requestedOutput: z.number().int().nonnegative(),
    sentOutput: z.number().int().nonnegative(),
    remainingShared: z.number().int(),
  }),
  tev("context.overflow", {
    model: z.string(),
    promptTokens: z.number().int().optional(),
    maxTokens: z.number().int().optional(),
  }),
  tev("context.compacted", {
    keptTokens: z.number().int().nonnegative(),
    summarizedPhases: z.number().int().nonnegative(),
  }),
  // A completion gate ran the project's verification (tests/build). ok:false with a summary re-asks the model.
  tev("verify.gate", {
    ok: z.boolean(),
    attempt: z.number().int().nonnegative(),
    summary: z.string().optional(),
  }),
  tev("operation.cancelled", { scope: z.enum(["tool", "stream", "turn"]) }),

  // ── attempt-scoped (one inference attempt) ───────────────────────────────
  aev("inference.request", {
    targetModel: z.string(),
    sentOutput: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative().optional(),
    escalation: z.number().int().nonnegative(),
  }),
  aev("inference.response", {
    reportedModel: z.string().optional(),
    responseId: z.string().optional(),
    finishReason: z.string().optional(),
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    empty: z.boolean(),
    truncated: z.boolean(),
  }),
  aev("assistant.delta", { text: z.string() }),
  aev("assistant.final", { text: z.string() }),
  aev("reasoning.delta", { text: z.string() }),
  aev("tool.proposed", {
    toolCallId: idStr("tc"),
    wireId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
    rawArgs: z.string(),
    argsHash: z.string(),
  }),
  aev("tool.validated", { toolCallId: idStr("tc"), ok: z.boolean(), error: z.string().optional() }),
  aev("tool.permission", {
    toolCallId: idStr("tc"),
    effect: PermissionEffectSchema,
    scope: GrantScopeSchema.optional(),
    reason: z.string(),
  }),
  aev("tool.started", { toolCallId: idStr("tc"), toolName: z.string() }),
  aev("tool.output", {
    toolCallId: idStr("tc"),
    artifactRef: z.string(),
    bytes: z.number().int().nonnegative(),
    mime: z.string().optional(),
  }),
  aev("tool.result", {
    toolCallId: idStr("tc"),
    ok: z.boolean(),
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative(),
    error: z.string().optional(),
    preview: z.string().optional(),
    /** Unified diff produced by a write/edit tool (the tool's OUTPUT), for the UI to render. */
    diff: z.string().optional(),
    artifactRef: z.string().optional(),
    idempotencyKey: z.string().optional(),
  }),
  aev("file.mutation", {
    path: z.string(),
    operation: FileOperationSchema,
    preimageHash: z.string().optional(),
    postimageHash: z.string().optional(),
  }),
  aev("file.conflict", {
    path: z.string(),
    expectedPreimageHash: z.string(),
    actualHash: z.string(),
  }),

  // ── subagents (nested delegation; each child runs in its OWN session — these events correlate its live
  //    activity onto the PARENT stream, keyed by the parent tool-call + the child session) ────────────────
  aev("subagent.started", {
    toolCallId: idStr("tc"), // the parent `subagent` tool call
    childSessionId: idStr("ses"), // the child's own durable, resumable session
    role: z.enum(["scout", "oracle", "builder"]),
    label: z.string(),
    model: z.string(),
    readOnly: z.boolean(),
    prompt: z.string(),
  }),
  aev("subagent.tool", {
    toolCallId: idStr("tc"),
    childSessionId: idStr("ses"),
    childToolCallId: idStr("tc"),
    toolName: z.string(),
    status: z.enum(["running", "ok", "fail"]),
    preview: z.string().optional(),
  }),
  aev("subagent.delta", { toolCallId: idStr("tc"), text: z.string() }), // TRANSIENT (writer.ts)
  aev("subagent.finished", {
    toolCallId: idStr("tc"),
    childSessionId: idStr("ses"),
    stopReason: StopReasonSchema,
    turns: z.number().int().nonnegative(),
    toolCount: z.number().int().nonnegative(),
    summary: z.string(),
    exploredTokens: z.number().int().nonnegative().optional(),
    summaryTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative(),
  }),
]);
export type Event = z.infer<typeof EventSchema>;
export type EventKind = Event["kind"];

/** Distributive Omit — preserves each discriminated-union member's own fields (plain Omit collapses them). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * An event as AUTHORED by the runtime — without the fields the session writer stamps
 * (eventId/seq/ts/prevChecksum/checksum). The runtime emits these intents; the writer completes them.
 */
export type NewEvent = DistributiveOmit<
  Event,
  "eventId" | "seq" | "ts" | "prevChecksum" | "checksum"
>;
