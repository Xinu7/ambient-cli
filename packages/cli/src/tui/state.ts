import type { Lane, Mode, NewEvent } from "@amb/protocol";
import { AUTO_MODEL } from "@amb/reliability";
import { type PlanTask, parsePlanTasks } from "@amb/sessions";

/**
 * Two ORTHOGONAL axes (user design), not one ladder:
 *  - `agentMode` — what it's doing: PLAN (read-only; explore + build a task list) vs BUILD (execute).  Tab toggles.
 *  - `permission` — how much it asks when building: ask / accept-edits / bypass.  Shift+Tab cycles.
 * So "plan with bypass on" is expressible: the permission persists across the plan↔build toggle.
 */
export type AgentMode = "plan" | "build";
export type Permission = "ask" | "accept-edits" | "bypass";

/**
 * Reasoning-effort choice, surfaced next to the model. `auto` is the intelligent default — the agent sends
 * HIGH effort while planning and MEDIUM while building, and sends nothing to models that don't advertise
 * `reasoning`. `off` disables it; low/medium/high pin a level. This union is structurally identical to the
 * runtime's `EffortSetting`, so it passes straight into RunOptions.effort.
 */
export type Effort = "auto" | "off" | "low" | "medium" | "high";
/** All effort choices, in the order the /effort picker presents them (auto first — the recommended default). */
export const EFFORTS: readonly Effort[] = ["auto", "off", "low", "medium", "high"] as const;

/** The single runtime Mode the permission engine understands, derived from the two axes. */
export function toRuntimeMode(agentMode: AgentMode, permission: Permission): Mode {
  return agentMode === "plan" ? "plan" : permission;
}
/** Shift+Tab cycles the permission: ask → accept-edits → bypass → ask. */
export function nextPermission(p: Permission): Permission {
  const order: Permission[] = ["ask", "accept-edits", "bypass"];
  return order[(order.indexOf(p) + 1) % order.length] ?? "ask";
}
/** Tab toggles plan ↔ build. */
export function toggleAgentMode(m: AgentMode): AgentMode {
  return m === "plan" ? "build" : "plan";
}

/**
 * TUI view-state — a pure reduction of the runtime's event stream (state.ts holds NO React). The App
 * dispatches every emitted NewEvent through `reduce`; components render the result. Immutable updates
 * only (new objects, never mutation) so React re-renders correctly and history stays trustworthy.
 *
 * `reduce` is genuinely pure: item ids come from an immutable `seq` carried in the state (never a
 * module-global), so replay/tests/React-dev double-invocation are deterministic.
 */

export type TranscriptItem =
  // `optimistic`: echoed the instant the user submits (before the catalog fetch → turn.started), so their
  // message + a "Thinking" line appear with ZERO perceived lag; turn.started confirms it in place (no dup).
  | { kind: "user"; id: string; text: string; optimistic?: boolean }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; spin: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      preview: string;
      diff?: string;
      /** A bounded preview of the tool's OUTPUT (read contents / grep hits / bash stdout) — the single
       *  biggest clarity gap vs Claude Code was showing only "✓ 34ms" with no result. */
      resultPreview?: string;
      exitCode?: number;
      status: "running" | "ok" | "fail";
      durationMs?: number;
      error?: string;
    }
  | { kind: "handoff"; id: string; from: string; to: string; role: string; reason?: string }
  | { kind: "receipt"; id: string; text: string }
  | { kind: "notice"; id: string; level: "info" | "warn" | "error"; text: string }
  | {
      kind: "subagent";
      /** id === the parent `subagent` tool-call id (globally unique). */
      id: string;
      children: SubagentChild[];
      status: "running" | "ok" | "fail";
      /** Collapsed to summaries once all children settle. */
      collapsed: boolean;
      /** Monotonic spin counter driving the child globes. */
      spin: number;
    };

/** One nested subagent's live state within a `subagent` transcript item. */
export interface SubagentChild {
  childSessionId: string;
  label: string;
  role: "scout" | "oracle" | "builder";
  model: string;
  status: "running" | "ok" | "fail";
  activity?: Activity;
  /** A bounded window (~6) of the child's recent tool calls. */
  tools: { id: string; name: string; status: "running" | "ok" | "fail"; preview?: string }[];
  turns?: number;
  durationMs?: number;
  exploredTokens?: number;
  summaryTokens?: number;
  summary?: string;
}

const MAX_CHILD_TOOL_ROWS = 6;

/**
 * The FLIGHTLINE's state — deliberately minimal (user: "all I care about is what model I'm running
 * and how much context I have"). Only fields the StatusLine actually renders live here; run telemetry
 * (tokens/tools/±lines/files) was removed rather than accumulated-but-never-shown. The durable event log
 * (not this view-state) remains the source of truth for those records.
 */
/** What the agent is doing RIGHT NOW — surfaced as the single live activity line while a run is active. */
export interface Activity {
  verb: string;
  detail?: string;
}

export interface Status {
  agentMode: AgentMode;
  permission: Permission;
  /** Reasoning effort shown next to the model; `auto` scales with mode + gates on model capability. */
  effort: Effort;
  requestedModel: string;
  targetModel?: string;
  reportedModel?: string;
  lane?: Lane;
  contextWindow?: number;
  promptEstimate?: number;
  running: boolean;
  stopReason?: string;
  /** The current action (Thinking / Reading / Editing / Running …) for the live activity line. */
  activity?: Activity;
}

/** One step in the agent's visible task list (maintained via the `plan` tool). */
export type { PlanTask }; // the shared type lives in @amb/sessions (one parser for live + resumed plans)

export interface ViewState {
  transcript: TranscriptItem[];
  status: Status;
  /** The agent's task list (from the `plan` tool) — empty until/unless the model uses it. */
  plan: PlanTask[];
  /** The user's session-long north-star objective (set via `/goal`) — pinned above the transcript. Persists
   *  across turns (NOT reset per run, unlike the plan). Empty/undefined until the user sets one. */
  goal?: string;
  /** Proposed tools awaiting their `tool.started` (keyed by toolCallId) — so the activity line reflects
   *  what's EXECUTING, not the last tool merely PROPOSED (all proposals for a turn are emitted up front). */
  pending: Record<string, Activity>;
  /** Tools that have STARTED but not yet resulted — so a finished tool doesn't reset the line to "Thinking"
   *  while a parallel sibling is still running (the line follows a still-active call instead). */
  active: Record<string, Activity>;
  /** Live model reasoning for the CURRENT step (rolling, bounded, transient — never persisted). Cleared when
   *  the model stops thinking and starts acting (a tool call) or answers. Rendered only when `showThinking`. */
  thinking: string;
  /** Whether the live reasoning block is shown (toggle: `/thinking` or Ctrl+T). */
  showThinking: boolean;
  /** Immutable monotonic counter for reducer-created item ids (keeps `reduce` pure). */
  seq: number;
}

/** Cap on the retained reasoning buffer — a rolling tail, so a verbose model can't grow the view unbounded. */
export const THINKING_BUFFER_CHARS = 4000;

export function initialState(opts: {
  agentMode: AgentMode;
  permission: Permission;
  effort: Effort;
  requestedModel: string;
  goal?: string;
}): ViewState {
  return {
    transcript: [],
    plan: [],
    ...(opts.goal ? { goal: opts.goal } : {}),
    pending: {},
    active: {},
    thinking: "",
    showThinking: true, // the user wants to SEE the model think by default; toggle with /thinking or Ctrl+T
    seq: 0,
    status: {
      agentMode: opts.agentMode,
      permission: opts.permission,
      effort: opts.effort,
      requestedModel: opts.requestedModel,
      running: false,
    },
  };
}

/** Map a running tool to a human activity verb + a short detail (for the live activity line). */
function toolActivity(toolName: string, args: unknown): Activity {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const path = typeof a.path === "string" ? a.path : undefined;
  const pattern = typeof a.pattern === "string" ? a.pattern : undefined;
  const command = typeof a.command === "string" ? a.command : undefined;
  switch (toolName) {
    case "read":
      return { verb: "Reading", detail: path };
    case "list":
      return { verb: "Listing", detail: path };
    case "glob":
      return { verb: "Finding files", detail: pattern };
    case "grep":
      return { verb: "Searching", detail: pattern };
    case "write":
      return { verb: "Writing", detail: path };
    case "edit":
      return { verb: "Editing", detail: path };
    case "bash":
      return { verb: "Running", detail: command ? command.slice(0, 60) : undefined };
    case "plan":
      return { verb: "Planning" };
    case "search_skills":
      return { verb: "Finding skills", detail: typeof a.query === "string" ? a.query : undefined };
    case "skill":
      return { verb: "Using skill", detail: typeof a.name === "string" ? a.name : undefined };
    case "web_fetch":
      return { verb: "Fetching", detail: typeof a.url === "string" ? a.url : undefined };
    case "web_search":
      return { verb: "Searching web", detail: typeof a.query === "string" ? a.query : undefined };
    case "remember":
      return { verb: "Saving to memory" };
    case "ask_user":
      return { verb: "Waiting for you" };
    default:
      return { verb: `Running ${toolName}`, detail: path };
  }
}

/** Preview the salient arg of a tool call (skill / query / path / command / pattern), for the one-liner. */
function previewArgs(toolName: string, args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    // Skills get their identifying arg surfaced so the friendly "using skill: X" row reads clearly.
    if (toolName === "skill" && typeof a.name === "string") return a.name;
    if (toolName === "search_skills" && typeof a.query === "string") return `"${a.query}"`;
    if (typeof a.path === "string") return a.path;
    if (typeof a.command === "string") return `$ ${(a.command as string).slice(0, 72)}`;
    if (typeof a.pattern === "string") return `/${a.pattern}/`;
  }
  return "";
}

/** Short model name — drop the vendor prefix (defensive against a non-string from a malformed event). */
function shortName(id: string): string {
  const s = typeof id === "string" ? id : String(id ?? "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Append a tool item (id comes from the runtime's globally-unique tool-call id). */
function push(s: ViewState, item: TranscriptItem): ViewState {
  return { ...s, transcript: [...s.transcript, item] };
}

/**
 * Append a reducer-created item with a deterministic id derived from the immutable `seq`. Pure: the id
 * is a function of state, so the same (state, event) always yields the same result.
 */
function pushItem(s: ViewState, make: (id: string) => TranscriptItem): ViewState {
  const seq = s.seq + 1;
  return { ...s, seq, transcript: [...s.transcript, make(`i-${seq}`)] };
}

function replaceAt(items: TranscriptItem[], idx: number, item: TranscriptItem): TranscriptItem[] {
  return [...items.slice(0, idx), item, ...items.slice(idx + 1)];
}

/** Turn a settled run's in-flight items terminal: streaming assistants stop; running tools become failed. */
function terminalizeInFlight(items: TranscriptItem[], cancelled: boolean): TranscriptItem[] {
  let changed = false;
  const next = items.map((it) => {
    if (it.kind === "assistant" && it.streaming) {
      changed = true;
      return { ...it, streaming: false };
    }
    if (it.kind === "tool" && it.status === "running") {
      changed = true;
      return {
        ...it,
        status: "fail" as const,
        error: it.error ?? (cancelled ? "cancelled" : "interrupted"),
      };
    }
    if (it.kind === "subagent" && it.status === "running") {
      changed = true;
      // A cancelled/interrupted run must never leave a subagent (or its children) blinking forever.
      return {
        ...it,
        status: "fail" as const,
        collapsed: true,
        children: it.children.map((c) =>
          c.status === "running" ? { ...c, status: "fail" as const, activity: undefined } : c,
        ),
      };
    }
    return it;
  });
  return changed ? next : items;
}

/** Immutable helper: find the subagent item by parent toolCallId (last match) and apply `fn` to it. */
function updateSubagent(
  s: ViewState,
  toolCallId: string,
  fn: (
    item: Extract<TranscriptItem, { kind: "subagent" }>,
  ) => Extract<TranscriptItem, { kind: "subagent" }>,
): ViewState {
  let idx = -1;
  for (let i = s.transcript.length - 1; i >= 0; i--) {
    const it = s.transcript[i];
    if (it?.kind === "subagent" && it.id === toolCallId) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return s;
  const item = s.transcript[idx] as Extract<TranscriptItem, { kind: "subagent" }>;
  return { ...s, transcript: replaceAt(s.transcript, idx, fn(item)) };
}

/** Settle a subagent group once all its children have finished: overall status + collapse. */
function settleSubagent(
  item: Extract<TranscriptItem, { kind: "subagent" }>,
): Extract<TranscriptItem, { kind: "subagent" }> {
  if (item.children.some((c) => c.status === "running")) return item;
  const anyFail = item.children.some((c) => c.status === "fail");
  return { ...item, status: anyFail ? "fail" : "ok", collapsed: true };
}

/** The fields that describe ONE run — reset per session so a second task never shows a stale model/gauge. */
function resetRunScoped(status: Status): Status {
  return {
    ...status,
    stopReason: undefined,
    targetModel: undefined,
    reportedModel: undefined,
    lane: undefined,
    contextWindow: undefined,
    promptEstimate: undefined,
    activity: undefined,
  };
}

/**
 * Fold one event into the view state. Kept exhaustive-ish; unknown kinds pass through untouched so the
 * TUI never crashes on a new event type.
 */
export function reduce(state: ViewState, ev: NewEvent): ViewState {
  switch (ev.kind) {
    case "session.started":
      // A run just started: reset run-scoped counters + the plan (a new session === a new run) so a
      // repeated task never carries the previous one's plan/turn/model. The transcript is preserved.
      // Activity stays "Thinking" (not cleared) so the indicator the optimistic echo already showed doesn't
      // flicker off during the catalog fetch (session.started → [fetch] → turn.started).
      return {
        ...state,
        plan: [],
        pending: {},
        active: {},
        thinking: "",
        status: { ...resetRunScoped(state.status), running: true, activity: { verb: "Thinking" } },
      };

    case "goal.set":
      // A durable goal change (from the `propose_goal_update` tool the user approved) — reflect it in the
      // pinned goal line immediately. The `/goal` command drives the same state via setGoal directly.
      return setGoal(state, ev.text);

    case "turn.started": {
      // If the App already echoed this message optimistically (the common TUI path), CONFIRM that item in
      // place — drop the `optimistic` flag + reconcile the text — instead of pushing a duplicate. Otherwise
      // (replay / non-TUI) push it fresh, exactly as before.
      const base = {
        ...state,
        thinking: "",
        status: { ...state.status, running: true, activity: { verb: "Thinking" as const } },
      };
      const lastIdx = state.transcript.length - 1;
      const last = state.transcript[lastIdx];
      if (last?.kind === "user" && last.optimistic) {
        return {
          ...base,
          transcript: replaceAt(state.transcript, lastIdx, {
            kind: "user",
            id: last.id,
            text: ev.input,
          }),
        };
      }
      return pushItem(base, (id) => ({ kind: "user", id, text: ev.input }));
    }

    case "model.resolved": {
      const status = {
        ...state.status,
        targetModel: ev.targetModel,
        lane: ev.lane,
        requestedModel: ev.requestedModel,
      };
      // An `auto` pick is the DEFAULT, not a substitution — the flightline already shows "←auto", so a
      // receipt reading "you asked for auto (no model requested)" is confusing noise. Only surface a receipt
      // for a REAL substitution: an explicit model the user named was swapped (cold or unknown).
      if (ev.targetModel !== ev.requestedModel && ev.requestedModel !== AUTO_MODEL) {
        const served = shortName(ev.targetModel);
        const asked = shortName(ev.requestedModel);
        return pushItem({ ...state, status }, (id) => ({
          kind: "receipt",
          id,
          text: `served by ${served} · you asked for ${asked} (${ev.reason ?? "warm substitute"})`,
        }));
      }
      return { ...state, status };
    }

    case "context.preflight":
      return {
        ...state,
        status: {
          ...state.status,
          contextWindow: ev.contextWindow,
          promptEstimate: ev.promptEstimate,
        },
      };

    case "inference.response":
      // The provider may report the model that ACTUALLY served (post-substitution) — fold it so the
      // flightline names who is really flying. (No token/telemetry accumulation — the flightline is minimal.)
      return ev.reportedModel
        ? { ...state, status: { ...state.status, reportedModel: ev.reportedModel } }
        : state;

    case "reasoning.delta": {
      // Live model thinking for the CURRENT step — a rolling, bounded, transient tail (never persisted).
      const text = typeof ev.text === "string" ? ev.text : "";
      if (text.length === 0) return state;
      const buf = (state.thinking + text).slice(-THINKING_BUFFER_CHARS);
      return {
        ...state,
        thinking: buf,
        status: { ...state.status, activity: { verb: "Thinking" } },
      };
    }

    case "assistant.delta": {
      const text = typeof ev.text === "string" ? ev.text : ""; // guard a malformed event
      // The model moved from thinking to answering → clear the live reasoning tail.
      const base = state.thinking ? { ...state, thinking: "" } : state;
      const last = base.transcript[base.transcript.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        // `spin` advances one frame per streamed chunk — the globe turns at the model's real token rate.
        const updated: TranscriptItem = { ...last, text: last.text + text, spin: last.spin + 1 };
        return { ...base, transcript: [...base.transcript.slice(0, -1), updated] };
      }
      // Don't OPEN a streaming item on whitespace-only content — a model that streams a blank preamble
      // then emits tool calls (no assistant.final) would otherwise leave a blank, forever-spinning line.
      if (text.trim().length === 0) return base;
      return pushItem(base, (id) => ({
        kind: "assistant",
        id,
        text,
        streaming: true,
        spin: 0,
      }));
    }

    case "assistant.final": {
      const finalText = typeof ev.text === "string" ? ev.text : "";
      // Finalize the LATEST streaming assistant (not just the last item — a tool call may sit after it).
      const idx = state.transcript.findLastIndex((t) => t.kind === "assistant" && t.streaming);
      if (idx >= 0) {
        const item = state.transcript[idx] as Extract<TranscriptItem, { kind: "assistant" }>;
        // The final IS the canonical complete text — prefer it when present (the streamed accumulation may
        // be missing a dropped leading-whitespace delta, e.g. an indented code block's indentation).
        const text = finalText.length > 0 ? finalText : item.text;
        return {
          ...state,
          transcript: replaceAt(state.transcript, idx, {
            ...item,
            text,
            streaming: false,
          }),
        };
      }
      if (finalText.length === 0) return state;
      return pushItem(state, (id) => ({
        kind: "assistant",
        id,
        text: finalText,
        streaming: false,
        spin: 0,
      }));
    }

    case "tool.proposed": {
      // Record what THIS call will do, keyed by id — the activity line reads it on `tool.started` (all
      // proposals for a turn are emitted up front, so proposal order is NOT execution order).
      const pending = { ...state.pending, [ev.toolCallId]: toolActivity(ev.toolName, ev.args) };
      // The `plan` tool updates the pinned task list, not the transcript — fold it and don't show a row.
      if (ev.toolName === "plan") {
        const plan = parsePlanTasks(ev.args);
        const next = { ...state, pending };
        return plan ? { ...next, plan } : next;
      }
      // The `subagent` tool renders its OWN richer transcript item on `subagent.started` — DON'T also push a
      // generic tool row here, or the two collide on the same toolCallId (duplicate React key + a stray "◐
      // subagent" line above the real tree). Keep the pending entry so the activity line still reflects it.
      if (ev.toolName === "subagent") return { ...state, pending };
      // The diff isn't known at proposal time — it's produced by the tool's OUTPUT and arrives on tool.result.
      return push(
        { ...state, pending },
        {
          kind: "tool",
          id: ev.toolCallId,
          name: ev.toolName,
          preview: previewArgs(ev.toolName, ev.args),
          status: "running",
        },
      );
    }

    case "tool.started": {
      // The tool is actually EXECUTING now — move it from pending → active and surface its verb/detail.
      // The model has stopped thinking and started acting → clear the live reasoning tail.
      const verb = state.pending[ev.toolCallId] ?? { verb: "Thinking" };
      const { [ev.toolCallId]: _p, ...pending } = state.pending;
      return {
        ...state,
        thinking: "",
        pending,
        active: { ...state.active, [ev.toolCallId]: verb },
        status: { ...state.status, activity: verb },
      };
    }

    case "tool.result": {
      // Match the NEWEST tool with this id (ids are globally unique, but the transcript accumulates
      // across tasks — a reverse search is robust and always targets the live call).
      const idx = state.transcript.findLastIndex(
        (t) => t.kind === "tool" && t.id === ev.toolCallId,
      );
      // Drop this call from pending + active. The activity follows a STILL-running sibling (parallel reads)
      // if any; else back to "Thinking". A folded `plan` result (idx<0) takes the same path so "Planning"
      // never sticks.
      const { [ev.toolCallId]: _p, ...pending } = state.pending;
      const { [ev.toolCallId]: _a, ...active } = state.active;
      const rest = Object.values(active);
      const activity: Activity =
        rest.length === 0
          ? { verb: "Thinking" }
          : rest.length === 1
            ? (rest[0] as Activity)
            : { verb: "Running", detail: `${rest.length} tools` };
      if (idx < 0) {
        return { ...state, pending, active, status: { ...state.status, activity } };
      }
      const item = state.transcript[idx] as Extract<TranscriptItem, { kind: "tool" }>;
      // The unified diff (write/edit OUTPUT) rides on tool.result — attach it now so the Diff renderer fires.
      const updated: TranscriptItem = {
        ...item,
        status: ev.ok ? "ok" : "fail",
        durationMs: ev.durationMs,
        error: ev.error,
        ...(ev.diff ? { diff: ev.diff } : {}),
        // Show the OUTPUT for tools without a diff (read/grep/bash/list) — a diff is its own better preview.
        ...(!ev.diff && ev.ok && ev.preview ? { resultPreview: ev.preview } : {}),
        ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}),
      };
      return {
        ...state,
        pending,
        active,
        transcript: replaceAt(state.transcript, idx, updated),
        status: { ...state.status, activity },
      };
    }

    case "handoff": {
      // A UTILITY handoff (e.g. routing compaction to a cheap model) is a momentary side call, NOT a change to
      // who's flying your task — it must NOT repoint the flightline (it stuck even when the compactor
      // call failed and we fell back). Only a real serving switch (failover/substitution) updates target/lane.
      const utility = ev.role === "compactor";
      const status = utility
        ? state.status
        : {
            ...state.status,
            targetModel: ev.to,
            // Clear the PRIOR model's reportedModel — otherwise StatusLine (which prefers reportedModel) would
            // keep naming the failed model until/unless the substitute's response reports its own name.
            reportedModel: undefined,
            ...(ev.lane ? { lane: ev.lane } : {}),
          };
      return pushItem({ ...state, status }, (id) => ({
        kind: "handoff",
        id,
        from: ev.from,
        to: ev.to,
        role: ev.role,
        reason: ev.reason,
      }));
    }

    case "vision.relay": {
      // A calm one-line receipt about how an attached image was handled. NATIVE (the model saw it) needs no
      // line — it just works. The relay/degrade outcomes are surfaced so the user knows what happened.
      if (ev.outcome === "native") return state;
      const text =
        ev.outcome === "described"
          ? `${shortName(ev.targetModel)} can't see images — ${shortName(ev.visionModel ?? "a vision model")} described it`
          : ev.outcome === "no-model"
            ? `${shortName(ev.targetModel)} can't see images, and no vision model is live — proceeding from your text`
            : ev.outcome === "cold"
              ? `${shortName(ev.targetModel)} can't see images, and the vision model is cold — proceeding from your text`
              : `couldn't read the attached image — proceeding from your text`;
      return pushItem(state, (id) => ({ kind: "receipt", id, text }));
    }

    case "error": {
      // rate_limit / cold are AUTOMATICALLY retried + failed-over by the runtime — they're transient, not
      // failures. Show them as ONE calm dim line (deduped), never a wall of red that reads as "broken". But a
      // TERMINAL error (retryable:false, e.g. empty fleet) must NOT claim "retrying / failing over…" even if
      // its kind is transport — honor the explicit signal over the kind.
      const transient =
        ev.retryable !== false &&
        (ev.errorKind === "rate_limit" || ev.errorKind === "cold" || ev.errorKind === "transport");
      const who = ev.model ? shortName(ev.model) : "the model";
      const state_word =
        ev.errorKind === "cold"
          ? "warming up"
          : ev.errorKind === "transport"
            ? "unreachable"
            : "busy";
      const text = transient
        ? `${who} is ${state_word} — retrying / failing over…`
        : `${ev.errorKind}: ${ev.message}`;
      const last = state.transcript[state.transcript.length - 1];
      if (last && last.kind === "notice" && last.text === text) return state; // collapse the burst
      return pushItem(state, (id) => ({
        kind: "notice",
        id,
        level: transient ? "info" : "error",
        text,
      }));
    }

    case "context.overflow":
      return pushItem(state, (id) => ({
        kind: "notice",
        id,
        level: "warn",
        text: `context overflow on ${ev.model} — could not fit even after compaction`,
      }));

    case "context.compacted":
      return pushItem(
        { ...state, status: { ...state.status, activity: { verb: "Compacting context" } } },
        (id) => ({
          kind: "notice",
          id,
          level: "info",
          text: `compacted context (${ev.summarizedPhases} messages summarized)`,
        }),
      );

    case "verify.gate":
      return pushItem(
        {
          ...state,
          status: {
            ...state.status,
            activity: ev.ok ? undefined : { verb: "Fixing failed verification" },
          },
        },
        (id) => ({
          kind: "notice",
          id,
          level: ev.ok ? "info" : "warn",
          text: ev.ok
            ? "verification passed"
            : `verification failed — re-asking the model to fix it${ev.summary ? `\n${ev.summary.split("\n").slice(0, 6).join("\n")}` : ""}`,
        }),
      );

    case "subagent.started": {
      const child: SubagentChild = {
        childSessionId: ev.childSessionId,
        label: ev.label,
        role: ev.role,
        model: shortName(ev.model),
        status: "running",
        tools: [],
      };
      const status: Status = {
        ...state.status,
        activity: { verb: "Delegating", detail: ev.label },
      };
      // Find-or-create the subagent group keyed by the parent toolCallId; append this child.
      const exists = state.transcript.some(
        (it) => it.kind === "subagent" && it.id === ev.toolCallId,
      );
      if (exists) {
        return updateSubagent({ ...state, status }, ev.toolCallId, (it) => ({
          ...it,
          children: [...it.children, child],
        }));
      }
      return push(
        { ...state, status },
        {
          kind: "subagent",
          id: ev.toolCallId,
          children: [child],
          status: "running",
          collapsed: false,
          spin: 0,
        },
      );
    }

    case "subagent.tool":
      return updateSubagent(state, ev.toolCallId, (it) => ({
        ...it,
        spin: it.spin + 1,
        children: it.children.map((c) => {
          if (c.childSessionId !== ev.childSessionId) return c;
          const activity: Activity = {
            ...toolActivity(ev.toolName, {}),
            ...(ev.preview ? { detail: ev.preview } : {}),
          };
          if (ev.status === "running") {
            const tools = [
              ...c.tools,
              {
                id: ev.childToolCallId,
                name: ev.toolName,
                status: "running" as const,
                ...(ev.preview ? { preview: ev.preview } : {}),
              },
            ].slice(-MAX_CHILD_TOOL_ROWS);
            return { ...c, activity, tools };
          }
          // settle the matching running tool row
          const tools = c.tools.map((t) =>
            t.id === ev.childToolCallId
              ? { ...t, status: ev.status, ...(ev.preview ? { preview: ev.preview } : {}) }
              : t,
          );
          return { ...c, activity, tools };
        }),
      }));

    case "subagent.finished":
      return updateSubagent(state, ev.toolCallId, (it) =>
        settleSubagent({
          ...it,
          children: it.children.map((c) =>
            c.childSessionId === ev.childSessionId
              ? {
                  ...c,
                  status: ev.stopReason === "complete" ? "ok" : "fail",
                  activity: undefined,
                  turns: ev.turns,
                  durationMs: ev.durationMs,
                  summary: ev.summary,
                  ...(ev.exploredTokens !== undefined ? { exploredTokens: ev.exploredTokens } : {}),
                  ...(ev.summaryTokens !== undefined ? { summaryTokens: ev.summaryTokens } : {}),
                }
              : c,
          ),
        }),
      );

    case "turn.finished":
      return {
        ...state,
        pending: {},
        active: {},
        thinking: "", // clear the reasoning tail at definitive turn end (incl. a reasoning-only blocked turn)
        status: { ...state.status, running: false, activity: undefined },
      };

    default:
      return state;
  }
}

/**
 * Mark the run finished with a stop reason (called when Agent.run settles). Also terminalizes any
 * in-flight items — a stream cut off by an abort/error must not blink forever.
 */
export function withStop(state: ViewState, stopReason: string): ViewState {
  return {
    ...state,
    transcript: terminalizeInFlight(state.transcript, stopReason === "cancelled"),
    pending: {},
    active: {},
    thinking: "", // a stopped run (incl. reasoning-only blocked/cancelled) must not leave a stale thinking tail
    status: { ...state.status, running: false, stopReason, activity: undefined },
  };
}

/**
 * Echo the user's submitted message INSTANTLY (before the run's catalog fetch), with the "Thinking" activity
 * line, so pressing Enter has zero perceived lag. The item is flagged `optimistic`; the run's `turn.started`
 * event later confirms it in place (no duplicate). Purely additive — the non-TUI path never calls this and
 * still gets its user echo from `turn.started`.
 */
export function optimisticEcho(state: ViewState, text: string): ViewState {
  return pushItem(
    {
      ...state,
      thinking: "",
      status: { ...state.status, running: true, activity: { verb: "Thinking" } },
    },
    (id) => ({ kind: "user", id, text, optimistic: true }),
  );
}

/** Push a notice into the transcript (for slash-command feedback like /help, /model, /models). */
export function appendNotice(
  state: ViewState,
  level: "info" | "warn" | "error",
  text: string,
): ViewState {
  return pushItem(state, (id) => ({ kind: "notice", id, level, text }));
}

/** Clear the visible transcript + plan (the /clear slash command). Keeps the run status. */
export function clearTranscript(state: ViewState): ViewState {
  // Only wipe the visible scrollback — KEEP the pinned plan + the in-flight execution bookkeeping
  // (pending/active) so a mid-run /clear can't lose the plan or strand the activity verb.
  return { ...state, transcript: [] };
}

/** Set the requested model in the status (the /model slash command); takes effect on the next run. */
export function setRequestedModel(state: ViewState, requestedModel: string): ViewState {
  return { ...state, status: { ...state.status, requestedModel } };
}

/** Set the reasoning effort in the status (the /effort slash command); takes effect on the next run. */
export function setEffort(state: ViewState, effort: Effort): ViewState {
  return { ...state, status: { ...state.status, effort } };
}

/** Hard cap on a goal's length — a north-star buys its permanent seat in context by staying tiny (~2
 *  sentences); a long goal both wastes the window every turn and dilutes a weaker model's attention. */
export const MAX_GOAL_CHARS = 280;

/** Set (or clear, with "") the session's north-star goal (the /goal command). Trimmed + length-capped; an
 *  empty string clears it. Takes effect on the next run and shows in the pinned goal line immediately. */
export function setGoal(state: ViewState, goal: string): ViewState {
  const trimmed = goal.trim().slice(0, MAX_GOAL_CHARS);
  return { ...state, ...(trimmed ? { goal: trimmed } : { goal: undefined }) };
}
