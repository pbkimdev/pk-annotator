# pk-annotator reference

[README](../README.md) covers installation and first use. This page holds the options and behavior a consumer may need afterward. [DESIGN.md](DESIGN.md) is the full behavior contract.

## Package

`pk-annotator` is on the public npm registry. Releases through 0.5.0 were `@srv/pk-annotator` on the Forgejo registry; replace that name in imports and `package.json` when upgrading.

Install it in the workspace root so `node_modules/.bin/pka-mcp` resolves there. If pnpm's `minimumReleaseAge` is set, a fresh release is held back for that long; add `pk-annotator` to `minimumReleaseAgeExclude` to take it at once.

## Vite plugin

```ts
annotator({ bodies: ["/api/"], maxStoreBytes: 500_000_000, storeRoot: "../.." });
```

- `bodies` lists same-origin path prefixes whose JSON or text bodies are captured. Without it, requests are recorded without bodies.
- `maxStoreBytes` caps the store (default 500 MB); new video is refused above it.
- `storeRoot` moves the store to `<storeRoot>/_interim/annotations/`. A relative path resolves against the Vite root and must name an existing directory. Without it, the store is `_interim/annotations/` in the workspace root that Vite's `searchForWorkspaceRoot` finds from the Vite root. An app in `apps/ui` with its own `pnpm-workspace.yaml` uses `storeRoot: "../.."` to keep the store at the repository root, where `pka-mcp` finds it without `--root`.

The plugin runs only under `vite dev` and returns no plugins under Vitest, so tests need no exclusion.

## Overlay mount

`mount({ hot, theme })` returns `reactRootOptions`, `setTheme`, and `unmount`.

- Pass `reactRootOptions` to `createRoot` or `hydrateRoot` so React's caught, uncaught, and recoverable errors reach the Console panel.
- `setTheme("light" | "dark" | "system")` applies at once, including before the UI has loaded. Call it when the app's own theme setting loads or changes.
- Catch a failed import, as the README example does: a dev server can reload the page while the package is being reinstalled.
- Nothing mounts when `navigator.webdriver` is true, so Playwright and e2e runs see a clean page.
- Screenshots render through a `data:` SVG image, so a Content-Security-Policy must allow `img-src data: blob:`.
- The overlay needs no Trusted Types policy. Under a `style-src` that allows styles only with a nonce, publish the nonce as `<meta property="csp-nonce" nonce="…">`, which Vite's `html.cspNonce` writes; captures then raise no violation.

## Theming

The overlay uses shadcn variables, which you can override on the host element. Declarations on `pk-annotator` win over the overlay's defaults in both themes.

```css
pk-annotator {
  --primary: var(--app-accent);
  --pka-pick: var(--app-accent);
  --radius: 4px;
}
```

While a Claude Code or Codex session is connected, that agent's theme replaces these tokens; yours return when it disconnects.

## Marks and Send

Each Pick, Capture, and Annotate group shows its last-used tool and runs it on click; hover it to choose another. Pick and Capture tools open a Tiptap prompt editor; a finished drawing becomes a screenshot mark stacked for Send, without an editor. Save keeps a mark in this tab until reload or Exit. The Send entry lets you edit saved marks, add a global comment, and send one combined annotation. Settings switches the overlay between English and Korean; captured content keeps its original language. Exit lasts for the tab session until Alt+Shift+A.

## MCP server

`pka-mcp` is a stdio server with tools only: `list_annotations`, `get_annotation`, `wait_for_annotation`, `set_status`, `reply`, and `get_errors`. Launch it from `node_modules/.bin` directly; `pnpm exec` adds a second process.

It finds the store from `--root` or `PKA_ROOT`, then `CLAUDE_PROJECT_DIR`, then the nearest `_interim/annotations` above the working directory, and prints the store it uses to stderr. In a checkout with no store yet, tool calls report the missing store until the app's Vite dev server creates it, and then work without a restart.

Client files, if you prefer them to the commands in the README:

```jsonc
// .mcp.json (Claude Code)
{ "mcpServers": { "pka": { "command": "node_modules/.bin/pka-mcp" } } }
```

```toml
# ~/.codex/config.toml (Codex)
[mcp_servers.pka]
command = "/path/to/project/node_modules/.bin/pka-mcp"
args = ["--root", "/path/to/project"]
tool_timeout_sec = 1830 # above wait_for_annotation's longest timeoutSec, 1800
```

```jsonc
// .pi/mcp.json (Pi)
{ "mcpServers": { "pka": { "command": "node_modules/.bin/pka-mcp", "exposure": "direct" } } }
```

Codex stops a tool call after `tool_timeout_sec`, 300 seconds by default, and progress does not extend it. Pi 1.0.0's bundled MCP documentation and the [upstream tool-exposure reference](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/mcp.md#control-tool-exposure) support `"exposure": "direct"` (checked 2026-10-03); an interactive Pi session with this server has not been exercised.

`set_status acknowledged` claims an annotation for one `pka-mcp` process, which `claim.json` records. When that process has exited, for example after a client reconnect or restart, `wait_for_annotation` offers the annotation again, and another session may take it over with `set_status acknowledged`. A claim made from another PID namespace, such as a container, is judged only by the 60-second rule in the CLI section, which applies while the annotation is still pending.

## CLI

```text
pka list [--status pending|acknowledged|resolved|dismissed|all]   annotations, pending by default
pka get <id>                                                      prompt, elements, attachments
pka watch --once [--timeout SECONDS]                              wait for the next pending annotation
pka status <id> <acknowledged|resolved|dismissed> [--note TEXT]
pka reply <id> <text>                                             shown in the overlay
pka errors                                                        open error groups from the page
pka prune                                                         remove closed annotations older than 7 days
pka lab --url URL --flow ID                                       replay a recording against a production build
```

Every command takes `--json` and `--root DIR`. `pka status <id> acknowledged` claims an annotation as `$PKA_CLAIMANT` (default `pka-cli`); later status changes, replies, and `lab --attach` must use the same claimant. If a claimant stops before the acknowledge is written, another claimant may take over the claim once it is 60 seconds old and the annotation is still `pending`. A CLI claim names no process, so it is never released because its claimant exited; continue it from another shell with the same `$PKA_CLAIMANT`. `pka lab` needs Playwright; it writes `verdict.json` and exits 3 when the verdict fails a budget or is incomplete.

`get` and `list` default to `--detail concise`, which bounds the annotation view or list page to 20,000 UTF-8 bytes of JSON before operation and MCP envelopes.
A shortened `get` says what it left out, and a shortened `list` page ends with a cursor; `--detail full` returns everything.
`pka lab` takes its metrics from `--runs` untraced replays, then runs one diagnostic trace for insights that never changes a metric.
With `--attach`, it checks the annotation and claimant before the runs.

## Resource budget

Mount starts bounded capture and one resource-timing observer. Opening the hub's menu loads the UI; screenshots, drawings, recordings, and Send load snapdom when they capture; opening Perf starts its additional observers, and recording starts on request. `pka-mcp` holds no timers or watchers between calls. The dev-only integration excludes the package from production builds. [DESIGN.md](DESIGN.md#resource-budget) owns the detailed limits and lifecycle.
