import { z } from "zod";
import type { NewEvent } from "./event.js";

/** The classes of side effect a tool can have. Drives permissions + safe-parallelism. */
export const EffectSchema = z.enum(["read", "write", "process", "network", "secret"]);
export type Effect = z.infer<typeof EffectSchema>;

export const IdempotencySchema = z.enum(["pure", "idempotent", "non-idempotent"]);
export type Idempotency = z.infer<typeof IdempotencySchema>;

export const ResumabilitySchema = z.enum(["replay", "inspect", "never-replay"]);
export type Resumability = z.infer<typeof ResumabilitySchema>;

/** Serializable tool metadata — safe to log, send to a model, or persist. */
export const ToolManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().default("1"),
  description: z.string(),
  effects: z.array(EffectSchema).default([]),
  idempotency: IdempotencySchema.default("non-idempotent"),
  parallelSafe: z.boolean().default(false),
  resumability: ResumabilitySchema.default("inspect"),
  timeoutPolicy: z.object({
    idleMs: z.number().int().positive(),
    maximumMs: z.number().int().positive().optional(),
  }),
});
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/** A tool is read-only iff it has effects and every one of them is "read". */
export function isReadOnly(m: ToolManifest): boolean {
  return m.effects.length > 0 && m.effects.every((e) => e === "read");
}

/** One selectable choice in an `ask_user` question — a short label plus an optional one-line description. */
export interface AskOption {
  label: string;
  description?: string;
}
/** A structured question the agent pushes to the human (backs the `ask_user` tool). */
export interface AskRequest {
  question: string;
  /** Selectable choices; when present the human picks one (or several, if `multiSelect`). */
  options?: AskOption[];
  /** Allow free-text context in addition to / instead of a choice (default true). */
  allowText?: boolean;
  /** Allow selecting more than one option. */
  multiSelect?: boolean;
}
/** The human's answer to an `ask_user` question. */
export interface AskResponse {
  /** Labels the human selected (empty if they only typed text or cancelled). */
  selected: string[];
  /** Free-text the human added, if any. */
  text?: string;
  /** True when the human dismissed the question without answering (Esc) — the agent should proceed. */
  cancelled?: boolean;
}

export interface ToolContext {
  cwd: string;
  workspaceRoot: string;
  signal: AbortSignal;
  /** Resolve a secret by opaque reference — the value never enters model context. */
  secret(ref: string): Promise<string>;
  emit(event: NewEvent): void;
  /** Save a file's pre-image content to the session blob store before overwriting it (enables `amb rewind`).
   *  Optional — absent ⇒ no checkpointing (the mutation still records its preimageHash in the event log). */
  checkpoint?(content: string): void;
  /** The attempt this tool call belongs to — lets a tool author correlated events (e.g. a subagent tool
   *  emitting subagent.* onto the parent stream). Optional so builtins + the inert test ctx ignore it. */
  scope?: { sessionId: string; turnId: string; attemptId: string };
  /** The parent tool-call id (tc_…) this ctx is executing, for correlating nested events back to the call. */
  toolCallId?: string;
  /** Read a previously-offloaded artifact (a large tool output) by its handle, or undefined if unavailable.
   *  Backs the `read_artifact` tool — large outputs are stored whole and retrieved on demand instead of being
   *  lossily truncated (Karpathy: keep-and-offload beats summarize). Optional — absent ⇒ no artifact store. */
  readArtifact?(handle: string): string | undefined;
  /** Ask the human a structured question (options + optional free-text) and await their answer. Backs the
   *  `ask_user` tool. Optional — absent ⇒ no interactive human (headless / subagent child), so the tool
   *  returns a proceed-with-best-judgment note rather than blocking forever. */
  ask?(req: AskRequest): Promise<AskResponse>;
}

/** A tool = serializable manifest + Zod I/O schemas + an execute fn. Not fully serializable (has execute). */
export interface ToolDefinition<I = unknown, O = unknown> {
  manifest: ToolManifest;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  execute(input: I, ctx: ToolContext): Promise<O>;
}
