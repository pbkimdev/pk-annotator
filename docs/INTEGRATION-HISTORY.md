# Integration history

2026-10-03: the package was renamed `pk-annotator` and moved to the public npm registry; `@srv/pk-annotator` and the `@srv:registry` setup below apply only to releases through 0.5.0.

This is the design and migration plan recorded on 2026-10-02, with build evidence added through 2026-10-03. It preserves the original investigation; it is not a statement of current deployments or instructions to execute a migration. Paths under `apps/`, `scripts/verify`, Mantra, and Platform belong to those consumer repositories, not pk-annotator. Check the owning repository before using them.

Current package behavior is in [DESIGN.md](DESIGN.md), consumer setup is in [README.md](../README.md), and local development is in [DEVELOPING.md](DEVELOPING.md).

## Lean changes

```diff
 package.json                 # + @srv/pk-annotator (root devDependency, so node_modules/.bin/pka-mcp resolves)
                              # + pnpm.minimumReleaseAgeExclude: ["@srv/pk-annotator"]; .npmrc: @srv:registry
+.mcp.json                    # Claude Code: pka → node_modules/.bin/pka-mcp
+.codex/config.toml           # Codex: [mcp_servers.pka]
+.pi/mcp.json                 # Pi 1.0: pka, exposure "direct"
 AGENTS.md                    # + dev-only tooling in its own shadow root may use its own component library
 apps/web/
 ├── package.json             # - agentation 3.1.2, + @srv/pk-annotator
 ├── vite.config.ts           # + annotator({ bodies: ["/api/", "/ui-api/"] })
 └── src/
+    ├── client.tsx           # dev: mount({ hot: import.meta.hot }), then hydrateRoot(..., reactRootOptions)
+    ├── annotator-theme.css  # maps shadcn variables to --lean-* tokens
     ├── routes/__root.tsx    # - Agentation lazy import and <Agentation endpoint=…>
     └── styles.css:3310      # agentation-toolbar selector → pk-annotator host element
 apps/server/                 # dev-only Server-Timing middleware (handler, db, auth)
 apps/desktop/                # dev-only setDisplayMediaRequestHandler and debug port
 scripts/verify               # fail if a sentinel string appears in the production bundle
```

`pka-mcp` is launched from `node_modules/.bin` directly, not through `pnpm exec`, so each agent session costs one process instead of two.

The client entry, in the shape TanStack Start documents:

```tsx
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

let rootOptions = {};
if (import.meta.env.DEV) {
  const annotator = await import("@srv/pk-annotator/overlay");
  rootOptions = annotator.mount({ hot: import.meta.hot! }).reactRootOptions;
}
hydrateRoot(document, <StrictMode><StartClient /></StrictMode>, rootOptions);
```

The consumer passes `import.meta.hot` because a pre-bundled dependency has no HMR context of its own; the app's client entry does.

## Agentation removal

Order matters: each step leaves a working setup.

1. **Carry over open work.** The shared store holds 6 pending annotations, which are 3 unique Lean notes from 2026-09-28 (project row icon padding and focus outline, the "New project" button style, the location-bar command icon). Move them into the new store or file them as Lean issues.
2. **Lean** (with phase 1): `apps/web/package.json:50`, `apps/web/src/routes/__root.tsx:15-19, 72-76`, `apps/web/src/styles.css:3310`, lockfile regenerated.
3. **Mantra** (`~/projects/mantra`): `apps/ui/package.json:43`, `apps/ui/pnpm-workspace.yaml:6`, `apps/ui/src/agentationDev.tsx`, `apps/ui/src/main.tsx:23-25`, `dev.compose.yaml` agentation service and volume (Postgres stays), `dev.Dockerfile`, `Makefile` `annotate` targets and the `dev: annotate` dependency, `AGENTS.md:21-23`, `.mcp.json`, `.pi/mcp.json`, local `.claude/settings.local.json` `enabledMcpjsonServers`. The `migrate/server-go` worktree carries the same lines.
4. **Claude Code user config:** `claude mcp remove --scope user agentation`.
5. **Platform** (`~/srv/platform`), one commit: `services/archbox-agentation/`, `services/README.md:44-45`, `tests/contracts/archbox-agentation-contract.sh` together with `scripts/verify.sh:70`.
6. **Runtime:** stop the `archbox-agentation` container; remove the exited `mantra-dev-agentation-1` container and the `mantra-dev-agentation` image. Leave the `mantra-dev-agentation-run-*` bridge alone; it belongs to a live Mantra session and removes itself.
7. **Data, after Paul confirms:** volumes `archbox-agentation_store` and `mantra-dev_agentation-data`, `~/.agentation/store.db*`, `~/.local/share/archbox-agentation/`.

Left alone: logs, transcripts, backups, and browser history that mention Agentation; nothing reads them.

## Order of work

1. Store, ops, CLI, `pka-mcp`, source attributes, pick, Shift multi-select, marquee, composer. Lean switches and drops Agentation.
2. Core capture with Network and Console panels, Hunt, Clear, `get_errors`.
3. Recording: timeline, keyframes, opt-in video, Electron display-media handler.
4. Performance: live panel, then `pka lab` and Server-Timing in the API.
5. chrome-devtools-mcp page tools.
6. Mantra switches; Claude Code user entry removed; Platform service retired; data deleted after confirmation.

## Evidence and open questions

Confirmed on 2026-10-02:

- `npm view`: web-vitals 6.2.2, react-scan 0.5.7, bippy 0.7.3, chrome-devtools-mcp 1.10.1, @zumer/snapdom 3.2.0, @tanstack/devtools-bundler-core 0.1.3, @modelcontextprotocol/server 2.2.0 (zod ^4.2.0), @modelcontextprotocol/sdk 1.31.0, @earendil-works/pi-coding-agent 1.0.0.
- The MCP versioning page names 2026-07-28 as the current version. The 2026-07-28 changelog includes the stateless protocol, `server/discover`, and the Roots deprecation.
- The installed Agentation 3.1.2 bundle contains its source probe and marquee candidate list.
- Agentation's pending items show its weaknesses. Two different elements on `/projects` both report `projects-page.tsx:105:22` (a component definition, not the call site). Owner chains are full of framework internals. Every item is stored twice. About 70 KB of sessions come from e2e runs on `127.0.0.1:43129`.
- Docker shows `archbox-agentation` up and healthy and the Mantra bridge running. `~/.claude.json` holds the user-scope `agentation` entry.

Unconfirmed:

- Whether Codex reads project `.codex/config.toml` for MCP servers and shows the model both content channels.
- Cancellation support in Claude Code and Codex.
- Whether chrome-devtools-mcp 1.x attaches to Electron 44.
- Whether Element Capture works through Electron's display-media handler.

## Shadow-root spike

The deleted scratch spike used shadcn 4.21.1 (`init -t vite -b radix`), ai-elements 1.9.0 (`add prompt-input attachments`), Tailwind 4.3.3, and React 19.3.0. Playwright exercised a host page with hostile global CSS. Modal primitives moved the host by 8 px; outside-click dismissal needed no `composedPath()` fix. Its production build measured 1.65 kB gzip for the launcher and 135 kB gzip for the lazy UI chunk, including 9 kB CSS. These are spike measurements, not current package budgets or build sizes.

The source-attribute spike reproduced a hydration mismatch when stamping ran after source splitting. The resulting transform-order and shadow-root requirements remain in [DESIGN.md](DESIGN.md).

