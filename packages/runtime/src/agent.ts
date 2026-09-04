import {
  budgetFromCatalog,
  compactionConfigForWindow,
  estimateMessagesTokens,
  estimateTokens,
  fitImages,
  fitInjectedBlocks,
  planImages,
  preflight,
  renderSkillIndex,
  shouldCompact,
  toolResultCharBudget,
} from "@amb/context";
import { MAX_CONSECUTIVE_AUTO_APPROVALS, guardUntrustedResult } from "@amb/permissions";
import {
  AmbError,
  type CatalogModel,
  type Grant,
  type Lane,
  type StopReason,
  newAttemptId,
  newToolCallId,
  newTurnId,
  supportsVision,
  toAttachmentRef,
} from "@amb/protocol";
import {
  AUTO_MODEL,
  type RoutedRole,
  autonomyCap,
  backoffSeconds,
  nextMaxTokens,
  parseOverflowMax,
  pickForRole,
  resolveRequestedModel,
  shouldEscalate,
} from "@amb/reliability";
import { type ToolRegistry, createBuiltinRegistry, toOpenAITools } from "@amb/tools-core";
import {
  capToolResult,
  catalogHash,
  fallbackModel,
  isAbortError,
  isMutationOutcome,
  renderPlanAnchor,
  stringifyResult,
  withGoalReminder,
} from "./agent-support.js";
import { assistedProtocol, parseAssistedResponse, stripActionBlock } from "./assisted.js";
import { type ContentPart, buildUserContent, toDataUri } from "./attachments.js";
import { compact, reduceContext } from "./compaction-runner.js";
import {
  DESIRED_OUTPUT,
  INJECTED_CONTEXT_FRACTION,
  MAX_COMPACTIONS,
  MAX_IDENTICAL_TOOL_BATCHES,
  MAX_VERIFY_ATTEMPTS,
  REPO_MAP_FRACTION,
  REPO_MAP_MAX_TOKENS,
  REPO_MAP_MIN_TOKENS,
  SKILLS_FRACTION,
  SKILLS_MAX_TOKENS,
  SKILLS_MIN_TOKENS,
} from "./constants.js";
import { autoEffortForTask, resolveEffort } from "./effort.js";
import { executeTools } from "./execute-tools.js";
import { runChatWithFailover } from "./failover.js";
import type {
  CapabilityPort,
  ChatClient,
  ChatParams,
  Msg,
  RunOptions,
  TurnCompletion,
} from "./ports.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { injectDescription, relayImageToText } from "./vision-relay.js";

export interface AgentResult {
  stopReason: StopReason;
  turns: number;
  finalText: string;
}

export interface AgentOptions {
  /** Injectable delay (seconds) for rate-limit backoff — tests pass a no-op. */
  sleep?: (seconds: number) => Promise<void>;
}

/**
 * The agent state machine (single-agent, native tool-call lane — Phase 1). Hardened per the Phase-1
 * audit: per-run session id, overflow→compaction, escalate-on-empty, budget-aware mid-run failover
 * that avoids already-failed models and backs off on rate limits, and truthful stop reasons.
 */
export class Agent {
  private readonly registry: ToolRegistry;
  private readonly sleep: (seconds: number) => Promise<void>;

  constructor(
    private readonly client: ChatClient,
    registry?: ToolRegistry,
    opts: AgentOptions = {},
  ) {
    this.registry = registry ?? createBuiltinRegistry();
    this.sleep = opts.sleep ?? ((s) => new Promise((r) => setTimeout(r, s * 1000)));
  }

  async run(userInput: string, opts: RunOptions): Promise<AgentResult> {
    const sessionId = opts.sessionId;
    const emit = opts.emit;
    // Use the caller's grants array when provided (the TUI passes ONE per session) so an "allow for this
    // session" grant persists across turns; else a fresh per-run array (line/one-shot runs).
    const grants: Grant[] = opts.grants ?? [];
    // Run-scoped autonomy brake: consecutive auto-approved mutations, reset whenever a human is asked. `cap`
    // is the EARNED per-model cap (set from the served model's verify track record before each tool batch).
    const autoApproval: { streak: number; cap?: number } = { streak: 0 };
    // Verify-gate state: did the model change files since the last verification, how many times has the gate
    // re-asked it to fix a failing verification (bounded), and did we already record this run's first outcome?
    let mutatedSinceVerify = false;
    let verifyAttempts = 0;
    let verifyRecorded = false;
    let verifyPassed: boolean | undefined; // undefined = never verified; drives an honest stop reason
    let mutatingModel = ""; // the model that produced the changes being verified (survives a later failover)

    // The very first durable record of the session: cwd + workspace root.
    emit({
      schemaVersion: 1,
      kind: "session.started",
      sessionId,
      cwd: opts.cwd,
      workspaceRoot: opts.workspaceRoot,
      model: opts.requestedModel,
    });

    let liveCatalog: CatalogModel[];
    try {
      liveCatalog = await this.client.fetchCatalog(opts.signal);
    } catch (err) {
      // A cancelled catalog fetch is a cancellation, not an error.
      if (opts.signal.aborted || isAbortError(err)) {
        emit({
          schemaVersion: 1,
          kind: "session.paused",
          sessionId,
          reason: "cancelled during catalog fetch",
        });
        return { stopReason: "cancelled", turns: 0, finalText: "" };
      }
      throw err;
    }
    emit({
      schemaVersion: 1,
      kind: "catalog.snapshot",
      sessionId,
      hash: catalogHash(liveCatalog),
      modelCount: liveCatalog.length,
    });

    // An empty fleet is fatal for a run — fail cleanly with a clear message rather than proceeding and
    // sending the `auto` sentinel (or a cold requested id) to the wire as if it were a real model.
    if (liveCatalog.length === 0) {
      emit({
        schemaVersion: 1,
        kind: "error",
        sessionId,
        errorKind: "transport",
        message: "no models are available in the Ambient fleet right now",
        retryable: false, // TERMINAL — the run ends here, so the UI must not say "retrying / failing over…"
      });
      return { stopReason: "error", turns: 0, finalText: "" };
    }

    const turnId = newTurnId();
    emit({
      schemaVersion: 1,
      kind: "turn.started",
      sessionId,
      turnId,
      input: userInput,
      // References only (mime/bytes/sha256/source) — the base64 bytes never enter the durable log.
      ...(opts.attachments && opts.attachments.length > 0
        ? { attachments: opts.attachments.map(toAttachmentRef) }
        : {}),
    });

    let target = this.resolveModel(
      opts.requestedModel,
      liveCatalog,
      sessionId,
      turnId,
      emit,
      opts.capabilities,
      opts.routedRole,
    );
    const tools = toOpenAITools(this.registry.list());
    const toolTokens = estimateTokens(JSON.stringify(tools));

    // Warm-continue resume: prior-session context is injected into the SYSTEM prompt, so the message
    // anchor stays (system + the new instruction) and compaction can never summarize the goal away.
    // Workspace fs/env come through the injected (required) port — the runtime state machine itself never
    // touches fs/clock/env, so it stays deterministic + replayable.
    const baseInstructions = opts.workspace.instructions(opts.cwd);
    // Read-only git snapshot at run start (branch / changed files / recent commits) — computed once and folded
    // into the anchor so the agent starts oriented without spending a tool call. Undefined outside a repo.
    const gitBlock = opts.workspace.git?.(opts.cwd);
    // Durable project memory (.ambient/MEMORY.md) — compounds across sessions; injected into the SYSTEM
    // prompt so it survives compaction, and re-verified with tools rather than trusted blindly.
    const memory = opts.workspace.readMemory(opts.workspaceRoot);
    const memoryBlock = memory
      ? `## Project memory (.ambient/MEMORY.md — durable notes from prior sessions; re-verify with tools, don't trust blindly)\n${memory}`
      : "";
    const resumeBlock = opts.resumeContext
      ? `## Prior session (resumed — context only; the CURRENT task is the user message below)\n${opts.resumeContext}`
      : "";
    // Fleet-aware repo map (Karpathy/aider): a ranked, signatures-only map budgeted to a small share of the
    // ACTIVE model's window — a small model gets a small map, a flagship a fuller one. Injected into the
    // SYSTEM prompt so "where is X" is answered without reading files, and it survives compaction.
    const modelWindow = budgetFromCatalog(
      liveCatalog.find((m) => m.id === target) ?? fallbackModel(target),
      opts.capabilities?.learnedCeiling?.(target),
    ).contextWindow;
    const repoMapBudget = Math.min(
      REPO_MAP_MAX_TOKENS,
      Math.floor(modelWindow * REPO_MAP_FRACTION),
    );
    const repoMapBlock =
      repoMapBudget >= REPO_MAP_MIN_TOKENS
        ? (opts.workspace.repoMap?.(opts.workspaceRoot, repoMapBudget) ?? "")
        : "";
    // Progressive disclosure: only the skills CATALOG (name + description) loads here; the `skill` tool pulls a
    // full body in on demand. BUDGETED to a small share of the SERVED window (same pattern as the repo map) so
    // it scales with the model — a 33k mini model gets a handful, a 262k flagship the full set — and never
    // clobbers a small window; the rest stay evocable by name. Below the floor, the catalog is skipped.
    const skillsBudget = Math.min(SKILLS_MAX_TOKENS, Math.floor(modelWindow * SKILLS_FRACTION));
    const skillsBlock =
      skillsBudget >= SKILLS_MIN_TOKENS
        ? renderSkillIndex(opts.workspace.skills(opts.workspaceRoot), skillsBudget)
        : "";
    // Budget ALL injected system context to a share of the served window, trimming in PRIORITY order so a
    // small-window model isn't blocked before turn 1: user instructions > durable memory > repo map >
    // skills catalog > prior-session transcript (largest + most reconstructable, so trimmed first). Subtract
    // the tool cost so the anchor leaves headroom for the tools/assisted schemas that ride alongside it.
    // Rebuildable so a downward failover / learned-lower ceiling can RE-FIT it to the smaller served window
    // — the blocks are captured, so a rebuild is a cheap re-fit (no fs re-read).
    const injectedBlocks = [baseInstructions, memoryBlock, repoMapBlock, skillsBlock, resumeBlock];
    const buildBaseAnchor = (window: number): string => {
      const budget = Math.max(0, Math.floor(window * INJECTED_CONTEXT_FRACTION) - toolTokens);
      const combined = fitInjectedBlocks(injectedBlocks, budget).filter(Boolean).join("\n\n");
      return buildSystemPrompt({
        cwd: opts.cwd,
        model: target,
        date: opts.workspace.date(),
        platform: opts.workspace.platform(),
        ...(opts.goal ? { goal: opts.goal } : {}),
        ...(gitBlock ? { git: gitBlock } : {}),
        ...(combined ? { instructions: combined } : {}),
      });
    };
    let anchorWindow = modelWindow; // the window the current baseSystem was fitted to
    // The system-prompt anchor (never compacted). The live plan is re-folded onto THIS each turn so the model
    // always sees its checklist even after compaction, without the plan block ever compounding.
    let baseSystem = buildBaseAnchor(modelWindow);
    let currentPlanBlock = "";

    // ── Image attachments ─────────────────────────────────────────────────────────────────────────────
    // A VISION-capable served model sees the images directly (image_url content-parts, adaptively fit to its
    // window). A BLIND model gets a text description of the image via the vision relay (a ready vision model
    // from the same catalog), injected into the user text — so any model gets a vision workaround.
    const servedModel = liveCatalog.find((m) => m.id === target) ?? fallbackModel(target);
    // `auto` effort is TASK-ADAPTIVE: a greeting like "sup" must not trigger medium reasoning (which made a
    // reasoning model think for ~20s); computed once from the task + mode, then applied per attempt.
    const autoLevel = autoEffortForTask(userInput, opts.mode);
    let firstUserContent: string | ContentPart[] = userInput;
    // The ACCURATE per-image token cost for THIS run's plan (from fitImages) — threaded into every prompt
    // estimate so preflight/overflow sizes images correctly per window, not just the flat default. Undefined
    // on the relay/no-image path (the wire has no image parts, so the resolver is never consulted).
    let imageTokensFn: ((part: unknown) => number) | undefined;
    const estimateOpts = (): { imageTokens?: (part: unknown) => number } =>
      imageTokensFn ? { imageTokens: imageTokensFn } : {};
    const attachments = opts.attachments ?? [];
    if (attachments.length > 0) {
      const relayViaText = async (reason: "blind" | "no-fit"): Promise<void> => {
        const relay = await relayImageToText({
          client: this.client,
          catalog: liveCatalog,
          imageDataUris: attachments.map(toDataUri),
          userText: userInput,
          signal: opts.signal,
        });
        firstUserContent = injectDescription(userInput, relay);
        emit({
          schemaVersion: 1,
          kind: "vision.relay",
          sessionId,
          turnId,
          targetModel: target,
          imageCount: attachments.length,
          outcome: relay.outcome,
          ...(relay.visionModel ? { visionModel: relay.visionModel } : {}),
        });
        void reason;
      };
      if (supportsVision(servedModel)) {
        const plan = planImages(modelWindow);
        const fit = fitImages(attachments, modelWindow, estimateTokens(userInput), plan);
        if (fit.kept.length > 0) {
          firstUserContent = buildUserContent(userInput, fit.kept, true);
          imageTokensFn = () => fit.perImageTokens; // accurate per-image cost for this window's plan
          emit({
            schemaVersion: 1,
            kind: "vision.relay",
            sessionId,
            turnId,
            targetModel: target,
            imageCount: fit.kept.length,
            outcome: "native",
          });
        } else {
          await relayViaText("no-fit"); // even one image can't fit this window → describe instead
        }
      } else {
        await relayViaText("blind");
      }
    }
    let messages: Msg[] = [
      { role: "system", content: baseSystem },
      { role: "user", content: firstUserContent },
    ];
    // Track the project memory across compactions so each summary COMPOUNDS the last, and write it.
    let projectMemory = memory ?? "";
    const persistMemory = (s: string) => {
      projectMemory = s;
      opts.workspace.writeMemory(opts.workspaceRoot, s);
    };

    // Artifact offload + spill are only SAFE when the model can actually get the bytes back:
    // both a writer AND a reader must be wired, and the `read_artifact` tool must be in this run's registry.
    // Otherwise a truncation note / spill breadcrumb would point at a dead reader — so when the
    // reader is unreachable we degrade to plain truncation (no dangling handle) and never spill.
    const artifactPort =
      opts.artifact &&
      opts.readArtifact &&
      this.registry.list().some((t) => t.manifest.name === "read_artifact")
        ? opts.artifact
        : undefined;

    let finalText = "";
    let stopReason: StopReason = "complete";
    let turns = 0;
    // Doom-loop guard (user: "doesn't go in circles"): if the model issues the EXACT same tool-call batch
    // several times running with no progress, stop early with `looping` instead of burning to max_turns.
    let lastBatchSig = "";
    let batchRepeat = 0;

    while (turns < opts.maxTurns) {
      if (opts.signal.aborted) {
        emit({ schemaVersion: 1, kind: "operation.cancelled", sessionId, turnId, scope: "turn" });
        emit({
          schemaVersion: 1,
          kind: "turn.finished",
          sessionId,
          turnId,
          stopReason: "cancelled",
        });
        return { stopReason: "cancelled", turns, finalText };
      }
      turns += 1;
      let compactions = 0;

      // ── context management: compact if we're near the window. Counts toward MAX_COMPACTIONS. ──
      let model = liveCatalog.find((m) => m.id === target);
      let budget = budgetFromCatalog(
        model ?? fallbackModel(target),
        opts.capabilities?.learnedCeiling?.(target),
      );
      // Re-fit the never-compacted anchor to the SERVED window if it shrank (a downward failover or a learned
      // lower ceiling) — else an anchor sized for a big model can overflow a small one that compaction can't
      // rescue, and the run dead-ends in "blocked". Cheap: a re-fit of already-read blocks.
      if (budget.contextWindow < anchorWindow) {
        anchorWindow = budget.contextWindow;
        baseSystem = buildBaseAnchor(budget.contextWindow);
        messages[0] = {
          role: "system",
          content: currentPlanBlock ? `${baseSystem}\n\n${currentPlanBlock}` : baseSystem,
        };
      }
      if (
        shouldCompact(
          messages,
          budget.contextWindow,
          compactionConfigForWindow(budget.contextWindow),
          opts.capabilities?.bytesPerToken?.(target), // learned tokenizer accuracy
        )
      ) {
        const compacted = await compact(
          this.client,
          messages,
          target,
          liveCatalog,
          sessionId,
          turnId,
          emit,
          opts.signal,
          persistMemory,
          budget.contextWindow,
          projectMemory,
        );
        if (compacted) {
          messages = compacted;
          compactions += 1;
        }
      }

      // ── inference with budget-aware failover + escalate-on-empty ──
      let completion: TurnCompletion;
      let escalation = 0;
      let lastAttemptId: string = newAttemptId();
      // The lane the ACTUAL request was built with — response parsing must match this, NOT a lane
      // recomputed from a failed-over model, or transport and parsing desync.
      let turnAssisted = false;
      const failed = new Set<string>();
      for (;;) {
        model = liveCatalog.find((m) => m.id === target);
        budget = budgetFromCatalog(
          model ?? fallbackModel(target),
          opts.capabilities?.learnedCeiling?.(target),
        );
        const promptEstimate = estimateMessagesTokens(messages, estimateOpts()) + toolTokens;
        const pf = preflight(budget, {
          promptEstimate,
          requestedOutput: DESIRED_OUTPUT,
          reasoning: true,
        });
        emit({
          schemaVersion: 1,
          kind: "context.preflight",
          sessionId,
          turnId,
          model: target,
          contextWindow: budget.contextWindow,
          promptEstimate,
          reserve: pf.reserve,
          requestedOutput: pf.requestedOutput,
          sentOutput: pf.sentOutput,
          remainingShared: pf.remainingShared,
        });
        if (pf.overflow) {
          // Reclaim context and retry — model-summary compaction first, then a lossy artifact spill so a
          // small-window model keeps moving instead of dead-ending. Bounded + progress-required so we can
          // never spin forever. If nothing more can be reclaimed, the turn is honestly blocked.
          const reduced = await reduceContext(
            this.client,
            messages,
            target,
            liveCatalog,
            sessionId,
            turnId,
            emit,
            opts.signal,
            persistMemory,
            budget.contextWindow,
            projectMemory,
            compactions,
            artifactPort,
          );
          if (!reduced) {
            emit({ schemaVersion: 1, kind: "context.overflow", sessionId, turnId, model: target });
            emit({
              schemaVersion: 1,
              kind: "turn.finished",
              sessionId,
              turnId,
              stopReason: "blocked",
            });
            return { stopReason: "blocked", turns, finalText };
          }
          messages = reduced;
          compactions += 1;
          continue;
        }

        const attemptId = newAttemptId();
        lastAttemptId = attemptId;

        // Lane decides the transport: `direct` sends native `tools`; `assisted` sends NO tools and
        // instead describes them as text in the system prompt (the model replies with a fenced action).
        const assisted = this.laneOf(target, liveCatalog, opts.capabilities) === "assisted";
        turnAssisted = assisted; // remember how THIS request was built, for consistent parsing
        // Primacy (system anchor) + recency (this trailing reminder) = the goal "sandwich" so even a weak
        // model keeps the north-star in view right before it generates. Transient; never persisted.
        const reqMessages = withGoalReminder(
          assisted ? this.withAssistedProtocol(messages) : messages,
          opts.goal,
        );
        const reqTools = assisted ? [] : tools;

        // runChatWithFailover owns the per-attempt budget (its own preflight + escalation per model) and
        // emits the inference.request/response + streamed deltas for every ACTUAL request, including failovers.
        let result: TurnCompletion;
        try {
          const out = await runChatWithFailover(
            {
              client: this.client,
              // Wrap (not a bare ref) so `this.sleep` is always invoked as an Agent method — a bare
              // `this.sleep` would rebind its dynamic `this` to the deps object.
              sleep: (seconds) => this.sleep(seconds),
              laneOf: (id, cat, caps) => this.laneOf(id, cat, caps),
            },
            {
              model: target,
              messages: reqMessages,
              tools: reqTools,
              maxTokens: DESIRED_OUTPUT,
              signal: opts.signal,
              onContent: () => {},
              onReasoning: () => {},
            },
            target,
            failed,
            liveCatalog,
            escalation,
            // Don't stream raw deltas in assisted mode — the reply contains an action envelope we strip;
            // the clean text is shown via assistant.final instead.
            {
              sessionId,
              turnId,
              attemptId,
              emit,
              signal: opts.signal,
              streamDeltas: !assisted,
              lane: assisted ? "assisted" : "direct",
              // When the wire carries image parts, failover must stay on a vision-capable model (never ship
              // an image to a blind substitute). Computed from what's ACTUALLY on the wire this attempt.
              hasImage: reqMessages.some(
                (m) =>
                  Array.isArray(m.content) &&
                  m.content.some(
                    (p) =>
                      p !== null &&
                      typeof p === "object" &&
                      (p as { type?: unknown }).type === "image_url",
                  ),
              ),
              ...(imageTokensFn ? { imageTokens: imageTokensFn } : {}),
              capabilities: opts.capabilities,
              effortFor: (m) => resolveEffort(opts.effort, m, opts.mode, autoLevel),
              onCatalog: (c) => {
                liveCatalog = c;
              },
              onSwitch: (m) => {
                target = m;
              },
            },
          );
          result = out.result;
          // Attribute the answer + any tool calls to the attempt that ACTUALLY produced them,
          // which may be a failed-over model, not the first attempt.
          lastAttemptId = out.attemptId;
        } catch (err) {
          if (err instanceof AmbError && err.kind === "cancelled") {
            emit({
              schemaVersion: 1,
              kind: "turn.finished",
              sessionId,
              turnId,
              stopReason: "cancelled",
            });
            return { stopReason: "cancelled", turns, finalText };
          }
          // Provider-reported context overflow → compact and retry, bounded.
          if (err instanceof AmbError && err.kind === "overflow") {
            // Learn the model's REAL ceiling from the provider's reported max — so future turns budget
            // against the true (lower-than-catalog) window and this overflow can't recur (catalog-adaptive).
            // The number lives in the provider BODY (err.detail); err.message is a fixed number-less string,
            // so parsing message alone never learned the ceiling (the whole ceiling machine got no input).
            const overflowBody = typeof err.detail === "string" ? err.detail : err.message;
            const observedMax = parseOverflowMax(overflowBody);
            if (observedMax !== undefined) opts.capabilities?.learnCeiling?.(target, observedMax);
            const reduced = await reduceContext(
              this.client,
              messages,
              target,
              liveCatalog,
              sessionId,
              turnId,
              emit,
              opts.signal,
              persistMemory,
              budget.contextWindow,
              projectMemory,
              compactions,
              artifactPort,
            );
            if (!reduced) {
              emit({
                schemaVersion: 1,
                kind: "context.overflow",
                sessionId,
                turnId,
                model: target,
              });
              emit({
                schemaVersion: 1,
                kind: "turn.finished",
                sessionId,
                turnId,
                stopReason: "blocked",
              });
              return { stopReason: "blocked", turns, finalText };
            }
            messages = reduced;
            compactions += 1;
            continue;
          }
          if (err instanceof AmbError) {
            emit({
              schemaVersion: 1,
              kind: "error",
              sessionId,
              message: err.message,
              errorKind: err.kind,
              ...(err.model ? { model: err.model } : {}),
            });
            emit({
              schemaVersion: 1,
              kind: "turn.finished",
              sessionId,
              turnId,
              stopReason: "error",
            });
            return { stopReason: "error", turns, finalText };
          }
          throw err;
        }

        // Whitespace-only content is not a real answer.
        const empty = result.content.trim().length === 0 && result.toolCalls.length === 0;
        const truncated = result.finishReason === "length";
        // escalate-on-empty: an empty-because-truncated response gets a bigger budget, once.
        if (shouldEscalate({ empty, truncated, escalations: escalation })) {
          escalation += 1;
          continue;
        }
        // Calibrate the SERVED model's bytes-per-token from real usage: request bytes / reported
        // promptTokens. A dense-tokenizing small model is then budgeted conservatively for the rest of the
        // session (bounded + best-effort), instead of everyone sharing one 3.5 constant.
        if (result.usage?.promptTokens && result.usage.promptTokens > 0) {
          const served = result.reportedModel ?? target;
          const reqBytes = Buffer.byteLength(JSON.stringify(reqMessages), "utf8");
          opts.capabilities?.learnBytesPerToken?.(served, reqBytes / result.usage.promptTokens);
        }
        completion = result;
        break;
      }

      // Extract the actionable tool calls per the lane the REQUEST was built with (turnAssisted) — this
      // must match the transport, even if chatOnce failed over to a different-lane model.
      const assistedTurn = turnAssisted;
      let toolCalls = completion.toolCalls;
      let displayText = completion.content;
      if (assistedTurn) {
        const parsed = parseAssistedResponse(completion.content);
        if (parsed.kind === "error") {
          // Malformed action envelope → feed the raw reply back with a repair instruction and re-ask
          // (bounded by maxTurns). This is the "controller" nudging a weak model onto the protocol.
          // Only the REASONING text (broken fence stripped) is user-facing — never surface the raw
          // protocol scaffolding as a finished answer (it would flicker "answer then keeps going").
          const clean = stripActionBlock(completion.content).trim();
          if (clean.length > 0)
            emit({
              schemaVersion: 1,
              kind: "assistant.final",
              sessionId,
              turnId,
              attemptId: lastAttemptId,
              text: clean,
            });
          messages.push({ role: "assistant", content: completion.content });
          messages.push({ role: "user", content: parsed.message });
          if (turns >= opts.maxTurns) {
            stopReason = "max_turns";
            break;
          }
          continue;
        }
        if (parsed.kind === "final") {
          toolCalls = [];
          displayText = parsed.text;
        } else {
          toolCalls = [
            { id: newToolCallId(), name: parsed.tool, args: parsed.args, rawArgs: parsed.rawArgs },
          ];
          displayText = stripActionBlock(completion.content);
        }
      }

      // TRUNCATION-SAFETY: a response cut at the output cap (finishReason "length") may carry
      // a tool call whose arguments are SILENTLY incomplete — executing it can corrupt the workspace. Reject
      // the whole batch and re-ask for a COMPLETE response (bounded by maxTurns) rather than run a half-formed
      // call. Weak open models hit output caps constantly, so this is the #1 silent-corruption mode for them.
      if (completion.finishReason === "length" && toolCalls.length > 0) {
        emit({
          schemaVersion: 1,
          kind: "error",
          sessionId,
          message:
            "response was cut off at the output limit before the tool call(s) finished — not executed; re-asking for a complete response",
          errorKind: "transport",
          model: target,
        });
        // Push the model's own (partial) text WITHOUT the tool calls (so there's no dangling native tool_call
        // awaiting a result), then a repair instruction, and re-ask on a fresh turn.
        messages.push({
          role: "assistant",
          content: completion.content.length > 0 ? completion.content : null,
        });
        messages.push({
          role: "user",
          content:
            "Your previous response was cut off at the output limit before the tool call(s) were complete, so I did NOT run them (the arguments may be truncated). Re-issue the tool call(s) with COMPLETE arguments — and if the work is large, split it into smaller steps so each response fits.",
        });
        if (turns >= opts.maxTurns) {
          stopReason = "max_turns";
          break;
        }
        continue;
      }

      if (displayText.trim().length > 0) {
        emit({
          schemaVersion: 1,
          kind: "assistant.final",
          sessionId,
          turnId,
          attemptId: lastAttemptId,
          text: displayText,
        });
        finalText = displayText;
      }

      // A genuinely empty (or whitespace-only) response with no tool calls is NOT success.
      if (displayText.trim().length === 0 && toolCalls.length === 0) {
        emit({ schemaVersion: 1, kind: "turn.finished", sessionId, turnId, stopReason: "blocked" });
        return { stopReason: "blocked", turns, finalText };
      }

      // no tool calls → natural stop. But if the run was aborted (e.g. a persistence write failed and the
      // sink aborted us), we must NOT report success.
      if (toolCalls.length === 0) {
        if (opts.signal.aborted) {
          stopReason = "cancelled";
          break;
        }
        // VERIFY GATE (Karpathy gen→verify): the model says it's done and it changed files — run
        // the project's verification. On failure, feed the diagnostics back and re-ask (bounded). This is
        // what turns "looks done" into "verified done"; skipped entirely when no verify is configured.
        if (opts.verify && mutatedSinceVerify && verifyAttempts < MAX_VERIFY_ATTEMPTS) {
          // A verifier that THROWS is a failure, not "unconfigured" (null) — never fail open (audit #10).
          const outcome = await opts
            .verify(opts.signal)
            .catch((e: unknown) => ({ ok: false, summary: `verification errored: ${String(e)}` }));
          if (outcome) {
            mutatedSinceVerify = false; // consume this verification; a re-fix sets it true again
            verifyPassed = outcome.ok;
            // Earned-autonomy signal: record only the FIRST verification of the run, attributed to the model
            // that actually produced the changes (not a later failover responder — audit #12).
            if (!verifyRecorded) {
              opts.capabilities?.recordVerify?.(mutatingModel || target, outcome.ok);
              verifyRecorded = true;
            }
            emit({
              schemaVersion: 1,
              kind: "verify.gate",
              sessionId,
              turnId,
              ok: outcome.ok,
              attempt: verifyAttempts,
              ...(outcome.ok ? {} : { summary: capToolResult(outcome.summary) }),
            });
            if (!outcome.ok) {
              verifyAttempts += 1;
              // A verify-driven re-fix is legitimate progress-seeking (new failure info), NOT a doom loop —
              // reset the loop tracker so the guard doesn't cut the bounded verify retries short.
              lastBatchSig = "";
              batchRepeat = 0;
              messages.push({
                role: "user",
                content: `Automated verification failed (attempt ${verifyAttempts}/${MAX_VERIFY_ATTEMPTS}):\n\n${capToolResult(outcome.summary)}\n\nFix the problem(s) above, then finish.`,
              });
              continue; // re-enter the loop with the failure fed back, instead of reporting success
            }
          }
        }
        // Honest stop: if the LAST verification failed and we're no longer re-asking (attempts exhausted, or
        // the model gave up without fixing), the run did NOT verify — never report a clean `complete`.
        stopReason = verifyPassed === false ? "verify_failed" : "complete";
        break;
      }

      // Learn ONLY in the direct lane: did the served model emit well-formed NATIVE tool calls? (Assisted
      // tool calls are synthesized from text, so they say nothing about native tool-calling.)
      if (opts.capabilities && !assistedTurn) {
        const allParsed = completion.toolCalls.every((tc) => tc.args !== undefined);
        opts.capabilities.learn(target, allParsed);
      }

      // record the assistant tool-call turn + execute + append results. The two lanes record differently:
      // direct uses native assistant.tool_calls + role:tool results; assisted uses plain text messages.
      const attemptGroup = `att_grp_${turns}`;
      if (assistedTurn) {
        messages.push({
          role: "assistant",
          content: completion.content,
          toolGroupId: attemptGroup,
        });
      } else {
        messages.push({
          role: "assistant",
          content: completion.content.length > 0 ? completion.content : null,
          toolCalls,
          toolGroupId: attemptGroup,
        });
      }
      // Earned autonomy: the SERVED model's verify track record sets its unattended auto-approve budget for
      // this batch (a model that reliably passes verification earns more rope; a sloppy one earns less).
      autoApproval.cap = autonomyCap(
        MAX_CONSECUTIVE_AUTO_APPROVALS,
        opts.capabilities?.verifyStats?.(target),
      );
      const outcomes = await executeTools(
        toolCalls,
        this.registry,
        opts,
        { sessionId, turnId, attemptId: lastAttemptId },
        grants,
        autoApproval,
      );
      // Doom-loop guard: a batch of the SAME tool calls (same names + args) repeated with no change is the
      // model going in circles. After MAX_IDENTICAL_TOOL_BATCHES identical batches, stop honestly.
      const batchSig = toolCalls
        .map((tc) => `${tc.name}:${tc.rawArgs}`)
        .sort()
        .join("|");
      if (batchSig.length > 0 && batchSig === lastBatchSig) {
        batchRepeat += 1;
      } else {
        batchRepeat = 0;
        lastBatchSig = batchSig;
      }
      if (batchRepeat + 1 >= MAX_IDENTICAL_TOOL_BATCHES) {
        emit({
          schemaVersion: 1,
          kind: "error",
          sessionId,
          errorKind: "tool",
          message: `stopped: the model repeated the same tool call ${MAX_IDENTICAL_TOOL_BATCHES}× with no progress (doom-loop guard)`,
        });
        stopReason = "looping";
        break;
      }

      // Pin the model's own plan into the SYSTEM anchor: when the model calls `plan`, re-fold its
      // latest checklist onto the base system prompt (never compacted), so it keeps adhering to it on a long
      // run instead of losing it into compacted history. Rebuilt from baseSystem so the block never compounds.
      const planCall = toolCalls.find((tc) => tc.name === "plan");
      if (planCall) {
        currentPlanBlock = renderPlanAnchor(planCall.args);
        messages[0] = {
          role: "system",
          content: currentPlanBlock ? `${baseSystem}\n\n${currentPlanBlock}` : baseSystem,
        };
      }

      // A successful mutating tool means the workspace changed → the completion gate should verify. Detect
      // by result shape (write/edit/apply_patch) OR by declared effects (bash/process can mutate too — audit).
      const mutated = outcomes.some((o) => {
        if (!o.ok) return false;
        if (isMutationOutcome(o.result)) return true;
        const effects = this.registry.get(o.toolName)?.manifest.effects ?? [];
        return effects.includes("write") || effects.includes("process");
      });
      if (mutated) {
        mutatedSinceVerify = true;
        mutatingModel = target; // attribute a later verify to THIS model, not a post-failover responder
      }
      // Ceiling-aware tool-output compression: cap the results to a share of the model's
      // REMAINING window — tighter on small-context models + as the conversation fills. Use the SERVED
      // model's budget (target may have failed over to a smaller model), and split ONE batch allowance across
      // the results so N parallel dumps can't each take the full share and collectively overflow.
      const servedBudget = budgetFromCatalog(
        liveCatalog.find((m) => m.id === target) ?? fallbackModel(target),
        opts.capabilities?.learnedCeiling?.(target),
      );
      const batchCharBudget = toolResultCharBudget(
        servedBudget,
        estimateMessagesTokens(messages, estimateOpts()) + toolTokens,
      );
      const perResultCharBudget = Math.max(
        600,
        Math.floor(batchCharBudget / Math.max(1, outcomes.length)),
      );
      for (const o of outcomes) {
        const fullText = o.ok ? stringifyResult(o.result) : `ERROR: ${o.error}`;
        const capped = capToolResult(fullText, perResultCharBudget);
        // Truncation signal must be IDENTITY, not a UTF-16 length compare: capToolResult works in UTF-8 bytes
        // and inserts a "…[N bytes truncated]…" marker, so for multi-byte text (CJK/emoji) the capped string
        // can have MORE `.length` than the original — a `<` compare would miss the truncation.
        const truncated = capped !== fullText;
        // Artifact offload: if a successful result was truncated to fit the window, store it WHOLE and
        // hand the model a retrieval handle — so a large read/grep/bash output is recoverable via read_artifact
        // instead of lost (Karpathy: keep-and-offload beats lossy summarization). The note is built HERE but
        // appended AFTER the injection guard below (it's our trusted instruction — it must live OUTSIDE the
        // untrusted-data boundary, or a flagged result would tell the model to ignore its own retrieval path).
        let retrievalNote = "";
        if (o.ok && truncated && artifactPort) {
          const handle = artifactPort(fullText);
          // JSON.stringify the opaque handle so it's always a valid quoted literal in the note the model reads.
          if (handle) {
            retrievalNote = `\n[output truncated — ${fullText.length} chars total; call read_artifact({handle:${JSON.stringify(handle)}}) to retrieve more]`;
          }
        }
        // Prompt-injection defense: scan the (capped) tool output the model will actually
        // see; if it contains instruction-like text, wrap it in a DATA boundary + neutralize forged action
        // fences so an indirect injection can't hijack the loop. A deterministic scan can't itself be injected.
        // Successful results ALWAYS carry external content. An ERROR string is normally our own (trusted) text,
        // EXCEPT for an MCP tool: a hostile server's JSON-RPC error `message` is attacker-controlled and would
        // otherwise reach the model unguarded — so guard external-tool failures too.
        const externalFailure = !o.ok && o.toolName.startsWith("mcp__");
        const guarded =
          o.ok || externalFailure
            ? guardUntrustedResult(capped)
            : { text: capped, scan: { flagged: false, patterns: [] as string[] } };
        if (guarded.scan.flagged) {
          emit({
            schemaVersion: 1,
            kind: "error",
            sessionId,
            errorKind: "tool",
            message: `untrusted output from ${o.toolName} flagged for injection (${guarded.scan.patterns.join(", ")}) — wrapped as data`,
          });
        }
        // Trusted retrieval note appended OUTSIDE the guarded (untrusted) body.
        const body = guarded.text + retrievalNote;
        if (assistedTurn) {
          messages.push({
            role: "user",
            content: `Result of ${o.toolName}:\n${body}`,
            toolGroupId: attemptGroup,
          });
        } else {
          messages.push({
            role: "tool",
            toolCallId: o.wireId,
            toolGroupId: attemptGroup,
            content: body,
          });
        }
      }
      if (turns >= opts.maxTurns) stopReason = "max_turns";
    }

    // No fail-open at the boundary: if the loop expired (max_turns) or fell through with a FAILED last
    // verification, the run did NOT verify — never report a clean complete/max_turns (audit).
    if (verifyPassed === false && (stopReason === "complete" || stopReason === "max_turns")) {
      stopReason = "verify_failed";
    }

    // If the run was aborted (e.g. a persistence write failed and the sink aborted us), the outcome is
    // NOT a success — downgrade before emitting the final result. The abort check comes AFTER the
    // last mutating turn but must gate the returned stopReason.
    if (opts.signal.aborted && stopReason === "complete") stopReason = "cancelled";
    emit({ schemaVersion: 1, kind: "turn.finished", sessionId, turnId, stopReason });
    // Re-check once more: emitting the final event may itself be the write that failed and aborted us.
    if (opts.signal.aborted && stopReason === "complete") stopReason = "cancelled";
    return { stopReason, turns, finalText };
  }

  /** The evidence-based lane for a model (defaults to `direct` when there's no evidence layer). */
  private laneOf(modelId: string, catalog: CatalogModel[], capabilities?: CapabilityPort): Lane {
    const model = catalog.find((m) => m.id === modelId);
    if (!model || !capabilities) return "direct";
    return capabilities.laneFor(model);
  }

  /** Return a copy of `messages` whose system prompt carries the assisted-lane tool protocol as text. */
  private withAssistedProtocol(messages: Msg[]): Msg[] {
    const protocol = assistedProtocol(this.registry.list());
    const [system, ...rest] = messages;
    const base = typeof system?.content === "string" ? system.content : "";
    return [{ role: "system", content: `${base}\n\n${protocol}` }, ...rest];
  }

  private resolveModel(
    requested: string,
    catalog: CatalogModel[],
    sessionId: string,
    turnId: string,
    emit: RunOptions["emit"],
    capabilities?: CapabilityPort,
    routedRole?: RoutedRole,
  ): string {
    // Fleet PHASE routing (#27): when a caller wants a specific role AND left the model on `auto`, resolve a
    // role-appropriate model from the LIVE fleet (planner/reviewer → strongest reasoner, executor → best coder)
    // instead of the generic best pick. pickForRole prefers WARM models, so this self-heals like auto-best;
    // if it can't resolve (empty pool), we fall through to the normal resolution below.
    if (requested === AUTO_MODEL && routedRole) {
      const rolePick = pickForRole(routedRole, catalog);
      if (rolePick) {
        const rm = catalog.find((m) => m.id === rolePick);
        const lane = rm && capabilities ? capabilities.laneFor(rm) : "direct";
        emit({
          schemaVersion: 1,
          kind: "model.resolved",
          sessionId,
          turnId,
          requestedModel: requested,
          targetModel: rolePick,
          lane,
          rule: "role-auto",
          reason: `routed for ${routedRole}`,
        });
        return rolePick;
      }
    }
    // `auto` (the default when no --model is given) picks the best LIVE model — never a hard-coded id, so
    // the choice self-heals as the fleet changes. A concrete request is honored, with warm substitution if cold.
    // ONE resolution source (shared with `chat`/`route`). `catalog` is guaranteed non-empty here (run() guards
    // the empty fleet), so this never returns null — the `catalog[0]` fallback exists only for exhaustiveness.
    const res = resolveRequestedModel(requested, catalog) ?? {
      requested,
      target: catalog[0]?.id ?? requested,
      rule: "auto-best" as const,
    };
    const model = catalog.find((m) => m.id === res.target);
    // Honest lane from evidence (learned > probed > declared); default direct when no evidence layer.
    const lane = model && capabilities ? capabilities.laneFor(model) : "direct";
    emit({
      schemaVersion: 1,
      kind: "model.resolved",
      sessionId,
      turnId,
      requestedModel: requested,
      targetModel: res.target,
      lane,
      rule: res.rule,
      ...(res.reason ? { reason: res.reason } : {}),
    });
    return res.target;
  }
}
