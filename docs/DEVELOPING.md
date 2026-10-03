# Developing pk-annotator

[README](../README.md) owns consumer setup. [DESIGN](DESIGN.md) owns package behavior, budgets, and security. [Integration history](INTEGRATION-HISTORY.md) preserves dated consumer plans and observations. A consumer path in that history is not a path in this checkout.

## Task map

Start with the row for the behavior you are changing. Search its files for the relevant symbol, then read that function and its callers. Read a large diff one file at a time; a truncated preview does not cover the omitted hunks.

| Task | Implementation | Contract | Owning check |
| --- | --- | --- | --- |
| Mount, theme, dock, prompt, replies | [overlay/index.ts](../src/overlay/index.ts), [launcher.ts](../src/overlay/launcher.ts), [composer.tsx](../src/overlay/composer.tsx), [thread-store.ts](../src/overlay/thread-store.ts) | [Public API](DESIGN.md#public-api), [overlay/context.tsx](../src/overlay/context.tsx) | `pnpm fixture:smoke`; inspect both themes for visual changes |
| Pick, box/lasso, element description and source | [select/pick.ts](../src/select/pick.ts), [marquee.ts](../src/select/marquee.ts), [source.ts](../src/select/source.ts), [vite/source.ts](../src/vite/source.ts) | [Selection](DESIGN.md#selection), [shared/schema.ts](../src/shared/schema.ts) | `pnpm exec vitest run src/select`; fixture `/` covers wrappers, portals, and SSR |
| Console, errors, network, redaction | [core/index.ts](../src/core/index.ts), [network.ts](../src/core/network.ts), [overlay/panels/](../src/overlay/panels) | [Resource budget](DESIGN.md#resource-budget), [shared/timeline.ts](../src/shared/timeline.ts) | `pnpm exec vitest run src/core/core.test.ts`; fixture `/lab` |
| HMR messages and symbolication | [overlay/channel-client.ts](../src/overlay/channel-client.ts), [vite/index.ts](../src/vite/index.ts), [symbolicate.ts](../src/vite/symbolicate.ts) | [shared/channel.ts](../src/shared/channel.ts) | `pnpm exec vitest run src/vite/symbolicate.test.ts`; fixture send |
| Recording, keyframes, capture files | [overlay/recording/recorder.ts](../src/overlay/recording/recorder.ts), [media.ts](../src/overlay/recording/media.ts), [files.ts](../src/overlay/recording/files.ts), [overlay/send.ts](../src/overlay/send.ts) | [shared/recording.ts](../src/shared/recording.ts) | `pnpm exec vitest run src/overlay/recording/files.test.ts`; `pnpm fixture:smoke` |
| Live performance and lab verdicts | [overlay/perf/](../src/overlay/perf), [overlay/panels/perf.tsx](../src/overlay/panels/perf.tsx), [lab/lab.ts](../src/lab/lab.ts), [insights.ts](../src/lab/insights.ts) | [shared/verdict.ts](../src/shared/verdict.ts), [Performance](DESIGN.md#performance) | `pnpm exec vitest run src/overlay/perf/join.test.ts src/lab/verdict.test.ts`; lab verdicts require a production consumer |
| Store paths, claims, status, replies | [store/store.ts](../src/store/store.ts), [ops/ops.ts](../src/ops/ops.ts), [views.ts](../src/ops/views.ts) | [shared/schema.ts](../src/shared/schema.ts), [MCP lifecycle](DESIGN.md#mcp-server) | `pnpm exec vitest run src/store/store.test.ts src/ops/ops.test.ts` |
| CLI and MCP interfaces | [cli/main.ts](../src/cli/main.ts), [mcp/main.ts](../src/mcp/main.ts) | Input and result schemas in [ops/ops.ts](../src/ops/ops.ts) | `pnpm exec vitest run src/mcp/mcp.test.ts`; smoke covers built CLI list/get |
| Packaging, CSS, third-party capture behavior | [tsdown.config.ts](../tsdown.config.ts), [overlay/shadow.css](../src/overlay/shadow.css), [overlay/untracked-fetch.ts](../src/overlay/untracked-fetch.ts), [overlay/perf/observer.ts](../src/overlay/perf/observer.ts) | [Package exports](../package.json), [shadow-root constraints](DESIGN.md#ai-elements-inside-the-shadow-root) | `pnpm build`; browser checks must use rebuilt output |

The build injects untracked `fetch` into the overlay bundle so screenshot resources do not become page requests. It also injects tracked performance observers so they can be disconnected. Source inspection alone does not establish what a bundled dependency uses.

## Local fixture

Use Node 24 and pnpm 11. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm fixture
```

The fixture listens at `http://127.0.0.1:3200`; `PORT=3310 pnpm fixture` selects another port and refuses to use an occupied one. `/` exercises picking across JSX wrappers and portals. `/lab` provides console errors, requests, an event stream, a slow interaction, and a form. API routes and the screenshot CSP live in [fixtures/app/vite.config.ts](../fixtures/app/vite.config.ts).

The fixture imports the Vite plugin from source but consumes the overlay from `dist/overlay.mjs`, like a published package. `pnpm fixture` builds once before starting Vite. After changing overlay code or build injection, stop the fixture and run `pnpm fixture` again; source edits alone do not rebuild the overlay. Use Ctrl+C in the terminal that owns the fixture.

Normal Playwright runs intentionally mount nothing because `navigator.webdriver` is true. Use the smoke driver when testing the overlay itself: it first verifies that guard, then overrides `webdriver` only in a separate fixture browser context. Keep the product guard intact.

## Browser smoke

Install the browser once, then run:

```sh
pnpm exec playwright install chromium
pnpm fixture:smoke
```

[fixtures/smoke.ts](../fixtures/smoke.ts) builds on the same fixture and uses a temporary workspace under `/tmp/pk-annotator/` with an ephemeral loopback port. It checks the automation guard, opens the dock, records a request, sends the prompt, and reads the saved annotation through the built CLI. It also saves and edits marks, captures crops and drawings, records two region GIF/WebM clips, sends one combined annotation, and checks minimize, language, and Exit. It validates the recording manifests, network body, summary, WebP keyframes, GIF/WebM signatures, and distinct attachment paths. Full Chromium is required; headless-shell cannot perform Element Capture. It closes Chromium and Vite and removes its workspace after success or failure. It never uses an existing annotation store.

This is a browser integration check, separate from `pnpm verify`. It does not establish visual quality, video fidelity, Electron behavior, MCP client integration, or production performance. Run it after overlay, plugin, recording, or packaging changes; use the affected component tests for narrower logic changes.

## Find a manual capture

The Vite plugin calls `searchForWorkspaceRoot` and creates `<workspace>/_interim/annotations`. For this fixture that is the repository root, not `fixtures/app`. Each Git worktree has its own store. From the repository root, while or after the fixture runs:

```sh
node dist/pka.mjs --root . --json list --status all
node dist/pka.mjs --root . --json get <id>
```

Use the returned `annotation.dir` and attachment paths. A recording attachment points to its own `summary.md`; `manifest.json`, `timeline.jsonl`, `network.jsonl`, and `errors.json` are siblings. Read frame, video, and GIF paths from that manifest rather than assuming one fixed capture directory. [shared/recording.ts](../src/shared/recording.ts) owns the filenames and schemas. Explicit `--root .` avoids inherited `PKA_ROOT` or `CLAUDE_PROJECT_DIR` selecting another store.

## Finish a change

Run `pnpm verify` for lint, format checking, typechecking, unit tests, and package build. Run `pnpm fixture:smoke` for the browser integration paths above. Neither command builds Lean or another consumer: check production exclusion in the consumer's build workflow.

When behavior changes, update its DESIGN section and any affected README example in the same change. Keep examples in one place and link to them. Record the source, version/date, and validation level for external integrations; a checked schema does not prove an interactive session worked. Move dated migration instructions and runtime observations to integration history.
