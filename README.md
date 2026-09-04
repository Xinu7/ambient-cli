# Ambient CLI

A standalone terminal coding agent for the [**Ambient**](https://ambient.xyz) decentralized-inference
network — plan, edit, run, and ship code across *every* model in Ambient's live fleet.

```bash
ambient "add input validation to the signup handler and run the tests"
```

`ambient` runs a real coding agent on Ambient models: it reads and searches your repo, edits files with
conflict-safe diffs, runs commands, verifies its work, and streams the whole thing to your terminal — under a
permission model you control. Run it with no arguments to open the interactive TUI.

## Install

Requires **Node ≥ 20.18**. No compiler needed — the CLI ships as a single pre-built JavaScript bundle.

**Homebrew** (recommended):

```bash
brew install xinu7/ambient/ambient-code
ambient login          # paste your key from https://app.ambient.xyz/keys
ambient                # launch the TUI
```

**From source**:

```bash
git clone https://github.com/xinu7/ambient-cli && cd ambient-cli
./scripts/install.sh   # builds + puts `ambient` on your PATH (~/.local/bin)
```

**npm** — `npm install -g ambient-code` (the installed command is still `ambient`/`amb`).

Get a key at [app.ambient.xyz/keys](https://app.ambient.xyz/keys). `ambient login` stores it in your OS
keychain; or set `AMBIENT_API_KEY` in your environment. Browsing the fleet (`ambient models`) and
`ambient doctor` need no key. `ambient` is the primary command; `amb` is a shorter alias.

## What makes it different

- **Live model fleet.** Every run shows which Ambient model is serving it (requested → served), its readiness,
  and its capability lane. `ambient models` renders the whole fleet.
- **Works with *every* serveable model.** Models with native tool-calling use it directly; models without it
  are driven through a controller-assisted text protocol — not just the tool-capable ones.
- **Honest reliability.** Warm-model substitution is never silent; cold models fail cleanly; context is
  budgeted per model; failover is bounded and visible; the transcript is crash-safe and resumable.
- **You hold the dial.** A two-axis control — **Plan ⇄ Build** (Tab) × **ask / accept-edits / bypass**
  (Shift+Tab) — with a diff-first approval prompt and a local risk classifier.
- **A north-star you set.** `/goal` pins a session objective the agent keeps in view every turn (it survives
  compaction); the agent can propose a revision, but only you commit it.
- **Brings your setup.** Reads your existing `.claude/agents`, skills, slash commands, `AGENTS.md`, and MCP
  servers (both the `.mcp.json` and Codex `config.toml` dialects) so what you already use works on Ambient
  models.

## Commands

```
ambient                             Launch the interactive TUI
ambient "<task>"                    Run the coding agent on a task (line UI)
ambient run "<task>" [flags]        Same (--plan --accept-edits --bypass --effort --goal --model --jsonl …)
ambient chat "<prompt>" [--model]   Talk to a live Ambient model (no tools)
ambient models [--json]             Show the live model fleet with capability lanes
ambient probe <id>                  Test a model's native tool-calling (records evidence)
ambient route explain [id]          Explain which model + lane a task would use
ambient sessions [show <id>]        List / inspect past sessions
ambient resume [<id|latest> "<…>"]  Continue a prior session with a new instruction
ambient rewind [<id|latest>] [N]    Revert the workspace to before the last N file-changing turns
ambient config [show|path]          Show your ~/.config/amb defaults
ambient github [status|login]       Show GitHub sign-in (or run `gh auth login`)
ambient doctor                      Check your setup + network
ambient login | help
```

Anything can be piped in as context: `cat error.log | ambient "explain this failure"`.

## Architecture

A TypeScript/pnpm monorepo split into a pure **harness** and a thin terminal **shell**:

`protocol` (Zod contracts + a hash-chained event log) · `ambient-api` (catalog + SSE transport) ·
`reliability` (ready/cold, output floors, 429, overflow) · `capabilities` (evidence ladder → lane) ·
`context` (token budgeting + compaction + repo map) · `permissions` (the mode ladder + risk classifier) ·
`tools-core` (read/edit/write/grep/glob/bash + web_fetch, symlink-safe) · `sessions` (crash-safe JSONL +
rewind blobs) · `mcp` (MCP client) · `evals` (the eval ship-gate) · `runtime` (the agent state machine +
the controller-assisted lane + subagents) · `cli` (the commands + Ink TUI).

The runtime is a **pure event producer**; the TUI is a **pure event consumer** over a **pure reducer**. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the engineering standards.

## Development

```bash
pnpm install
pnpm -r build           # → the single-file binary at packages/cli/dist/amb.js
pnpm test               # vitest
pnpm typecheck          # tsc across all packages
pnpm lint               # biome
```

## License

[MIT](./LICENSE). This is an original, clean-room implementation — not a fork of any coding agent. Where it
re-implements logic or borrows patterns, that's recorded in [`ATTRIBUTION.md`](./ATTRIBUTION.md) and
[`NOTICE`](./NOTICE).
