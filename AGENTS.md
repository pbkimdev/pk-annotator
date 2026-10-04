# pk-annotator work contract

pk-annotator is a dev-only browser annotation package: a floating overlay for picking elements and writing prompts, in-page capture of console, errors, network, recordings, and performance, a Vite dev plugin, a file store, the `pka` CLI, and the `pka-mcp` stdio MCP server. [docs/DESIGN.md](docs/DESIGN.md) is the authority for behavior, layout, budgets, and security rules.

Start with [docs/DEVELOPING.md](docs/DEVELOPING.md) for the task map, fixture workflow, and checks. [docs/INTEGRATION-HISTORY.md](docs/INTEGRATION-HISTORY.md) contains dated consumer plans, not the current package contract.

## Build rules

- Implement what DESIGN.md says. If a section cannot be built as written, build the closest correct version and report the deviation with its reason; do not silently reduce scope.
- TypeScript strict, ESM, Node 24, pnpm 11. React 19 is a peer dependency of the overlay. Vite 8 plugin API.
- Validate every boundary with Zod 4 `strictObject`: HMR channel messages, store files read from disk, CLI arguments, MCP tool inputs. Reject unknown fields; never strip them.
- The MCP server targets specification 2026-07-28 through `@modelcontextprotocol/server` 2.x with `serveStdio`. Tools only, plus Claude Code's experimental `claude/channel` capability as DESIGN.md's Channel section defines it: no resources, prompts, sampling, roots, logging, or tasks. stdout carries only JSON-RPC; diagnostics go to stderr.
- `src/ops/` holds every store operation. The CLI and the MCP server are thin wrappers over it; neither touches the store directly.
- The resource budget in DESIGN.md is a requirement: no polling, no idle timers, bounded buffers, lazy loading of UI and Perf observers (the bounded Network observer starts with capture), nothing mounted when `navigator.webdriver` is true, nothing from `overlay/` or `core/` in a production build of a consumer.
- Lint with Oxlint and the pkcc anti-slop plugin; format with oxfmt. Do not add ESLint, Prettier, or Biome.
- Handle errors where recovery can be decided; otherwise propagate them with context. Fail loudly on impossible states. No silent defaults.
- No speculative abstraction layers, options, or files. Inline by default.
- Code comments are rare and explain why, never what.

## Tests

- Write few tests. Cover a failure in a critical path or shared utility once, at the layer that owns it. Prefer extending an existing test file.
- A green unit test is not an end-to-end result. Report what ran and what was not exercised.

## Working in this repo

- Each lane works in its assigned worktree under `~/.worktrees/pk-annotator/<branch>` and only in the directories its brief names. Say so in the report if a shared file (package.json, tsconfig, shared schema) had to change.
- One concern per commit; short messages that say why. Do not push; the driving agent merges and pushes.
- Run checks and builds only in worktrees; the main checkout serves the live test page.
- Scratch goes to `/tmp/pk-annotator/`; temporary working notes go to `_interim/` (ignored). Delete scratch you created and stop processes you started before reporting.
- Never read or print secrets. Never write Infisical, DNS, Tunnel, Traefik, or host-sync.

## Commands

- `pnpm install`, `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format`, `pnpm fixture`, `pnpm fixture:smoke`, `pnpm verify` (lint, format check, typecheck, test, build).

## Lane report

Report: what was built, the DESIGN.md sections it covers, commands run with their results, deviations with reasons, anything unconfirmed, and the commit SHAs.
