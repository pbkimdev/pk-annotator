# @srv/pk-annotator

A dev-only browser annotator for Vite apps. Pick elements, write a prompt, and send it, with source locations, screenshots, console, network, recordings, and performance, to a file store that coding agents read through MCP or the `pka` CLI. [docs/DESIGN.md](docs/DESIGN.md) is the behavior contract. [Developing](docs/DEVELOPING.md) maps tasks to code and explains the fixture and checks.

## Install

The package is published to the Forgejo npm registry.

```ini
# .npmrc
@srv:registry=https://git.paulbkim.dev/api/packages/srv/npm/
```

```sh
pnpm add -D @srv/pk-annotator
```

If you use pnpm's `minimumReleaseAge`, add `@srv/pk-annotator` to `minimumReleaseAgeExclude`. Install it in the workspace root so `node_modules/.bin/pka-mcp` resolves there. React 19 and Vite 8 are peer dependencies.

## Vite plugin

```ts
// vite.config.ts
import { annotator } from "@srv/pk-annotator/vite";

export default defineConfig({
  plugins: [...annotator({ bodies: ["/api/"] })],
});
```

The plugin runs only under `vite dev` and adds nothing under Vitest, which also serves through Vite, so tests need no exclusion. `bodies` lists same-origin path prefixes whose JSON or text bodies are captured; `maxStoreBytes` caps the store (default 500 MB). Annotations go to `_interim/annotations/` in the workspace root that Vite's `searchForWorkspaceRoot` finds from the Vite root. `storeRoot` moves the store to `<storeRoot>/_interim/annotations/`; a relative path resolves against the Vite root and must name an existing directory. An app in `apps/ui` with its own `pnpm-workspace.yaml` uses `annotator({ storeRoot: "../.." })` to keep the store at the repository root, where `pka-mcp` finds it without `--root`.

## Client mount

Mount from the client entry in development only, before React hydrates, and pass the returned root options to React:

```tsx
let rootOptions = {};
if (import.meta.env.DEV) {
  const { mount } = await import("@srv/pk-annotator/overlay");
  const annotator = mount({ hot: import.meta.hot!, theme: "system" });
  rootOptions = annotator.reactRootOptions;
  // When the app's own theme setting loads or changes:
  // annotator.setTheme("dark");
}
hydrateRoot(document, <App />, rootOptions);
```

`reactRootOptions` reports React's caught, uncaught, and recoverable errors to the Console panel. `setTheme("light" | "dark" | "system")` applies at once, including before the UI has loaded. Nothing mounts when `navigator.webdriver` is true, so Playwright and e2e runs see a clean page. Open the overlay with the launcher button or Alt+Shift+A.

The page's Content-Security-Policy must allow `img-src data: blob:`: screenshots render through a `data:` SVG image, which Chromium cannot export from a `blob:` URL.

## Theming

The overlay uses shadcn variables, which you can override on the host element:

```css
pk-annotator {
  --primary: var(--app-accent);
  --pka-pick: var(--app-accent);
  --radius: 4px;
}
```

Declarations on `pk-annotator` win over the overlay's defaults in both themes.

## Mark and send

Open the launcher, then use Pick (single, box, lasso), Capture (screenshot/crop or area GIF/video), or Annotate (rectangle, circle, freehand). Each opens a Tiptap prompt editor. Send immediately or Save a mark; Composer lets you edit saved marks, add a global comment, and send one combined annotation. Unsent marks stay in this tab until reload or Exit.

Debug groups Console, Network, and Performance. Settings holds History, English/Korean language, and Exit. Minimize keeps the launcher available.

## MCP

`pka-mcp` is a stdio server with tools only. Launch it from `node_modules/.bin` directly; `pnpm exec` adds a second process.

```jsonc
// .mcp.json (Claude Code)
{ "mcpServers": { "pka": { "command": "node_modules/.bin/pka-mcp" } } }
```

```toml
# .codex/config.toml (Codex)
[mcp_servers.pka]
command = "node_modules/.bin/pka-mcp"
```

```jsonc
// .pi/mcp.json (Pi)
{ "mcpServers": { "pka": { "command": "node_modules/.bin/pka-mcp", "exposure": "direct" } } }
```

Pi 1.0.0's bundled MCP documentation and the [upstream tool-exposure reference](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/mcp.md#control-tool-exposure) support `"exposure": "direct"` (checked 2026-10-03). This validates the configuration fields; an interactive Pi session with this server has not been exercised here.

The tools are `list_annotations`, `get_annotation`, `wait_for_annotation`, `set_status`, `reply`, and `get_errors`.

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

Every command takes `--json` and `--root DIR`. `pka status <id> acknowledged` claims an annotation as `$PKA_CLAIMANT` (default `pka-cli`); later status changes, replies, and `lab --attach` must use the same claimant. If a claimant stops before the acknowledge is written, another claimant may take over the claim once it is 60 seconds old and the annotation is still `pending`. `pka lab` needs Playwright; it writes `verdict.json` and exits 3 when the verdict fails a budget or is incomplete. Run `pka --help` for every option.

## Resource budget

Mount starts bounded capture and one resource-timing observer. Opening the hub's menu loads the UI; opening Perf starts its additional observers, and recording starts on request. `pka-mcp` holds no timers or watchers between calls. The dev-only integration above excludes the package from consumer production builds. [DESIGN.md](docs/DESIGN.md#resource-budget) owns the detailed limits and lifecycle.
