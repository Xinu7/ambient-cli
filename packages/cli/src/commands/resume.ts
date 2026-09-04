import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "@amb/ambient-api";
import { readTextCappedSafe } from "@amb/context";
import { AmbError, type Mode, type NewEvent, newSessionId } from "@amb/protocol";
import { AUTO_MODEL } from "@amb/reliability";
import { Agent, type RunOptions } from "@amb/runtime";
import {
  SessionWriter,
  contentHash,
  latestGoal,
  latestPlan,
  readObject,
  readSession,
  reconcile,
  reconstructTranscript,
  recoveryNotes,
  renderOutstandingPlan,
  saveObject,
  sessionsDir,
  turnCount,
  unsettledTools,
} from "@amb/sessions";
import { createBuiltinRegistry } from "@amb/tools-core";
import { AmbientChatClient } from "../agent/ambient-client.js";
import { makeInteractiveApprover } from "../agent/approver.js";
import { makeInteractiveAsker } from "../agent/asker.js";
import { makeCapabilityPort } from "../agent/capability-port.js";
import { createDurableEventSink } from "../agent/event-sink.js";
import { connectMcp } from "../agent/mcp-connect.js";
import { buildRegistry } from "../agent/registry.js";
import { EventRenderer } from "../agent/render-events.js";
import { resolveSessionId } from "../agent/session-select.js";
import { makeSubagentTool } from "../agent/subagent-tool.js";
import { makeVerifyPort } from "../agent/verify-port.js";
import { makeWorkspaceContextPort } from "../agent/workspace-context-port.js";
import { bold, dim } from "../render/color.js";
import { NOT_SIGNED_IN, resolveApiKey } from "../secrets.js";

/** True if `relPath` (resolved WITHIN `root`) exists and hashes to `expectedHash` (recovery: did the write
 *  land?). Contained + symlink-safe + size-bounded: a logged `../escape` path or a symlink can't read outside
 * the recorded workspace, and a huge file can't OOM the recovery check. */
function fileHashEquals(root: string, relPath: string, expectedHash: string): boolean {
  const text = readTextCappedSafe(join(root, relPath), { root, maxBytes: 4_194_304 });
  return text !== null && contentHash(text) === expectedHash;
}

interface ResumeArgs {
  idArg: string;
  instruction: string;
  model: string;
  mode: Mode;
  autoAllow: boolean;
  list: boolean;
  error?: string;
}

/** Parse resume args, consuming flag VALUES so they never leak into the instruction. */
function parseArgs(args: string[]): ResumeArgs {
  let model = AUTO_MODEL;
  let mode: Mode = "ask";
  let autoAllow = false;
  let error: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model" || a === "-m") {
      const v = args[++i];
      if (v === undefined) error = "--model needs a value";
      else model = v;
    } else if (a === "--bypass" || a === "--yolo") {
      mode = "bypass";
      autoAllow = true;
    } else if (a === "--accept-edits") mode = "accept-edits";
    else if (a === "--yes" || a === "-y") autoAllow = true;
    else if (a?.startsWith("-")) error = `unknown flag: ${a}`;
    else if (a !== undefined) positional.push(a);
  }
  const [idArg = "", ...instrParts] = positional;
  return {
    idArg,
    instruction: instrParts.join(" ").trim(),
    model,
    mode,
    autoAllow,
    list: positional.length === 0,
    error,
  };
}

/** Most-recent session that has at least one TURN, or a specific id if it exists. */

function listResumable(): void {
  const dir = sessionsDir();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  if (files.length === 0) {
    process.stdout.write("No sessions to resume yet.\n");
    return;
  }
  const rows = files
    .map((f) => ({ id: f.replace(/\.jsonl$/, ""), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  process.stdout.write(`${bold("Resumable sessions")} ${dim("(newest first)")}\n\n`);
  for (const r of rows.slice(0, 15)) {
    const { events } = readSession(r.id);
    const turns = turnCount(events);
    if (turns === 0) continue;
    const first = events.find(
      (e): e is Extract<typeof e, { kind: "turn.started" }> => e.kind === "turn.started",
    );
    process.stdout.write(
      `  ${r.id}  ${dim(`${turns} turn(s)`)}${first ? dim(` · "${first.input.slice(0, 50)}"`) : ""}\n`,
    );
  }
  process.stdout.write(dim('\nResume with:  ambient resume <id|latest> "<next instruction>"\n'));
}

/** `amb resume` (list) | `ambient resume <id|latest> "<instruction>" [flags]` (warm-continue). */
export async function runResume(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.error) {
    process.stderr.write(`ambient: ${parsed.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (parsed.list) {
    listResumable();
    return;
  }

  const sessionId0 = resolveSessionId(parsed.idArg);
  if (!sessionId0) {
    process.stderr.write(`ambient: no resumable session for "${parsed.idArg}"\n`);
    process.exitCode = 1;
    return;
  }
  if (!parsed.instruction) {
    process.stderr.write(
      'ambient: resume needs a new instruction, e.g. ambient resume latest "now add tests"\n',
    );
    process.exitCode = 1;
    return;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`);
    process.exitCode = 1;
    return;
  }

  // Integrity check: refuse to resume a session whose durable log is broken/tampered.
  const { events, chainIntact, interiorCorruption, droppedTail } = readSession(sessionId0);
  if (!chainIntact || interiorCorruption) {
    process.stderr.write(
      `ambient: session ${sessionId0} has a corrupted/incomplete log (chain broken) — refusing to resume it.\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (droppedTail > 0)
    process.stderr.write(
      dim(`  the prior session ended abruptly (${droppedTail} unfinished log line(s))\n`),
    );

  // Crash recovery (#38): reconcile any tool whose intent was recorded but whose result never landed (a crash
  // mid-tool or the torn tail above). Classify with the builtin manifests (never blind-replay), then for a
  // `write` compare the intended content to the file ON DISK — the one fs read happens here at the CLI edge.
  // Reconcile against the workspace the ORIGINAL session recorded — NOT the cwd we happen to be resuming from
  // (resuming repo A from inside repo B must not falsely report a write as un-applied).
  const recordedRoot =
    events.find((e) => e.kind === "session.started")?.workspaceRoot ?? process.cwd();
  const builtins = createBuiltinRegistry();
  const lookup = (name: string) => {
    const m = builtins.get(name)?.manifest;
    return m ? { effects: m.effects, idempotency: m.idempotency } : undefined;
  };
  const reconciliations = reconcile(unsettledTools(events), lookup);
  const notes = recoveryNotes(reconciliations, (r) =>
    r.path && r.expectedPostimageHash
      ? fileHashEquals(recordedRoot, r.path, r.expectedPostimageHash)
      : false,
  );
  for (const n of notes) process.stderr.write(dim(`  recovery: ${n}\n`));

  // The model-facing resume context: the prior transcript + the outstanding plan + the reconciliation notes,
  // so a resumed run picks up the checklist and knows exactly which interrupted effect to re-verify.
  const outstanding = renderOutstandingPlan(latestPlan(events));
  const recoveryBlock =
    notes.length > 0
      ? `## Interrupted work (reconcile before continuing)\n${notes.map((n) => `- ${n}`).join("\n")}`
      : "";
  const resumeContext = [reconstructTranscript(events), outstanding, recoveryBlock]
    .filter(Boolean)
    .join("\n\n");
  const resumedGoal = latestGoal(events); // the north-star carries across resume
  const priorLastEventId = events.at(-1)?.eventId;

  const config = { baseUrl: resolveConfig().baseUrl, apiKey };
  const client = new AmbientChatClient(config);
  const cwd = process.cwd();
  const sessionId = newSessionId(); // a NEW session — never mutate the prior log
  const writer = new SessionWriter(sessionId, () => new Date().toISOString());
  const renderer = new EventRenderer();
  const controller = new AbortController();
  const onSigint = () => {
    controller.abort();
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", onSigint);

  const emit = createDurableEventSink({
    writer,
    consume: (ev: NewEvent) => renderer.handle(ev),
    onWriteError: () => controller.abort(),
  });
  // A durable fork record: this new session continues from the prior log's last event (wires the reserved
  // `session.resumed` kind — a real provenance link between the sealed prior log and this one).
  emit({
    schemaVersion: 1,
    kind: "session.resumed",
    sessionId,
    ...(priorLastEventId ? { fromEventId: priorLastEventId } : {}),
  });
  // Carry the north-star into the new session's log so a further resume keeps restoring it.
  if (resumedGoal) emit({ schemaVersion: 1, kind: "goal.set", sessionId, text: resumedGoal });

  process.stderr.write(
    `${bold("amb resume")} ${dim(`· from ${sessionId0} · ${parsed.model} · ${sessionId}`)}\n`,
  );

  const opts: RunOptions = {
    sessionId,
    mode: parsed.mode,
    requestedModel: parsed.model,
    maxTurns: 30,
    cwd,
    workspaceRoot: cwd,
    signal: controller.signal,
    emit,
    approve: makeInteractiveApprover({ autoAllow: parsed.autoAllow }),
    ...(process.stdin.isTTY ? { ask: makeInteractiveAsker() } : {}),
    capabilities: makeCapabilityPort(),
    workspace: makeWorkspaceContextPort(),
    verify: makeVerifyPort(cwd),
    checkpoint: (content) => saveObject(sessionId, content),
    artifact: (content) => saveObject(sessionId, content), // offload large tool outputs
    readArtifact: (handle) => readObject(sessionId, handle),
    resumeContext,
    ...(resumedGoal ? { goal: resumedGoal } : {}),
  };

  const mcp = await connectMcp(cwd, {
    approveServer: async () => process.env.AMBIENT_MCP_ALLOW_PROJECT === "1",
  });
  for (const n of mcp.notices) process.stderr.write(dim(`  ${n}\n`));

  try {
    // Build the registry INSIDE the try so a dup-tool-id throw still reaches `finally` → mcp.close().
    const registry = buildRegistry({
      mcpTools: mcp.tools,
      subagent: makeSubagentTool({
        client,
        workspace: opts.workspace,
        approve: opts.approve,
        parentMode: opts.mode,
        ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
        ...(opts.verify ? { verify: opts.verify } : {}),
      }),
    });
    const result = await new Agent(client, registry).run(parsed.instruction, opts);
    process.stdout.write(`\n${dim(`[${result.stopReason} · ${result.turns} turn(s)]`)}\n`);
    if (result.stopReason !== "complete")
      process.exitCode = result.stopReason === "cancelled" ? 130 : 1;
  } catch (err) {
    process.stderr.write(
      `\namb: ${err instanceof AmbError ? err.message : (err as Error).message}\n`,
    );
    process.exitCode = 1;
  } finally {
    mcp.close();
    process.removeListener("SIGINT", onSigint);
  }
}
