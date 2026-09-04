import { IMAGE_EDGE_HIGH, discoverCommands, expandCommand } from "@amb/context";
import {
  type AskRequest,
  type AskResponse,
  type Grant,
  type ImageAttachment,
  type NewEvent,
  type ToolDefinition,
  newSessionId,
} from "@amb/protocol";
import { Agent, type CapabilityPort, type ChatClient, type RunOptions } from "@amb/runtime";
import {
  type SessionWriter,
  readObject,
  readSession,
  reconstructTranscript,
  saveObject,
} from "@amb/sessions";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createDurableEventSink } from "../agent/event-sink.js";
import { buildRegistry } from "../agent/registry.js";
import { makeSubagentTool } from "../agent/subagent-tool.js";
import { makeVerifyPort } from "../agent/verify-port.js";
import { makeWorkspaceContextPort } from "../agent/workspace-context-port.js";
import type { FleetRow } from "../render/fleet.js";
import {
  attachImageFile,
  captureClipboardImage,
  downscaleForWindow,
  looksLikeImagePath,
} from "./capture.js";
import { ActivityLine } from "./components/ActivityLine.js";
import {
  Approval,
  type ApprovalDecision,
  type ApprovalRequest,
  defaultApprovalSel,
  resolveApprovalKey,
} from "./components/Approval.js";
import { Banner, Watermark } from "./components/Banner.js";
import { Composer } from "./components/Composer.js";
import { EffortPicker } from "./components/EffortPicker.js";
import { Goal } from "./components/Goal.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { Plan } from "./components/Plan.js";
import { Question, type QuestionState } from "./components/Question.js";
import { type SkillRow, SkillsBrowser } from "./components/SkillsBrowser.js";
import {
  SLASH_COMMANDS,
  type SlashCommand,
  SlashPalette,
  matchSlash,
} from "./components/SlashPalette.js";
import { StatusLine } from "./components/StatusLine.js";
import { Thinking } from "./components/Thinking.js";
import { Transcript } from "./components/Transcript.js";
import {
  type AgentMode,
  EFFORTS,
  type Effort,
  MAX_GOAL_CHARS,
  type Permission,
  type PlanTask,
  type ViewState,
  appendNotice,
  clearTranscript,
  initialState,
  nextPermission,
  optimisticEcho,
  reduce,
  setEffort,
  setGoal,
  setRequestedModel,
  toRuntimeMode,
  toggleAgentMode,
  withStop,
} from "./state.js";
import { AmbientTheme } from "./theme.js";

export interface AppDeps {
  client: ChatClient;
  makeWriter: (sessionId: string) => SessionWriter;
  capabilities?: CapabilityPort;
  agentMode: AgentMode;
  permission: Permission;
  effort: Effort;
  requestedModel: string;
  maxTurns: number;
  cwd: string;
  workspaceRoot: string;
  fleet?: FleetRow[];
  initialTask?: string;
  /** A north-star goal to start with (e.g. restored on `amb resume`). Shows in the pinned goal line + is
   *  threaded into every run. */
  initialGoal?: string;
  /** Session grants seeded from the config allowlist — those tools are auto-allowed without prompting. */
  initialGrants?: Grant[];
  /** Tools from the user's connected MCP servers (Claude + Codex config), registered per run. */
  mcpTools?: ToolDefinition[];
  /** Live getter for MCP tools — MCP connects in the BACKGROUND (so the UI renders instantly), so a run reads
   *  the tools available RIGHT NOW rather than a snapshot from mount time (empty until the servers finish). */
  getMcpTools?: () => ToolDefinition[];
  /** Skill counts for the `/skills` summary (loaded at the CLI edge; the App never touches the filesystem). */
  skillsInfo?: { total: number; pinned: number };
  /** Full skill rows for the interactive `/skills` browser (loaded at the CLI edge). */
  skills?: SkillRow[];
  /** Pin/unpin a skill from the browser — writes the pin list at the edge; returns the new pinned state. */
  onTogglePin?: (name: string) => boolean;
}

type Action =
  | { t: "event"; ev: NewEvent }
  | { t: "stop"; stopReason: string }
  | { t: "agentMode"; agentMode: AgentMode }
  | { t: "permission"; permission: Permission }
  | { t: "effort"; effort: Effort }
  | { t: "model"; model: string }
  | { t: "notice"; level: "info" | "warn" | "error"; text: string }
  | { t: "echo"; text: string }
  | { t: "toggleThinking" }
  | { t: "goal"; text: string }
  | { t: "clear" };

function appReducer(state: ViewState, action: Action): ViewState {
  switch (action.t) {
    case "event":
      return reduce(state, action.ev);
    case "stop":
      return withStop(state, action.stopReason);
    case "agentMode":
      return { ...state, status: { ...state.status, agentMode: action.agentMode } };
    case "permission":
      return { ...state, status: { ...state.status, permission: action.permission } };
    case "effort":
      return setEffort(state, action.effort);
    case "model":
      return setRequestedModel(state, action.model);
    case "goal":
      return setGoal(state, action.text);
    case "notice":
      return appendNotice(state, action.level, action.text);
    case "echo":
      return optimisticEcho(state, action.text);
    case "toggleThinking": {
      // Flip it AND leave a clear trace — before, toggling gave no feedback at all (user: "no indication
      // if it's on or off when I trigger it"). The flightline also shows a persistent `think` marker while on.
      const next = !state.showThinking;
      return appendNotice(
        { ...state, showThinking: next },
        "info",
        `reasoning view ${next ? "ON — the model's thinking will show as it works" : "OFF"}`,
      );
    }
    case "clear":
      return clearTranscript(state);
  }
}

/** The instruction that executes the SAVED plan ("adhere to it"). Called only for an explicit empty-Enter
 *  in BUILD mode; the steps are one-line labels (sanitized in parsePlan) referenced back to the model. */
function withPlan(plan: PlanTask[]): string {
  const list = plan.map((t, i) => `${i + 1}. [${t.status}] ${t.text}`).join("\n");
  return `Execute the plan you prepared (mark each step done as you complete it):\n${list}`;
}

export function App(deps: AppDeps): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  const [state, dispatch] = useReducer(
    appReducer,
    initialState({
      agentMode: deps.agentMode,
      permission: deps.permission,
      effort: deps.effort,
      requestedModel: deps.requestedModel,
      ...(deps.initialGoal ? { goal: deps.initialGoal } : {}),
    }),
  );
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  // The open questionnaire (backs the `ask_user` tool), or null when none is pending.
  const [question, setQuestion] = useState<QuestionState | null>(null);
  // Images pending on the NEXT message (Ctrl+V / drag-drop / /attach). Ref mirror for synchronous key handling.
  const [attachments, setAttachmentsState] = useState<ImageAttachment[]>([]);
  const [fleet] = useState(deps.fleet);
  // The model picker only offers LIVE models — a cold model 429s ("no workers") and would just be substituted,
  // so listing it is noise. (The runtime still substitutes if a chosen model goes cold between pick and run.)
  const readyFleet = useMemo(() => (fleet ?? []).filter((r) => r.avail === "ready"), [fleet]);
  const [runActive, setRunActive] = useState(false);
  const [queued, setQueued] = useState<string[]>([]);
  const [slashSel, setSlashSel] = useState(0);
  // Discover the user's existing Claude/Codex slash commands ONCE — their names join the palette, their
  // bodies (with $ARGUMENTS/$1 expansion) run as a task on dispatch.
  const customCommands = useMemo(() => {
    const palette: SlashCommand[] = [];
    const bodies = new Map<string, string>();
    try {
      for (const c of discoverCommands(deps.workspaceRoot)) {
        const name = `/${c.name}`;
        palette.push({
          name,
          desc: c.description ?? "custom command",
          ...(c.argumentHint ? { args: c.argumentHint } : {}),
        });
        bodies.set(name, c.body);
      }
    } catch {
      /* best-effort — a bad command dir never breaks the TUI */
    }
    return { palette, bodies };
  }, [deps.workspaceRoot]);
  const [picker, setPickerState] = useState<"model" | "effort" | "skills" | null>(null);
  const [pickerSel, setPickerSelState] = useState(0);
  const [approvalSel, setApprovalSelState] = useState(0);
  const [tick, setTick] = useState(0);
  const runStartRef = useRef(0);
  const phaseStartRef = useRef(0);

  // Skills browser (/skills): filter text + a LIVE pinned set (toggled with Tab, written at the edge). The
  // filtered+sorted rows are held in a ref too, so the key handler can navigate them synchronously.
  const [skillFilter, setSkillFilterState] = useState("");
  const skillFilterRef = useRef("");
  const setSkillFilter = (f: string): void => {
    skillFilterRef.current = f;
    setSkillFilterState(f);
  };
  const [pinnedSet, setPinnedSet] = useState<Set<string>>(
    () => new Set((deps.skills ?? []).filter((s) => s.pinned).map((s) => s.name)),
  );
  const filteredSkills = useMemo(() => {
    const all = (deps.skills ?? []).map((s) => ({ ...s, pinned: pinnedSet.has(s.name) }));
    const f = skillFilter.trim().toLowerCase();
    const matched =
      f.length === 0
        ? all
        : all.filter(
            (s) => s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f),
          );
    return matched.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        a.source.localeCompare(b.source) ||
        a.name.localeCompare(b.name),
    );
  }, [deps.skills, skillFilter, pinnedSet]);
  const filteredSkillsRef = useRef<SkillRow[]>([]);
  filteredSkillsRef.current = filteredSkills;

  const controllerRef = useRef<AbortController | null>(null);
  const approvalResolver = useRef<((d: "allow-once" | "allow-session" | "deny") => void) | null>(
    null,
  );
  const busyRef = useRef(false);
  const inputRef = useRef("");
  const queueRef = useRef<{ text: string; attachments: ImageAttachment[] }[]>([]);
  const cancellingRef = useRef(false);
  const agentModeRef = useRef<AgentMode>(deps.agentMode);
  const permissionRef = useRef<Permission>(deps.permission);
  const effortRef = useRef<Effort>(deps.effort);
  const modelRef = useRef<string>(deps.requestedModel);
  const planRef = useRef<PlanTask[]>([]);
  // The live north-star goal (synchronously read by runTask) + the last goal persisted to the CURRENT
  // session's log, so a changed goal is recorded once per session for `amb resume` to restore.
  const goalRef = useRef<string>(deps.initialGoal ?? "");
  const persistedGoalRef = useRef<string | undefined>(undefined);
  const pickerRef = useRef<"model" | "effort" | "skills" | null>(null);
  const pickerSelRef = useRef(0);
  const approvalSelRef = useRef(0); // selection index read SYNCHRONOUSLY by the key handler (state lags a frame)
  // The questionnaire resolver + a live mirror of its state (refs so the key handler mutates synchronously —
  // React state lags a frame, and a fast typist / quick Enter must never act on stale option/text state).
  const questionResolver = useRef<((res: AskResponse) => void) | null>(null);
  const questionRef = useRef<QuestionState | null>(null);
  const attachmentsRef = useRef<ImageAttachment[]>([]);
  const capturingRef = useRef(false); // debounce overlapping Ctrl+V while a capture is in flight
  // ONE grants array for the whole TUI session, so "allow for this session" actually persists across turns
  // (each turn is its own Agent.run; without a stable array the grant would be discarded every prompt).
  // Seeded from the config allowlist so those tools are pre-approved for the launch.
  const sessionGrantsRef = useRef<Grant[]>(deps.initialGrants ? [...deps.initialGrants] : []);
  // ONE session id + writer per TUI launch (NOT per submit): each turn is its own Agent.run, but they share a
  // single durable log so history/resume is coherent — and the SAME writer instance, because SessionWriter
  // chains seq/prevChecksum per instance (a fresh writer on the same file would restart seq=0 and break the
  // hash chain). Reset to null by /clear so a cleared screen starts a genuinely new conversation.
  const sessionIdRef = useRef<string | null>(null);
  const writerRef = useRef<SessionWriter | null>(null);
  const runTaskRef = useRef<((task: string, attach?: ImageAttachment[]) => Promise<void>) | null>(
    null,
  );
  const MAX_ATTACHMENTS = 4;
  const setAttachments = (next: ImageAttachment[]): void => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
  };
  // Add an attachment (deduped by sha256, capped) and tell the user.
  const addAttachment = (att: ImageAttachment): void => {
    if (attachmentsRef.current.some((a) => a.sha256 === att.sha256)) return; // same image already pending
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      dispatch({
        t: "notice",
        level: "warn",
        text: `at most ${MAX_ATTACHMENTS} images per message`,
      });
      return;
    }
    setAttachments([...attachmentsRef.current, att]);
    const kb = Math.max(1, Math.round(att.bytes / 1024));
    dispatch({ t: "notice", level: "info", text: `image attached (${kb} KB)` });
  };
  // Ctrl+V / paste-a-path capture — async, debounced; a failure is a calm dim notice, never a crash.
  const captureImage = async (): Promise<void> => {
    if (capturingRef.current) return;
    capturingRef.current = true;
    try {
      const res = await captureClipboardImage();
      if (res.ok) addAttachment(res.attachment);
      else dispatch({ t: "notice", level: "info", text: res.reason });
    } finally {
      capturingRef.current = false;
    }
  };

  const setPicker = (p: "model" | "effort" | "skills" | null): void => {
    pickerRef.current = p;
    setPickerState(p);
  };
  const setPickerSel = (n: number): void => {
    pickerSelRef.current = n;
    setPickerSelState(n);
  };
  const setApprovalSel = (n: number): void => {
    approvalSelRef.current = n;
    setApprovalSelState(n);
  };

  const approve = useCallback<RunOptions["approve"]>((req) => {
    return new Promise((resolve) => {
      // "Bypass session" (chosen from an earlier approval, or /bypass) auto-allows the rest of THIS run without
      // a prompt — the current run's mode was snapshotted at start, so decide() still asks; we short-circuit here.
      if (permissionRef.current === "bypass") {
        resolve("allow-once");
        return;
      }
      approvalResolver.current = resolve;
      // Pre-arm the selection: allow-once for a normal ask, but DENY when the request was escalated for risk —
      // a muscle-memory Enter must never approve something we flagged as dangerous. (ref + state, no closure.)
      const seed = defaultApprovalSel(req.decision.reason);
      approvalSelRef.current = seed;
      setApprovalSelState(seed);
      setPending({
        toolName: req.toolName,
        args: req.args,
        effects: req.effects,
        decision: req.decision,
      });
    });
  }, []);

  // Push a questionnaire (both the ref the key handler reads and the state that renders).
  const setQuestionState = (q: QuestionState | null): void => {
    questionRef.current = q;
    setQuestion(q);
  };
  // The interactive-question port (backs `ask_user`): open the overlay and resolve when the human submits/skips.
  // Inlines the ref+setState (rather than calling setQuestionState) so this memoized callback depends only on
  // stable refs + the state setter — no per-render function in its closure.
  const ask = useCallback<NonNullable<RunOptions["ask"]>>((req: AskRequest) => {
    return new Promise<AskResponse>((resolve) => {
      questionResolver.current = resolve;
      const q: QuestionState = { req, cursor: 0, selected: new Set<number>(), text: "" };
      questionRef.current = q;
      setQuestion(q);
    });
  }, []);
  // Settle the open question. `cancelled` (Esc / abort) tells the agent to proceed on its own judgment.
  const finishQuestion = (res: AskResponse): void => {
    const resolve = questionResolver.current;
    questionResolver.current = null;
    setQuestionState(null);
    resolve?.(res);
  };
  const submitQuestion = (): void => {
    const q = questionRef.current;
    if (!q) return;
    const multi = q.req.multiSelect === true;
    const opts = q.req.options ?? [];
    // Single-select: the ▸ cursor IS the selection (when there are options). Multi: the toggled set.
    const idxs = multi ? [...q.selected].sort((a, b) => a - b) : opts.length > 0 ? [q.cursor] : [];
    const selected = idxs.map((i) => opts[i]?.label).filter((l): l is string => Boolean(l));
    finishQuestion({ selected, ...(q.text.trim() ? { text: q.text.trim() } : {}) });
  };

  const abortRun = useCallback(() => {
    cancellingRef.current = true;
    queueRef.current = [];
    setQueued([]);
    controllerRef.current?.abort();
    const resolve = approvalResolver.current;
    if (resolve) {
      approvalResolver.current = null;
      setPending(null);
      resolve("deny");
    }
    // A run cancelled while a question is open must settle it (cancelled) so the tool promise never dangles.
    const qResolve = questionResolver.current;
    if (qResolve) {
      questionResolver.current = null;
      questionRef.current = null;
      setQuestion(null);
      qResolve({ selected: [], cancelled: true });
    }
  }, []);

  const runTask = useCallback(
    async (task: string, attach: ImageAttachment[] = []) => {
      if (busyRef.current) return;
      busyRef.current = true;
      runStartRef.current = Date.now();
      setTick(0);
      setRunActive(true);
      // One session id + writer for the whole TUI launch (minted lazily on the first turn, reset by /clear).
      if (!sessionIdRef.current || !writerRef.current) {
        sessionIdRef.current = newSessionId();
        writerRef.current = deps.makeWriter(sessionIdRef.current);
        persistedGoalRef.current = undefined; // a fresh session log hasn't recorded the goal yet
      }
      const sessionId = sessionIdRef.current;
      const writer = writerRef.current;
      // Record the current north-star into THIS session's log if it changed since we last did, so `amb resume`
      // restores it. Written before the run so it precedes turn.started in the durable order.
      if (goalRef.current !== (persistedGoalRef.current ?? "")) {
        writer.append({
          kind: "goal.set",
          schemaVersion: 1,
          sessionId,
          text: goalRef.current,
        } as NewEvent);
        persistedGoalRef.current = goalRef.current;
      }
      // Conversational continuity: replay the prior turns of THIS session into the next run's context so the
      // agent actually remembers what was just said (each turn is an independent Agent.run). Turn 1 has none.
      // The runtime budgets + trims this to the served window (resumeContext is the first thing it drops).
      const priorContext = reconstructTranscript(readSession(sessionId).events);
      const controller = new AbortController();
      controllerRef.current = controller;
      // Snapshot the axes for THIS run (a mid-run Tab/Shift+Tab must not change what's already flying).
      const agentMode = agentModeRef.current;
      const runtimeMode = toRuntimeMode(agentMode, permissionRef.current);
      // The saved plan is ONLY executed by an explicit empty-Enter ("build the plan") — a typed task is a
      // NEW request and runs as-is, never merged with the old plan. An IMAGE-ONLY send (empty text + an
      // attachment) is a real "look at this" request, NOT plan execution, so it must not be hijacked.
      const finalTask =
        agentMode === "build" && task === "" && attach.length === 0
          ? withPlan(planRef.current)
          : task;
      // Echo the message + show "Thinking" THE INSTANT the user submits — before the run's catalog fetch —
      // so pressing Enter never leaves a dead gap. The run's turn.started confirms this item in place.
      dispatch({ t: "echo", text: finalTask });

      try {
        // Shared durable-event sink: persist FIRST (validated), then dispatch to the reducer — so the UI never
        // shows an event that wasn't durably logged, and a write failure aborts + surfaces one way everywhere.
        const emit = createDurableEventSink({
          writer,
          consume: (ev: NewEvent) => {
            // A goal.set emitted mid-run (propose_goal_update, user-approved) is already persisted by this
            // sink — mark it so the next run-start doesn't re-append the same goal.
            if (ev.kind === "goal.set") persistedGoalRef.current = ev.text;
            dispatch({ t: "event", ev });
          },
          onWriteError: () => {
            controller.abort();
            dispatch({
              t: "event",
              ev: {
                kind: "error",
                schemaVersion: 1,
                sessionId,
                errorKind: "transport",
                message: "session log write failed — aborting",
              } as NewEvent,
            });
          },
        });

        // Downscale huge screenshots to a universal safe edge before send (bounds wire bytes; the agent bounds
        // TOKENS per the served window). Offload each image's bytes to the session object store (keyed by hash)
        // so a resumed session can rehydrate without the base64 living in the event log.
        const sized =
          attach.length > 0
            ? await Promise.all(attach.map((a) => downscaleForWindow(a, IMAGE_EDGE_HIGH)))
            : [];
        for (const a of sized) saveObject(sessionId, a.dataBase64);

        const opts: RunOptions = {
          sessionId,
          mode: runtimeMode,
          requestedModel: modelRef.current,
          maxTurns: deps.maxTurns,
          cwd: deps.cwd,
          workspaceRoot: deps.workspaceRoot,
          signal: controller.signal,
          emit,
          approve,
          ask, // the `ask_user` tool opens the questionnaire overlay through this
          grants: sessionGrantsRef.current, // persist "allow for this session" across turns
          ...(goalRef.current ? { goal: goalRef.current } : {}), // the session north-star, pinned in the anchor
          ...(priorContext ? { resumeContext: priorContext } : {}), // remember earlier turns this session
          ...(sized.length > 0 ? { attachments: sized } : {}),
          capabilities: deps.capabilities,
          workspace: makeWorkspaceContextPort(),
          verify: makeVerifyPort(deps.workspaceRoot),
          checkpoint: (content) => saveObject(sessionId, content),
          artifact: (content) => saveObject(sessionId, content), // offload large tool outputs
          readArtifact: (handle) => readObject(sessionId, handle),
          effort: effortRef.current,
        };

        // Build the registry with the `subagent` tool per-run, capturing THIS run's mode/approver/verify.
        // Read MCP tools LIVE (they connect in the background) so a run started once the servers are ready
        // picks them up, without blocking the UI at launch.
        const mcpTools = deps.getMcpTools?.() ?? deps.mcpTools;
        const registry = buildRegistry({
          ...(mcpTools && mcpTools.length > 0 ? { mcpTools } : {}),
          subagent: makeSubagentTool({
            client: deps.client,
            workspace: opts.workspace,
            approve,
            parentMode: runtimeMode,
            ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
            ...(opts.verify ? { verify: opts.verify } : {}),
            ...(goalRef.current ? { goal: goalRef.current } : {}), // children inherit the north-star
            effort: effortRef.current,
          }),
        });

        const result = await new Agent(deps.client, registry).run(finalTask, opts);
        dispatch({ t: "stop", stopReason: result.stopReason });
      } catch (err) {
        dispatch({ t: "stop", stopReason: "error" });
        dispatch({
          t: "event",
          ev: {
            kind: "error",
            schemaVersion: 1,
            sessionId,
            errorKind: "transport",
            message: err instanceof Error ? err.message : String(err),
          } as NewEvent,
        });
      } finally {
        controllerRef.current = null;
        busyRef.current = false;
        setRunActive(false);
        const resolve = approvalResolver.current;
        if (resolve) {
          approvalResolver.current = null;
          resolve("deny");
        }
        setPending(null);
        // Settle any dangling question so its tool promise never leaks past the run (parity with approvals).
        const qResolve = questionResolver.current;
        if (qResolve) {
          questionResolver.current = null;
          questionRef.current = null;
          qResolve({ selected: [], cancelled: true });
        }
        setQuestion(null);
        cancellingRef.current = false;
        const next = queueRef.current.shift();
        if (next) {
          setQueued(queueRef.current.map((q) => q.text));
          void runTaskRef.current?.(next.text, next.attachments);
        }
      }
    },
    [approve, ask, deps],
  );
  runTaskRef.current = runTask;

  // Keep refs in sync for the queue drain + plan-adherence (React state lags a frame).
  useEffect(() => {
    planRef.current = state.plan;
  }, [state.plan]);
  // Keep the synchronously-read goalRef mirrored to state.goal — so a goal set by the `propose_goal_update`
  // tool (which drives state.goal via a goal.set event) reaches the NEXT run, just like the `/goal` command.
  useEffect(() => {
    goalRef.current = state.goal ?? "";
  }, [state.goal]);

  useEffect(() => {
    if (!runActive) return;
    const id = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(id);
  }, [runActive]);

  // Reset the per-phase clock whenever the live activity verb changes (P1.10 — thinking-duration timer).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the verb is the CHANGE TRIGGER, not a value used
  useEffect(() => {
    phaseStartRef.current = Date.now();
  }, [state.status.activity?.verb]);

  // On unmount (quit), abort any in-flight run so nothing keeps executing after the UI is gone.
  useEffect(() => () => controllerRef.current?.abort(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional run-once-on-mount
  useEffect(() => {
    const task = deps.initialTask?.trim();
    if (task) void runTask(task);
  }, []);

  const setBuffer = (nextValue: string): void => {
    inputRef.current = nextValue;
    setInput(nextValue);
    setSlashSel(0);
  };

  const openModelPicker = (): void => {
    const list = readyFleet;
    // No LIVE models (fleet fetch failed, or every model is cold) → don't open an empty no-op box; point at
    // the manual path (a cold model can still be chosen by id — the runtime substitutes a warm one).
    if (list.length === 0) {
      dispatch({
        t: "notice",
        level: "warn",
        text: "no live models right now — set one by id with /model <vendor/model-id>",
      });
      setBuffer("");
      return;
    }
    const idx = Math.max(
      0,
      list.findIndex((r) => r.id === modelRef.current),
    );
    setPickerSel(idx);
    setPicker("model");
    setBuffer("");
  };

  const openEffortPicker = (): void => {
    setPickerSel(Math.max(0, EFFORTS.indexOf(effortRef.current)));
    setPicker("effort");
    setBuffer("");
  };

  const runSlash = (command: SlashCommand, arg: string): void => {
    // Config commands change what the NEXT run does — refuse them mid-run so the flightline never
    // misrepresents the run that's already flying (its mode/permission/model were captured at launch).
    const CONFIG = new Set([
      "/model",
      "/models",
      "/effort",
      "/plan",
      "/build",
      "/ask",
      "/accept",
      "/bypass",
    ]);
    if (busyRef.current && CONFIG.has(command.name)) {
      dispatch({
        t: "notice",
        level: "warn",
        text: "finish or cancel the current run first (esc) to change mode/model",
      });
      setBuffer("");
      return;
    }
    switch (command.name) {
      case "/help":
        dispatch({
          t: "notice",
          level: "info",
          text: `commands — ${SLASH_COMMANDS.map((c) => c.name).join("  ")}`,
        });
        break;
      case "/model":
        if (arg) {
          modelRef.current = arg;
          dispatch({ t: "model", model: arg });
          dispatch({ t: "notice", level: "info", text: `model → ${arg}` });
          setBuffer(""); // openModelPicker clears the else-branch; the arg branch must too
        } else {
          openModelPicker();
        }
        return;
      case "/models":
        openModelPicker();
        return;
      case "/effort":
        if (arg) {
          const choice = arg.trim().toLowerCase();
          if ((EFFORTS as readonly string[]).includes(choice)) {
            const e = choice as Effort;
            effortRef.current = e;
            dispatch({ t: "effort", effort: e });
            dispatch({ t: "notice", level: "info", text: `effort → ${e}` });
          } else {
            dispatch({
              t: "notice",
              level: "warn",
              text: `unknown effort: ${arg} — pick one of ${EFFORTS.join(" / ")}`,
            });
          }
          setBuffer(""); // openEffortPicker clears the else-branch; the arg branch must too
        } else {
          openEffortPicker();
        }
        return;
      case "/plan":
        agentModeRef.current = "plan";
        dispatch({ t: "agentMode", agentMode: "plan" });
        break;
      case "/build":
        agentModeRef.current = "build";
        dispatch({ t: "agentMode", agentMode: "build" });
        break;
      case "/ask":
      case "/accept":
      case "/bypass": {
        const p: Permission =
          command.name === "/accept"
            ? "accept-edits"
            : command.name === "/bypass"
              ? "bypass"
              : "ask";
        permissionRef.current = p;
        dispatch({ t: "permission", permission: p });
        break;
      }
      case "/thinking":
        dispatch({ t: "toggleThinking" });
        break;
      case "/goal": {
        const a = arg.trim();
        // `/goal` (no arg) or `/goal show` → report the current goal into the transcript.
        if (!a || a.toLowerCase() === "show") {
          dispatch({
            t: "notice",
            level: "info",
            text: goalRef.current
              ? `goal: ${goalRef.current}`
              : "no goal set — `/goal <objective>` sets a north-star the agent keeps in view every turn",
          });
          break;
        }
        // `/goal clear` (and friends) → drop the north-star.
        if (["clear", "off", "reset", "none"].includes(a.toLowerCase())) {
          goalRef.current = "";
          dispatch({ t: "goal", text: "" });
          dispatch({ t: "notice", level: "info", text: "goal cleared" });
          break;
        }
        // Otherwise set/replace it (trimmed + length-capped by the reducer; mirror the capped value in the ref).
        const next = a.slice(0, MAX_GOAL_CHARS);
        goalRef.current = next;
        dispatch({ t: "goal", text: next });
        dispatch({ t: "notice", level: "info", text: `goal set — ${next}` });
        break;
      }
      case "/attach": {
        const path = arg.trim();
        if (!path) {
          dispatch({
            t: "notice",
            level: "info",
            text: "usage: /attach <path-to-image> (or Ctrl+V to paste)",
          });
        } else {
          void attachImageFile(path, "file").then((res) => {
            if (res.ok) addAttachment(res.attachment);
            else dispatch({ t: "notice", level: "warn", text: res.reason });
          });
        }
        break;
      }
      case "/skills": {
        // Open the interactive browser when we have the skill rows; else a summary notice.
        if (deps.skills && deps.skills.length > 0) {
          setSkillFilter("");
          setPickerSel(0);
          setPicker("skills");
        } else {
          const info = deps.skillsInfo;
          const count = info
            ? `${info.total} skill${info.total === 1 ? "" : "s"} available`
            : "Skills";
          const pin = info && info.pinned > 0 ? ` · ${info.pinned} pinned (always load)` : "";
          dispatch({
            t: "notice",
            level: "info",
            text: `${count}${pin} — searched on demand. Browse: ambient skills · pin: ambient skills pin "<name>"`,
          });
        }
        break;
      }
      case "/clear":
        // Clearing the screen also starts a NEW conversation: drop the session refs so the next turn mints a
        // fresh id/writer and carries NO prior-turn context (otherwise the agent would "remember" what the
        // user just cleared). Only when idle — a mid-run /clear must not swap the session out from under it.
        if (!busyRef.current) {
          sessionIdRef.current = null;
          writerRef.current = null;
        }
        dispatch({ t: "clear" });
        break;
      case "/quit":
        // Never quit with work still flying — abort the run first so nothing runs on invisibly.
        if (busyRef.current) abortRun();
        exit();
        break;
      default: {
        // A discovered Claude/Codex command → expand its template with the args and run it as a task.
        const body = customCommands.bodies.get(command.name);
        if (body === undefined) {
          dispatch({ t: "notice", level: "warn", text: `unknown command: ${command.name}` });
        } else if (busyRef.current) {
          // runTask no-ops while a run is in flight — say so instead of silently dropping the command.
          dispatch({
            t: "notice",
            level: "warn",
            text: `busy — wait for the current run before running ${command.name}`,
          });
        } else {
          setBuffer("");
          const tokens = arg.trim().length > 0 ? arg.trim().split(/\s+/) : [];
          void runTaskRef.current?.(expandCommand(body, tokens));
        }
      }
    }
    setBuffer("");
  };

  useInput((ch, key) => {
    // 1) A pending approval takes precedence. Two equal paths to the SAME four outcomes (resolveApprovalKey):
    //    move the ▸ cursor with ↑/↓ and confirm with Enter/Space, OR press the y/a/b/n hotkey to jump-and-confirm.
    if (approvalResolver.current) {
      const r = resolveApprovalKey(ch, key, approvalSelRef.current);
      if (r.t === "abort")
        abortRun(); // abort the whole run, not merely deny (global cancel contract)
      else if (r.t === "move") setApprovalSel(r.sel);
      else if (r.t === "confirm") finishApproval(r.decision);
      return;
    }

    // 1.5) An open questionnaire (ask_user) owns the keyboard: ↑/↓ move the option cursor, Tab toggles a
    //      choice (multi-select), typing fills the note, Enter submits, Esc skips (agent proceeds on its own).
    //      Ctrl+C still aborts the whole run.
    if (questionRef.current) {
      const q = questionRef.current;
      const opts = q.req.options ?? [];
      if (key.ctrl && ch === "c") {
        abortRun();
        return;
      }
      if (key.escape) {
        finishQuestion({ selected: [], cancelled: true });
        return;
      }
      if (key.return) {
        submitQuestion();
        return;
      }
      if (opts.length > 0 && (key.upArrow || key.downArrow)) {
        const next = key.upArrow
          ? Math.max(0, q.cursor - 1)
          : Math.min(opts.length - 1, q.cursor + 1);
        setQuestionState({ ...q, cursor: next });
        return;
      }
      if (opts.length > 0 && q.req.multiSelect === true && key.tab) {
        const selected = new Set(q.selected);
        if (selected.has(q.cursor)) selected.delete(q.cursor);
        else selected.add(q.cursor);
        setQuestionState({ ...q, selected });
        return;
      }
      if (q.req.allowText !== false) {
        if (key.backspace || key.delete) {
          setQuestionState({ ...q, text: q.text.slice(0, -1) });
          return;
        }
        // A single printable character → append to the note (control keys / arrows / tab have ch="" or <0x20).
        if (ch.length === 1 && ch >= " " && !key.ctrl && !key.meta) {
          setQuestionState({ ...q, text: q.text + ch });
          return;
        }
      }
      return; // swallow everything else while the question is open
    }

    // 2) Ctrl+C always cancels a run in flight, else quits.
    if (key.ctrl && ch === "c") {
      if (busyRef.current) abortRun();
      else exit();
      return;
    }

    // Ctrl+T toggles the live model-reasoning view anytime (view-only; safe mid-run).
    if (key.ctrl && ch === "t") {
      dispatch({ t: "toggleThinking" });
      return;
    }

    // Ctrl+V pastes an image from the clipboard (macOS) — attach it to the next message.
    if (key.ctrl && ch === "v") {
      void captureImage();
      return;
    }

    // 3) The model picker owns ↑/↓/Enter/Esc while open.
    if (pickerRef.current === "model") {
      const list = readyFleet;
      if (key.escape) {
        setPicker(null);
        return;
      }
      if (key.upArrow) {
        setPickerSel(Math.max(0, pickerSelRef.current - 1));
        return;
      }
      if (key.downArrow) {
        setPickerSel(Math.min(Math.max(0, list.length - 1), pickerSelRef.current + 1));
        return;
      }
      if (key.return) {
        const row = list[pickerSelRef.current];
        if (row) {
          modelRef.current = row.id;
          dispatch({ t: "model", model: row.id });
          dispatch({ t: "notice", level: "info", text: `model → ${row.id}` });
        }
        setPicker(null);
        return;
      }
      return; // swallow other keys while picking
    }

    // 3b) The effort picker owns ↑/↓/Enter/Esc while open.
    if (pickerRef.current === "effort") {
      if (key.escape) {
        setPicker(null);
        return;
      }
      if (key.upArrow) {
        setPickerSel(Math.max(0, pickerSelRef.current - 1));
        return;
      }
      if (key.downArrow) {
        setPickerSel(Math.min(EFFORTS.length - 1, pickerSelRef.current + 1));
        return;
      }
      if (key.return) {
        const e = EFFORTS[pickerSelRef.current];
        if (e) {
          effortRef.current = e;
          dispatch({ t: "effort", effort: e });
          dispatch({ t: "notice", level: "info", text: `effort → ${e}` });
        }
        setPicker(null);
        return;
      }
      return; // swallow other keys while picking
    }

    // 3c) The skills browser owns typing (filter) / ↑↓ / Tab (pin) / Enter (use) / Esc while open.
    if (pickerRef.current === "skills") {
      const list = filteredSkillsRef.current;
      if (key.escape) {
        setPicker(null);
        setSkillFilter("");
        return;
      }
      if (key.upArrow) {
        setPickerSel(Math.max(0, pickerSelRef.current - 1));
        return;
      }
      if (key.downArrow) {
        setPickerSel(Math.min(Math.max(0, list.length - 1), pickerSelRef.current + 1));
        return;
      }
      if (key.tab) {
        const row = list[pickerSelRef.current];
        if (row && deps.onTogglePin) {
          const nowPinned = deps.onTogglePin(row.name);
          setPinnedSet((prev) => {
            const next = new Set(prev);
            if (nowPinned) next.add(row.name);
            else next.delete(row.name);
            return next;
          });
        }
        return;
      }
      if (key.return) {
        const row = list[pickerSelRef.current];
        setPicker(null);
        setSkillFilter("");
        if (row) setBuffer(`use the ${row.name} skill to `); // hand it to the composer to finish + run
        return;
      }
      if (key.backspace || key.delete) {
        setSkillFilter(skillFilterRef.current.slice(0, -1));
        setPickerSel(0);
        return;
      }
      if (ch && !key.ctrl && !key.meta) {
        setSkillFilter(skillFilterRef.current + ch);
        setPickerSel(0);
        return;
      }
      return; // swallow other keys while browsing
    }

    // 4) Slash-command palette.
    const slashMatches = matchSlash(inputRef.current, customCommands.palette);
    if (inputRef.current.startsWith("/") && slashMatches.length > 0) {
      if (key.escape) {
        // Esc closes the palette; if a run is in flight, it ALSO cancels it (the hint promises esc cancels).
        setBuffer("");
        if (busyRef.current) abortRun();
        return;
      }
      if (key.upArrow) {
        setSlashSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSel((s) => Math.min(slashMatches.length - 1, s + 1));
        return;
      }
      if (key.return || (key.tab && !key.shift)) {
        const idx = Math.min(slashSel, slashMatches.length - 1);
        const command = slashMatches[idx] as SlashCommand;
        const arg = inputRef.current.replace(/^\/\S*\s*/, "").trim();
        runSlash(command, arg);
        return;
      }
    }

    // 5) Esc cancels a run.
    if (key.escape) {
      if (busyRef.current) abortRun();
      return;
    }

    // 6) Tab toggles PLAN ↔ BUILD; Shift+Tab cycles the PERMISSION — not mid-run (the run captured both).
    if (key.tab && !key.shift) {
      if (busyRef.current) return;
      const m = toggleAgentMode(agentModeRef.current);
      agentModeRef.current = m;
      dispatch({ t: "agentMode", agentMode: m });
      return;
    }
    if (key.tab && key.shift) {
      if (busyRef.current) return;
      const p = nextPermission(permissionRef.current);
      permissionRef.current = p;
      dispatch({ t: "permission", permission: p });
      return;
    }

    // 7) Enter runs (idle) or QUEUES (in flight).
    if (key.return) {
      const task = inputRef.current.trim();
      // A slash-prefixed input that matched no command is a typo (e.g. `/modle`) — report it, don't
      // silently run it as a (paid) agent task.
      if (task.startsWith("/")) {
        dispatch({ t: "notice", level: "warn", text: `unknown command: ${task.split(/\s/)[0]}` });
        setBuffer("");
        return;
      }
      // In BUILD mode with a saved plan, Enter on an empty line executes the plan.
      const canRunPlan =
        !task &&
        agentModeRef.current === "build" &&
        planRef.current.some((t) => t.status !== "done");
      const hasAttach = attachmentsRef.current.length > 0;
      // Allow an image-only send (attachment + no text) — a common "look at this" flow.
      if (!task && !canRunPlan && !hasAttach) return;
      const attach = attachmentsRef.current;
      if (busyRef.current) {
        if (cancellingRef.current) return;
        if (!task && !hasAttach) return;
        queueRef.current = [...queueRef.current, { text: task, attachments: attach }];
        setQueued(queueRef.current.map((q) => q.text));
        setAttachments([]);
        setBuffer("");
      } else {
        setBuffer("");
        setAttachments([]);
        void runTask(task, attach);
      }
      return;
    }
    if (key.backspace || key.delete) {
      // On an empty composer, Backspace removes the most recent image chip (nothing to delete otherwise).
      if (inputRef.current.length === 0 && attachmentsRef.current.length > 0) {
        setAttachments(attachmentsRef.current.slice(0, -1));
        return;
      }
      setBuffer(inputRef.current.slice(0, -1));
      return;
    }
    // A MULTI-char burst that is a single image PATH (drag-drop / paste) attaches the file instead of typing it.
    // If the read FAILS, fall back to inserting the burst as text so a paste is NEVER silently lost.
    if (ch && ch.length > 1 && !key.ctrl && !key.meta && looksLikeImagePath(ch)) {
      const burst = ch;
      void attachImageFile(burst, "drag").then((res) => {
        if (res.ok) addAttachment(res.attachment);
        else {
          dispatch({ t: "notice", level: "info", text: res.reason });
          setBuffer(inputRef.current + burst); // don't drop the pasted text on a failed attach
        }
      });
      return;
    }
    if (ch && !key.ctrl && !key.meta) setBuffer(inputRef.current + ch);
  });

  function finishApproval(decision: ApprovalDecision): void {
    const resolve = approvalResolver.current;
    approvalResolver.current = null;
    setPending(null);
    if (decision === "bypass") {
      // Flip the whole session to bypass (same as /bypass): future runs skip prompts, and `approve` short-
      // circuits the current run's remaining asks. The current request itself is let through as allow-once.
      permissionRef.current = "bypass";
      dispatch({ t: "permission", permission: "bypass" });
      dispatch({ t: "notice", level: "info", text: "Bypassing approvals for this session" });
      resolve?.("allow-once");
      return;
    }
    resolve?.(decision);
  }

  // A picker/overlay (model · effort · skills) replaces the splash banner so an overlay opened on a fresh
  // screen gets the full window height — otherwise the banner eats ~9 rows and the overlay overflows.
  const onSplash = state.transcript.length === 0 && picker === null;
  const slashMatches = matchSlash(input, customCommands.palette);
  const showSlash = input.startsWith("/") && slashMatches.length > 0 && !pending && picker === null;
  const elapsed = runActive && runStartRef.current ? (Date.now() - runStartRef.current) / 1000 : 0;
  // Per-PHASE clock (P1.10): reset whenever the current activity verb changes, so "Thinking · 0:12" means
  // thinking FOR 0:12, not 0:12 into the whole run (the user wanted both readouts).
  const phaseElapsed =
    runActive && phaseStartRef.current ? (Date.now() - phaseStartRef.current) / 1000 : 0;
  const readyCount = fleet ? fleet.filter((r) => r.avail === "ready").length : undefined;

  return (
    <Box flexDirection="column" width={width} height={rows} paddingX={1}>
      {/* SPLASH: banner at top, a spacer pushes the input to the bottom (fills the window).
          RUNNING: the transcript fills the space above the composer and is BOTTOM-anchored (justifyContent
          flex-end) — the newest line sits just above the input like a normal terminal chat, empty space is
          at the TOP (room for scrollback), and the composer + flightline stay pinned to the bottom. */}
      {onSplash ? (
        <>
          <Banner
            width={width}
            fleet={readyCount !== undefined ? { ready: readyCount } : undefined}
          />
          <Box flexGrow={1} />
        </>
      ) : (
        <Box
          flexDirection="column"
          // ALWAYS grow so the composer + flightline (and any open picker) stay pinned to the BOTTOM with the
          // empty space at the top — never jam to the top with a void below. When a picker is open the transcript
          // YIELDS its space (flexShrink 1 + overflow hidden) to the picker panel (which is flexShrink 0 below),
          // so the overlay keeps its full height and the whole stack sits at the bottom.
          flexGrow={1}
          flexShrink={1}
          justifyContent="flex-end"
          overflow="hidden"
        >
          {/* When the conversation is SPARSE and IDLE, a dim brand watermark fills the empty upper region so the
              screen reads as a deliberate home, not a blank void. Hidden during an ACTIVE run so it never
              competes with the spinning-globe activity line for the eye (user: "the globe is in a weird
              place") — the empty space above the bottom-anchored transcript is normal terminal chat. */}
          {state.transcript.length <= 3 && !picker && !runActive ? (
            <Box flexGrow={1} flexShrink={1} alignItems="center" justifyContent="center">
              <Watermark />
            </Box>
          ) : null}
          <Transcript items={state.transcript} window={Math.max(4, rows - 9)} width={width} />
        </Box>
      )}

      {/* Optional middle panels — allowed to SHRINK + clip during a run so they can never push the composer/
          status below the viewport on a short terminal (those are pinned with flexShrink={0} below). BUT when a
          picker/overlay is open it must keep its FULL height (flexShrink 0) — the transcript above yields instead,
          so the overlay isn't clipped and the composer stays pinned to the bottom. */}
      <Box flexDirection="column" flexShrink={picker ? 0 : 1} overflow="hidden">
        <Goal goal={state.goal} plan={state.plan} running={state.status.running} />
        <Plan tasks={state.plan} max={Math.max(3, rows - 12)} />
        <Thinking text={state.thinking} show={state.showThinking} width={width} />
        <ActivityLine
          activity={state.status.activity}
          elapsed={elapsed}
          phaseElapsed={phaseElapsed}
          frame={tick}
          width={width}
        />
        {queued.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {queued.slice(0, 3).map((q, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: queue order is stable within a render
              <Text key={i} color={AmbientTheme.dim}>{`  ⤴ ${q}`}</Text>
            ))}
            {queued.length > 3 ? (
              <Text color={AmbientTheme.dim}>{`  ⤴ … ${queued.length - 3} more queued`}</Text>
            ) : null}
          </Box>
        ) : null}
        {picker === "model" ? (
          <Box marginTop={1}>
            <ModelPicker
              rows={readyFleet}
              selected={pickerSel}
              current={state.status.requestedModel}
              width={width}
            />
          </Box>
        ) : null}
        {picker === "effort" ? (
          <Box marginTop={1}>
            <EffortPicker
              efforts={EFFORTS}
              selected={pickerSel}
              current={state.status.effort}
              width={width}
            />
          </Box>
        ) : null}
        {picker === "skills" ? (
          <Box marginTop={1}>
            <SkillsBrowser
              rows={filteredSkills}
              selected={Math.min(pickerSel, Math.max(0, filteredSkills.length - 1))}
              filter={skillFilter}
              total={deps.skills?.length ?? 0}
              width={width}
              maxRows={Math.max(3, rows - 11)}
            />
          </Box>
        ) : null}
        {showSlash ? (
          <Box marginTop={1}>
            <SlashPalette
              commands={slashMatches}
              selected={Math.min(slashSel, slashMatches.length - 1)}
              width={width}
            />
          </Box>
        ) : null}
      </Box>
      <Box marginTop={1} flexShrink={0}>
        {question ? (
          // A pending questionnaire replaces the composer (like the Approval modal) — it owns the keyboard.
          <Question state={question} width={width} />
        ) : pending ? (
          // Cap the preview so the header + all four choices + borders + status stay on-screen on a short
          // terminal (the choices must never scroll off). 21 rows are the modal's fixed furniture
          // in the WORST case (risk callout + overflow marker + StatusLine); the preview yields to 0 first, so
          // at rows=24 → 3 preview lines and 21+3 = 24 exactly.
          <Approval
            req={pending}
            width={width}
            selected={approvalSel}
            maxPreview={Math.max(0, Math.min(14, rows - 21))}
          />
        ) : (
          <Composer
            value={input}
            running={runActive}
            width={width}
            attachments={attachments}
            planReady={
              !runActive &&
              state.status.agentMode === "build" &&
              state.plan.some((t) => t.status !== "done")
            }
          />
        )}
      </Box>
      <Box flexShrink={0}>
        <StatusLine
          status={state.status}
          width={width}
          active={runActive}
          showThinking={state.showThinking}
        />
      </Box>
    </Box>
  );
}
