import type { SkillMeta } from "@amb/context";
import type {
  AskRequest,
  AskResponse,
  CatalogModel,
  Grant,
  Lane,
  Mode,
  NewEvent,
  PermissionDecision,
} from "@amb/protocol";
import type { RoutedRole } from "@amb/reliability";

/**
 * The runtime's view of capability evidence (implemented by the CLI over @amb/capabilities). Lets the
 * agent pick the honest lane per model and learn from real runs. Optional — absent ⇒ Phase-1 behavior
 * (assume `direct`, no learning).
 */
export interface CapabilityPort {
  laneFor(model: CatalogModel): Lane;
  /** Record that a model did (or did not) emit well-formed native tool calls in a real run. */
  learn(modelId: string, toolCallingWorked: boolean): void;
  /** The learned REAL context ceiling (tokens) for a model, if we've seen it overflow (catalog-adaptive). */
  learnedCeiling?(modelId: string): number | undefined;
  /** Learn a model's real ceiling from a provider overflow — only ever LOWERS the optimistic catalog window. */
  learnCeiling?(modelId: string, observedMax: number): void;
  /** Record one verify-gate outcome (its earned-autonomy signal): did this model pass on the first try? */
  recordVerify?(modelId: string, firstTryPass: boolean): void;
  /** The model's persisted verify track record (runs + first-try passes), for earned-autonomy scaling. */
  verifyStats?(modelId: string): { runs: number; firstTryPasses: number } | undefined;
  /** The learned bytes-per-token for a model (calibrated from real provider usage), or undefined for the
   *  default estimate. Lets a fleet of models that tokenize code very differently (Qwen/o200k/Llama3) be
   * budgeted accurately instead of a single 3.5 constant. */
  bytesPerToken?(modelId: string): number | undefined;
  /** Calibrate a model's bytes-per-token from an actual (requestBytes / reported promptTokens) observation. */
  learnBytesPerToken?(modelId: string, bytesPerToken: number): void;
}

/** One tool call the model asked for. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments (may be `undefined` if the JSON was malformed — the runtime handles that). */
  args: unknown;
  /** Raw argument string as streamed (for error reporting on parse failure). */
  rawArgs: string;
}

/** The settled result of one model turn. */
export interface TurnCompletion {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  reportedModel?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

/** A single chat message in the transcript we send to the model. */
export interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** Groups a tool call with its result so compaction never splits them. */
  toolGroupId?: string;
}

/**
 * The workspace's filesystem + environment context, injected so the runtime state machine stays free of
 * direct `fs`/`process`/clock effects (deterministic + replayable; effects live at the CLI edge). Optional —
 * absent ⇒ inert defaults (no instructions, no memory, no date/platform), which is fine for isolated tests.
 */
export interface WorkspaceContextPort {
  /** Concatenated project instruction files (AGENTS.md/CLAUDE.md/…) for `cwd`, or "" if none. */
  instructions(cwd: string): string;
  /** Durable project memory (.ambient/MEMORY.md) for the workspace, or undefined if none. */
  readMemory(workspaceRoot: string): string | undefined;
  /** Persist the compounding project memory (best-effort; never load-bearing). */
  writeMemory(workspaceRoot: string, summary: string): void;
  /** Today's date as YYYY-MM-DD (injectable clock). */
  date(): string;
  /** The host platform string (e.g. process.platform). */
  platform(): string;
  /** Discover Agent Skills (SKILL.md catalog) under the workspace — only name+description; body loads on demand. */
  skills(workspaceRoot: string): SkillMeta[];
  /** A compact snapshot of the repo's git state (branch, changed files, recent commits) at run start, or
   *  undefined when `cwd` isn't a git work tree. Injected into the prompt so the agent isn't blind to git
   *  without spending tool calls. Optional — a port that omits it simply contributes no git block. */
  git?(cwd: string): string | undefined;
  /** A ranked, token-budgeted repository map (signatures only) for `tokenBudget` tokens, or "" if none/omitted.
   *  Optional — a port that doesn't provide it simply contributes no map (inert default). */
  repoMap?(workspaceRoot: string, tokenBudget: number): string;
}

/**
 * The user's reasoning-effort choice. `auto` is resolved by the agent from the run mode + model capability;
 * `off` sends nothing; low/medium/high are sent as `reasoning_effort` only for reasoning-capable models.
 */
export type EffortSetting = "off" | "auto" | "low" | "medium" | "high";

export interface ChatParams {
  model: string;
  messages: Msg[];
  tools: unknown[];
  maxTokens: number;
  signal: AbortSignal;
  /** Resolved reasoning effort for THIS request (low/medium/high), or undefined to send none. */
  reasoningEffort?: "low" | "medium" | "high";
  /** True when the outbound messages carry image content-parts — lets the adapter mark the request so an
   *  image-related 400 isn't misread as a context overflow. Absent ⇒ the adapter derives it from `messages`. */
  hasImage?: boolean;
  onContent?: (t: string) => void;
  onReasoning?: (t: string) => void;
}

/**
 * The seam between the runtime and Ambient. The real adapter wraps @amb/ambient-api; tests inject a
 * scripted mock (a replay-harness pattern) so the whole agent loop runs offline + deterministic.
 */
export interface ChatClient {
  /** Fetch the live catalog. Accepts an abort signal so a hung fetch can be cancelled. */
  fetchCatalog(signal?: AbortSignal): Promise<CatalogModel[]>;
  chat(params: ChatParams): Promise<TurnCompletion>;
}

/** The outcome of running the project's verification (tests / build / typecheck). */
export interface VerifyOutcome {
  ok: boolean;
  /** On failure, the (already-bounded) diagnostic output fed back to the model. Empty when ok. */
  summary: string;
}

/**
 * Runs the project's verification on demand. Returns null when NO verification is configured (honest — the
 * gate is skipped, never faked). The CLI wraps a user-provided `.ambient/verify` script; tests inject a stub.
 * Receives the run's abort signal so a Ctrl-C mid-verification can kill the script + its process group.
 */
export type VerifyPort = (signal?: AbortSignal) => Promise<VerifyOutcome | null>;

/** How the runtime asks the human to approve a gated tool call (interactive prompt). */
export type Approver = (req: {
  toolName: string;
  args: unknown;
  effects: import("@amb/protocol").Effect[];
  decision: PermissionDecision;
}) => Promise<"allow-once" | "allow-session" | "deny">;

/** How the runtime pushes a structured question to the human and awaits their answer (backs `ask_user`). */
export type AskPort = (req: AskRequest) => Promise<AskResponse>;

export interface RunOptions {
  /** Unique per-run session id (the CLI mints one; the writer chains from seq 0). */
  sessionId: string;
  mode: Mode;
  requestedModel: string;
  maxTurns: number;
  cwd: string;
  workspaceRoot: string;
  signal: AbortSignal;
  /** Emit an event intent (UI renders these; the writer stamps + persists durable ones). */
  emit: (ev: NewEvent) => void;
  approve: Approver;
  /** Optional interactive-question port (backs `ask_user`). Absent ⇒ no human is reachable (headless run /
   *  subagent child), and the tool returns a proceed-on-best-judgment note instead of blocking. */
  ask?: AskPort;
  /** Session-scoped permission grants (mutated in place as the user picks "allow for this session"). Pass a
   *  STABLE array across turns so an allow-session grant actually persists — the TUI holds one per session.
   *  Absent ⇒ a fresh per-run array (grants last one run only). */
  grants?: Grant[];
  /** Images the user attached to THIS run's initiating message. A vision-capable served model sees them
   *  directly; a blind model gets a text description via the vision relay. Absent ⇒ a plain text run. */
  attachments?: readonly import("@amb/protocol").ImageAttachment[];
  /** Optional capability evidence (honest lane + learning). Absent ⇒ assume direct, no learning. */
  capabilities?: CapabilityPort;
  /** Reasoning-effort choice for this run (resolved per-request by the agent). Absent ⇒ "auto". */
  effort?: EffortSetting;
  /** Workspace fs/env context (instructions, memory, clock, platform) — REQUIRED so a run can never silently
   *  lose project instructions/memory. Tests pass an explicit inert or real-fs implementation. */
  workspace: WorkspaceContextPort;
  /** Optional project verification (Karpathy gen→verify). When present and the model finishes after
   *  mutating files, the runtime runs it and re-asks the model on failure. Absent ⇒ no gate. */
  verify?: VerifyPort;
  /** Optional pre-image checkpointer: a mutating tool calls it with a file's prior content before overwriting
   *  so `amb rewind` can restore it. Absent ⇒ no checkpointing. */
  checkpoint?: (content: string) => void;
  /** Optional artifact store: save a large tool output whole, returning a handle. When a tool result
   *  would be truncated to fit the window, the FULL output is offloaded here so the model can retrieve it via
   *  `read_artifact` instead of losing it. Absent ⇒ results are just truncated (no offload). */
  artifact?: (content: string) => string | undefined;
  /** Read a previously-offloaded artifact by handle (backs the read_artifact tool). Absent ⇒ no retrieval. */
  readArtifact?: (handle: string) => string | undefined;
  /**
   * Optional prior-session transcript for warm-continue resume. Injected into the SYSTEM prompt (NOT as
   * chat messages) so it never displaces the compaction goal anchor (system + the new instruction).
   */
  resumeContext?: string;
  /**
   * The user's session-long NORTH-STAR objective (set via `/goal`). Baked into the system-prompt anchor at the
   * top of the dynamic block so it stays resident every turn and survives compaction (it never enters the
   * summarizable transcript). Kept tiny; the agent never rewrites it — only the user changes it.
   */
  goal?: string;
  /**
   * Optional PHASE role for fleet routing (#27). When set AND `requestedModel` is `auto`, the run resolves a
   * role-appropriate model from the live fleet (planner/reviewer → strongest reasoner, executor → best coder)
   * instead of the generic best pick. Used by subagent children (scout→planner, oracle→reviewer,
   * builder→executor); an explicit `--model`/preset model always wins (this is ignored unless model is auto).
   */
  routedRole?: RoutedRole;
}
