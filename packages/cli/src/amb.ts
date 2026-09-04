// Build-time-injected package version (tsup `define`); falls back to "dev" un-bundled.
declare const __AMB_VERSION__: string;
import { runChat } from "./commands/chat.js";
import { runConfig } from "./commands/config-show.js";
import { runDoctor } from "./commands/doctor.js";
import { runEval } from "./commands/eval.js";
import { runGitHub } from "./commands/github.js";
import { runLogin } from "./commands/login.js";
import { runModels } from "./commands/models.js";
import { runProbe } from "./commands/probe.js";
import { runResume } from "./commands/resume.js";
import { runRewind } from "./commands/rewind.js";
import { runRoute } from "./commands/route.js";
import { runAgent } from "./commands/run.js";
import { runSessions } from "./commands/sessions.js";
import { runSkills } from "./commands/skills.js";
import { runTuiCommand } from "./commands/tui.js";

const HELP = `ambient — Ambient CLI (a terminal coding agent for the Ambient network)

Usage:
  ambient                                Launch the interactive TUI (in a terminal)
  ambient login                          Sign in — save your Ambient API key to the keychain
  ambient tui ["<task>"] [flags]         Same — the Ambient-branded interactive UI
  ambient "<task>"                       Run the coding agent on a task (line UI)
  ambient run "<task>" [flags]           Same as above
  cmd | ambient "<task>"                 Pipe stdin in as context (cat err.log | ambient "explain")
  ambient chat "<prompt>" [--model <id>] Talk to a live Ambient model (no tools)
  ambient models [--json]                Show the live Ambient model fleet
  ambient skills [--json]                Scrape Claude + Codex + plugin skills the agent can use
  ambient skills show "<name>"           Print a discovered skill's full instructions
  ambient skills pin|unpin "<name>"      Pin a skill so it ALWAYS auto-loads (or unpin it)
  ambient probe <model-id>               Test a model's native tool-calling (records the result)
  ambient route explain [model-id]       Explain which model + lane a task would use
  ambient sessions [show <id>]           List / inspect past sessions
  ambient resume [<id|latest> "<next>"]  Continue a prior session with a new instruction
  ambient rewind [<id|latest>] [N] [--yes] Revert the workspace to before the last N file-changing turns
  ambient eval [name] [flags]            Run the repo's private eval suite as a ship gate
  ambient config [show|path]             Show your ~/.config/amb/config.json defaults
  ambient github [status|login]          Show GitHub sign-in (or run 'gh auth login')
  ambient doctor                         Check your setup + network
  ambient help                           Show this help

Run flags:
  --model <id>        Pick a model (default: auto — best available from the live fleet)
  --goal "<text>"     Set a session north-star the agent keeps in view every turn
  --plan              Read-only: propose changes without making them
  --accept-edits      Auto-approve file edits (still confirms shell)
  --bypass, --yolo    Full autonomy: no approval prompts (incl. shell)
  --effort <level>    Reasoning effort: auto (default) | off | low | medium | high
  --yes, -y           Auto-approve file edits (shell/network still prompt; use --bypass for those)
  --max-turns <n>     Cap the agent loop (integer 1–1000, default 30)
  --jsonl             Emit machine-readable JSONL events to stdout (for scripts/CI)

Eval flags:
  --model <id>        Model to evaluate (default: auto)
  --min-pass-rate <r> Fail (exit 1) if the pass rate is below r (0–1)
  --baseline          Compare to .ambient/evals/<name>.baseline.json; fail on any regression
  --save-baseline     Save this run as the baseline for future comparisons
  --json              Emit the full EvalReport as JSON (for CI)

Everything runs on Ambient models only.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "tui":
      await runTuiCommand(rest);
      break;
    case "run":
      await runAgent(rest);
      break;
    case "chat":
      await runChat(rest);
      break;
    case "models":
      await runModels(rest);
      break;
    case "skills":
      await runSkills(rest);
      break;
    case "probe":
      await runProbe(rest);
      break;
    case "route":
      await runRoute(rest);
      break;
    case "sessions":
      await runSessions(rest);
      break;
    case "resume":
      await runResume(rest);
      break;
    case "rewind":
      await runRewind(rest);
      break;
    case "eval":
      await runEval(rest);
      break;
    case "login":
      await runLogin();
      break;
    case "config":
      await runConfig(rest);
      break;
    case "github":
    case "gh":
      await runGitHub(rest);
      break;
    case "doctor":
      await runDoctor();
      break;
    case "--version":
    case "-v":
    case "version":
      // Injected at build time by tsup (define); "dev" when run un-bundled (tsc/vitest).
      process.stdout.write(
        `ambient ${typeof __AMB_VERSION__ === "string" ? __AMB_VERSION__ : "dev"}\n`,
      );
      break;
    case undefined:
      // Bare `amb` in a terminal launches the interactive TUI; otherwise show help (pipes/CI).
      if (process.stdin.isTTY && process.stdout.isTTY) await runTuiCommand([]);
      else process.stdout.write(`${HELP}\n`);
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${HELP}\n`);
      break;
    default:
      // Bare `ambient "<task>" [flags]` — anything not a known subcommand is a run (flags included).
      await runAgent(argv);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ambient: ${message}\n`);
  process.exitCode = 1;
});
