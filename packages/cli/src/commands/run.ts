import { resolveConfig } from "@amb/ambient-api";
import { IMAGE_EDGE_HIGH } from "@amb/context";
import {
  AmbError,
  type ImageAttachment,
  type Mode,
  type NewEvent,
  newSessionId,
} from "@amb/protocol";
import { AUTO_MODEL } from "@amb/reliability";
import { Agent, type EffortSetting, type RunOptions } from "@amb/runtime";
import { SessionWriter, readObject, saveObject } from "@amb/sessions";
import { AmbientChatClient } from "../agent/ambient-client.js";
import { makeInteractiveApprover } from "../agent/approver.js";
import { makeInteractiveAsker } from "../agent/asker.js";
import { makeCapabilityPort } from "../agent/capability-port.js";
import { createDurableEventSink } from "../agent/event-sink.js";
import { connectMcp } from "../agent/mcp-connect.js";
import { buildRegistry } from "../agent/registry.js";
import { EventRenderer } from "../agent/render-events.js";
import { makeSubagentTool } from "../agent/subagent-tool.js";
import { makeVerifyPort } from "../agent/verify-port.js";
import { makeWorkspaceContextPort } from "../agent/workspace-context-port.js";
import { type AmbConfig, grantsFromConfig, loadConfig } from "../config.js";
import { bold, dim } from "../render/color.js";
import { NOT_SIGNED_IN, resolveApiKey } from "../secrets.js";
import { attachImageFile, downscaleForWindow } from "../tui/capture.js";
import { isParseError, parseEffort, parseMaxTurns } from "./args.js";
import { mergeStdin, readPipedStdin } from "./stdin.js";

interface RunArgs {
  task: string;
  model: string;
  mode: Mode;
  effort: EffortSetting;
  autoAllow: boolean;
  maxTurns: number;
  jsonl: boolean;
  noMcp: boolean;
  images: string[];
  goal?: string;
  help: boolean;
  error?: string;
}

const USAGE =
  'usage: ambient run "<task>" [--model <id>] [--image <path>]… [--goal "<objective>"] [--plan|--accept-edits|--bypass] [--effort auto|off|low|medium|high] [--yes] [--no-mcp] [--jsonl]';

function parseArgs(args: string[], config: AmbConfig = {}): RunArgs {
  // Config sets the DEFAULTS; an explicit flag below always overrides.
  let model = config.model ?? AUTO_MODEL;
  let mode: Mode = config.mode ?? "ask";
  let effort: EffortSetting = config.effort ?? "auto";
  let autoAllow = false;
  let maxTurns = config.maxTurns ?? 30;
  let jsonl = false;
  let noMcp = config.noMcp ?? false;
  let help = false;
  let error: string | undefined;
  const images: string[] = [];
  let goal: string | undefined;
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model" || a === "-m") model = args[++i] ?? model;
    else if (a === "--image" || a === "-i") {
      const p = args[++i];
      if (p) images.push(p);
    } else if (a === "--goal" || a === "-g") {
      const g = args[++i];
      if (g) goal = g.trim().slice(0, 280); // a north-star is tiny (matches the TUI cap)
    } else if (a === "--plan") mode = "plan";
    else if (a === "--accept-edits") mode = "accept-edits";
    else if (a === "--bypass" || a === "--yolo") mode = "bypass";
    else if (a === "--yes" || a === "-y") autoAllow = true;
    else if (a === "--jsonl") jsonl = true;
    else if (a === "--no-mcp") noMcp = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--effort") {
      const r = parseEffort(args[++i]);
      if (isParseError(r)) error = r.error;
      else effort = r as EffortSetting;
    } else if (a === "--max-turns") {
      const r = parseMaxTurns(args[++i]);
      if (isParseError(r)) error = r.error;
      else maxTurns = r;
    } else if (a?.startsWith("--")) {
      // An unrecognized long flag is almost certainly a typo (`--modle`, `--bypas`) — reject it instead of
      // silently folding it into the TASK and running a billed job in the wrong mode.
      error = error ?? `unknown flag "${a}" — run \`ambient run --help\` for usage`;
    } else if (a) parts.push(a);
  }
  if (mode === "bypass") autoAllow = true;
  return {
    task: parts.join(" ").trim(),
    model,
    mode,
    effort,
    autoAllow,
    maxTurns,
    jsonl,
    noMcp,
    images,
    ...(goal ? { goal } : {}),
    help,
    error,
  };
}

/** `ambient run "<task>"` (also the bare `amb "<task>"`) — run the coding agent to completion. */
export async function runAgent(args: string[]): Promise<void> {
  const userConfig = loadConfig();
  const {
    task,
    model,
    mode,
    effort,
    autoAllow,
    maxTurns,
    jsonl,
    noMcp,
    images,
    goal,
    help,
    error,
  } = parseArgs(args, userConfig);
  // `--help` must print usage WITHOUT signing in, connecting MCP servers, or sending a billed request — it
  // used to fall through as the TASK, spawning every MCP server and spending a real completion to echo "--help".
  if (help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (error) {
    process.stderr.write(`ambient: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  // Fold PIPED stdin into the task so `cat err.log | amb "explain this"` works (a TTY is never read — that
  // would hang waiting for a human's EOF). With only a pipe, it becomes the task (`echo "…" | amb`).
  const finalTask = mergeStdin(task, await readPipedStdin());
  if (!finalTask) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`);
    process.exitCode = 1;
    return;
  }

  const config = { baseUrl: resolveConfig().baseUrl, apiKey };
  const client = new AmbientChatClient(config);
  const cwd = process.cwd();
  // A UNIQUE session id per run — never reuse a cwd-derived file.
  const sessionId = newSessionId();
  const writer = new SessionWriter(sessionId, () => new Date().toISOString());
  const renderer = new EventRenderer();

  const controller = new AbortController();
  const onSigint = () => {
    process.stderr.write(dim("\n(cancelling — press Ctrl-C again to force quit)\n"));
    controller.abort();
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", onSigint);

  // A persistence failure ABORTS the run: if we can't durably record intent, we must not keep executing
  // mutations. The shared sink persists first, then delivers; in --jsonl mode durable events become JSON lines.
  const emit = createDurableEventSink({
    writer,
    consume: (ev: NewEvent) => {
      if (jsonl) {
        if (ev.kind !== "assistant.delta" && ev.kind !== "reasoning.delta") {
          process.stdout.write(`${JSON.stringify(ev)}\n`);
        }
      } else {
        renderer.handle(ev);
      }
    },
    onWriteError: (err) => {
      if (!jsonl)
        process.stderr.write(dim(`\n(session log write failed: ${err.message} — aborting)\n`));
      controller.abort();
    },
  });

  // `--image <path>` (repeatable): attach images to the initiating message. A vision-capable model sees them;
  // a blind model gets the vision-relay description (same path as the TUI). Bad paths warn but don't abort.
  const attachments: ImageAttachment[] = [];
  for (const p of images) {
    const res = await attachImageFile(p, "file");
    if (!res.ok) {
      process.stderr.write(`ambient: skipping --image ${p}: ${res.reason}\n`);
      continue;
    }
    const sized = await downscaleForWindow(res.attachment, IMAGE_EDGE_HIGH);
    saveObject(sessionId, sized.dataBase64); // offload bytes for resume; never in the event log
    attachments.push(sized);
  }

  if (!jsonl)
    process.stderr.write(
      `${bold("ambient")} ${dim(`· ${mode} · ${model} · effort ${effort}${attachments.length ? ` · ${attachments.length} image(s)` : ""} · ${cwd} · ${sessionId}`)}\n`,
    );
  // A `--goal` sets the run's north-star: record it durably (so `amb resume` restores it) + surface it.
  if (goal) {
    emit({ schemaVersion: 1, kind: "goal.set", sessionId, text: goal });
    if (!jsonl) process.stderr.write(dim(`  ◎ goal: ${goal}\n`));
  }

  const opts: RunOptions = {
    sessionId,
    mode,
    requestedModel: model,
    maxTurns,
    cwd,
    workspaceRoot: cwd,
    signal: controller.signal,
    emit,
    approve: makeInteractiveApprover({ autoAllow }),
    // Seed the persistent allowlist (config `allow`) as session grants so those tools don't re-prompt.
    grants: grantsFromConfig(userConfig),
    // A stdin questionnaire for `ask_user` — only when interactive; a piped/scripted run omits it so the
    // tool returns its proceed-on-best-judgment note instead of blocking on a human who isn't there.
    ...(process.stdin.isTTY ? { ask: makeInteractiveAsker() } : {}),
    capabilities: makeCapabilityPort(),
    workspace: makeWorkspaceContextPort(),
    verify: makeVerifyPort(cwd),
    checkpoint: (content) => saveObject(sessionId, content),
    artifact: (content) => saveObject(sessionId, content), // offload large tool outputs
    readArtifact: (handle) => readObject(sessionId, handle),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(goal ? { goal } : {}),
    effort,
  };

  // Connect the user's MCP servers (Claude + Codex config) so their tools reach the model. Project-scoped
  // servers spawn only with an explicit opt-in (they run local processes); user-scoped ones auto-connect.
  // `--no-mcp` (or AMBIENT_NO_MCP=1) skips the whole discovery+spawn — a lean, fast run with only the built-in
  // tools (a big user MCP suite otherwise spawns ~10 processes + injects 100+ tools before turn 1).
  const skipMcp = noMcp || process.env.AMBIENT_NO_MCP === "1";
  const mcp = skipMcp
    ? { tools: [], notices: [], close: () => {} }
    : await connectMcp(cwd, {
        approveServer: async () => process.env.AMBIENT_MCP_ALLOW_PROJECT === "1",
      });
  if (!jsonl) for (const n of mcp.notices) process.stderr.write(dim(`  ${n}\n`));

  try {
    // Build the registry INSIDE the try so a dup-tool-id throw still reaches `finally` → mcp.close() (no
    // leaked server processes on a registry-composition failure).
    const registry = buildRegistry({
      mcpTools: mcp.tools,
      subagent: makeSubagentTool({
        client,
        workspace: opts.workspace,
        approve: opts.approve,
        parentMode: opts.mode,
        ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.goal ? { goal: opts.goal } : {}),
        ...(opts.verify ? { verify: opts.verify } : {}),
      }),
    });
    const result = await new Agent(client, registry).run(finalTask, opts);
    if (jsonl) {
      process.stdout.write(
        `${JSON.stringify({ kind: "result", sessionId, stopReason: result.stopReason, turns: result.turns, finalText: result.finalText })}\n`,
      );
    } else {
      process.stdout.write(`\n${dim(`[${result.stopReason} · ${result.turns} turn(s)]`)}\n`);
    }
    // Non-success stop reasons must set a nonzero exit code for scripts/CI.
    if (result.stopReason !== "complete")
      process.exitCode = result.stopReason === "cancelled" ? 130 : 1;
  } catch (err) {
    const message = err instanceof AmbError ? err.message : (err as Error).message;
    if (jsonl)
      process.stdout.write(
        `${JSON.stringify({ kind: "result", sessionId, stopReason: "error", message })}\n`,
      );
    else process.stderr.write(`\namb: ${message}\n`);
    process.exitCode = 1;
  } finally {
    mcp.close();
    process.removeListener("SIGINT", onSigint);
  }
}
