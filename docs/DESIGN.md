# pk-annotator: design

A standalone, dev-only, floating package that replaces Agentation (toolbar, server, and MCP registrations) everywhere Paul uses it. It covers element picking (click, Shift multi-select, box, lasso), prompt composition, flow recording, network and console inspection with error hunting, and a performance panel.

This document owns the current package contract. Start with [DEVELOPING.md](DEVELOPING.md) for task entry points, tests, and the fixture. Dated consumer migration plans and external runtime observations are in [INTEGRATION-HISTORY.md](INTEGRATION-HISTORY.md).

## Decisions (Paul, 2026-10-02)

1. **Capture is built in.** `core/` wraps fetch, XHR, console, and error events itself.
2. **Own MCP server.** `pka-mcp` is a stdio server over a per-project file store in `_interim/annotations/`.
3. **Tiptap edits prompts as blocks.** AI Elements supplies attachment chips alongside shadcn. The overlay keeps lucide icons; consumers map shadcn variables to their own tokens through a theme file.
4. **Home: `~/srv/pk-annotator`**, Forgejo `srv/pk-annotator`, published to the Forgejo npm registry as **`@srv/pk-annotator`** (`https://git.paulbkim.dev/api/packages/srv/npm/`). The scope is required because pnpm routes only scoped packages to a second registry. Consumers set `@srv:registry` in `.npmrc` and list the package in `pnpm.minimumReleaseAgeExclude`. Worktrees go at `~/.worktrees/pk-annotator/<branch>`.
5. **Replacement scope:** Lean, Mantra, the Claude Code user registration, and the Platform service. The historical migration plan is in [INTEGRATION-HISTORY.md](INTEGRATION-HISTORY.md#agentation-removal); current migration status belongs to each owning repository.
6. **Tools only, no idle cost.** The MCP server uses no resources, prompts, sampling, roots, or logging primitives. Nothing polls, and nothing holds memory beyond fixed caps when unused.

## Package layout

```text
pk-annotator/
├── src/
│   ├── shared/        # strict schemas for channel messages, stored data, recordings, verdicts
│   ├── lab/           # production flow replay, trace insights, budget verdicts
│   ├── core/          # in-page capture: console, errors, network, user actions; ring buffers, redaction, clear watermark
│   ├── select/        # hit testing, Shift toggle, marquee, selector and source resolution
│   ├── overlay/
│   │   ├── panels/        # Network, Console, Record, Perf; panel registration
│   │   ├── recording/     # recording lifecycle, keyframes, capture files
│   │   ├── perf/          # live observers, attribution, snapshots
│   │   ├── launcher.ts    # plain DOM button in a shadow root; loads the React UI on first open
│   │   ├── ui/            # shadcn primitives pulled by the registry
│   │   ├── ai-elements/   # prompt-input, attachments (ai-elements CLI)
│   │   └── shadow.css     # Tailwind adopted into the shadow root; @property registered on document
│   ├── vite/          # serve-only plugin: source attributes, HMR channel, symbolication, store writer and watcher
│   ├── store/         # file store: root discovery, id validation, atomic writes, claims, prune
│   ├── ops/           # operations shared by CLI and MCP: list, get, wait, set_status, reply, errors
│   ├── cli/           # pka: the same operations with --json; pka watch --once; pka lab; pka prune
│   └── mcp/           # pka-mcp: stdio, tools only, thin wrapper over ops
├── fixtures/
│   ├── app/           # TanStack SSR fixture: picker examples, /lab, API routes
│   └── smoke.ts       # browser → annotation store → CLI integration check
├── tools/oxlint/      # vendored anti-slop rules
├── tsdown.config.ts   # entry points, shadow CSS compilation, fetch/observer injection
├── components.json    # shadcn config
└── package.json       # exports ./vite and ./overlay; bins pka, pka-mcp
```

Tests sit beside the code they exercise as `*.test.ts`. [DEVELOPING.md](DEVELOPING.md#task-map) links each task to its implementation, schema, and check. The agent skill that teaches `pka` lives in pkai, per Paul's rule that skills go there.

## Public API

```ts
// @srv/pk-annotator/vite
type AnnotatorOptions = {
  bodies?: string[];        // same-origin path prefixes whose JSON or text bodies are captured
  maxStoreBytes?: number;   // store size cap; new video is refused above it (default 500 MB)
  storeRoot?: string;       // directory that holds _interim/annotations, relative to Vite's root or absolute (default: Vite's workspace root)
};
function annotator(options?: AnnotatorOptions): Plugin[];   // [] under Vitest

// @srv/pk-annotator/overlay
type ThemeSetting = "light" | "dark" | "system";
type MountOptions = {
  hot: ViteHotContext;                    // the consumer's import.meta.hot
  theme?: ThemeSetting;                   // initial theme; "system" follows prefers-color-scheme (default)
};
type Mounted = {
  reactRootOptions: Pick<HydrationOptions, "onCaughtError" | "onUncaughtError" | "onRecoverableError">;
  setTheme(theme: ThemeSetting): void;    // applies at once to the launcher and, once loaded, the UI
  unmount(): void;
};
function mount(options: MountOptions): Mounted;
```

The theme sets `data-theme` on the host element and `.dark` on `.pka-root`. A consumer whose theme setting loads after mount calls `setTheme` when it loads and whenever it changes. The launcher keeps the setting, so a call made before the UI chunk loads still applies when the UI opens.

The consumer passes `import.meta.hot` because a pre-bundled dependency has no HMR context of its own; the app's client entry does. Consumer-specific proxy setup is recorded in [INTEGRATION-HISTORY.md](INTEGRATION-HISTORY.md#lean-changes).

## Overlay component tree

```tsx
<pk-annotator> shadow root, a child of <html>
  launcher.ts  the hub: plain DOM button with an error badge; draggable, snaps to a corner; no React until first open
  <PickLayer>  takes pointer events only while picking
    <HoverBox> component name + file:line
    <SelectionBox n> numbered tab outside the element's box, so it never covers the element
    <MarqueeRect> | <LassoPolygon>
  <MarkLayer>  cropped screenshot, recording region, rectangle, circle, freehand
  <Panel>  one open at a time, beside the hub
    <RecordPanel> | <NetworkPanel> | <ConsolePanel> | <PerfPanel>
    <Composer>  lazily loaded Tiptap block editor
      <ElementChips>     one per selected element, removable; details open beside the panel
      <AttachmentChips>  recording, error groups, requests, perf snapshot
      <PromptEditor> + Copy (Markdown) / Save / Send
    <Composer batch> saved marks, editing, global comment, Send all
    <Thread>  History: agent replies and status for annotations sent from this tab
  <RadialMenu>  React, loaded on first open; rings of named menu items around the hub
    Pick ▸ · Capture ▸ · Annotate ▸ · Debug ▸ · Composer · Settings ▸
```

The hub sits 20 px from its corner. Clicking it opens the radial menu; the hub's glyph, three moons on a quarter orbit, previews the quadrant the menu opens into. The first ring sweeps counterclockwise through the quadrant that faces the page, with angles measured counterclockwise from the positive x axis: 0° to 90° from bottom-left, 90° to 180° from bottom-right, 180° to 270° from top-right, and 270° to 360° from top-left. A stem grows out of the hub along the first angle, then a band draws along the ring and its items land on it in sweep order. Hovering or choosing a group grows a short stem out of the group and sweeps its items out the same way on a second, concentric ring, from the group counterclockwise, or clockwise where the quadrant ends first, so the ring grows out of its group; a ring too long for either side is pulled back inside the quadrant. An SVG filter blurs and thresholds the hub's disk, stems, and bands into one shape, so the joins round off and one edge and shadow surround the whole menu; the shape is hidden, and the filter idle, while the menu is closed. Leaving one group for another waits 140 ms, so a pointer crossing a neighbor on its way outward keeps the open group. Choosing an item closes the menu, which retracts in reverse; Language switches in place and keeps it open. A click outside the menu only closes it. The hub shows the pick accent while picking or drawing and a pulsing core while recording.

The menu follows the ARIA menu pattern. Enter or Space on the hub opens it with focus on the first item; Up and Down move within a ring, Home and End jump to its ends, Right opens a group and Left or Escape returns to it, and Escape on the first ring closes the menu and returns focus to the hub. Tab leaves the menu and closes it. Toggles such as pick modes, drawing tools, and panels are checkbox items. Arrow keys on the focused hub move it to another corner. Escape and Enter inside any menu, including a panel's, never reach picking.

Picking or capturing opens the prompt editor immediately. Enter creates a block; Ctrl/Cmd+Enter sends. The editor supports headings, lists, quotes, code blocks, and inline formatting. A mark can be sent immediately or saved in this tab. Saved marks retain their prompts, elements, and capture snapshots while the overlay is minimized; reload or Exit discards unsent marks. Composer edits these marks and an optional global comment. Send all creates one annotation with numbered mark sections and one deduplicated element list. Capture paths are unique per attachment, so multiple recordings cannot overwrite each other.

Pick groups Single, Box, and Lasso. Capture groups Record, Screenshot, Crop screenshot, and Recording area. Annotate groups Rectangle, Circle, and Freehand. Debug groups Console, Network, and Performance. Settings groups History, English/Korean language, Minimize, and Exit. A group is marked while one of its tools or panels is active, and so are the active item and Composer while its panel is open. The mark is the `--pka-pick` color and tint, never `--accent` alone, because a consumer's selected surface can sit within 1.2:1 of the menu. For the same reason, hover, keyboard focus, and an open group draw a 1.5 px inset edge mixed 55% from `--popover-foreground` into the menu surface, which keeps at least 3:1 against it; the `--accent` fill and keyboard focus's `--ring` outline remain as consumer-themed cues on top. Minimize hides panels and selection outlines and keeps the hub; Exit unmounts the overlay and stops capture. Language is stored on the origin; captured content and prompts retain their original language.

## Data flow

```mermaid
flowchart LR
  subgraph Page["Browser or Electron (:3000)"]
    Core["core: console, errors, network, actions"]
    UI["overlay: pick, box, record, panels, composer"]
    Core --> UI
  end
  UI -- "import.meta.hot.send" --> Plugin["Vite plugin: symbolicate, redact, write, watch"]
  Plugin --> Store[("_interim/annotations/")]
  Store -- "status, replies" --> Plugin
  Plugin -- "server.ws.send" --> UI
  MCP["pka-mcp (stdio)"] <--> Store
  CLI["pka (CLI)"] <--> Store
  Agent["Claude Code / Codex / Pi"] <-- "MCP tools" --> MCP
  Agent -- "Bash / Monitor" --> CLI
  Agent -. "chrome-devtools-mcp" .-> Page
```

The store is the only shared state. The plugin writes annotations and the live error snapshot; `pka-mcp` and `pka` write status changes and replies through the same `ops/` code; the plugin watches the store and pushes changes to the overlay.

## Resource budget

Nothing runs that you are not using, and production carries zero bytes.

| Piece | Idle (menu closed, not recording) | In use |
|---|---|---|
| Launcher | One DOM button in a shadow root; React, AI Elements, and Tailwind not loaded | UI chunk loads on first open by dynamic import |
| Console and errors | Wrappers append to fixed ring buffers (500 entries). Arguments are serialized at capture time with depth and length caps, so the buffer never holds app objects. An error group that is new, recurs, or changes status is sent to the plugin for the live error snapshot, at most once per second; the timer exists only while a group waits | Panels subscribe to the in-page buffers and read them directly. A recording copies each new entry through a tap, so the ring cap cannot drop it. Nothing else reaches the plugin until you send an annotation |
| Network | Request metadata only, same ring-buffer cap. One PerformanceObserver for `resource` entries keeps the timings of up to 500 fetch and XHR requests, so Server-Timing and transfer sizes survive a full resource timing buffer (Chromium holds 250 entries, and a Vite dev page fills it with module scripts). Its callback runs only when a request completes, it never resizes or reads the page's buffer, and stopping the capture disconnects it. Bodies are captured only for allowlisted same-origin paths, 64 KB each, 8 MB total. A JSON response without Content-Length is read from a clone until it ends or passes 64 KB, when the clone is cancelled. Event streams, NDJSON, and other streaming types are never cloned; only open, close, and byte count are recorded. The overlay's own requests (source maps for symbolication, images and fonts snapdom inlines) use the unwrapped fetch and are never recorded | Same |
| Performance | No observers beyond the Network one. Opening the Perf panel starts PerformanceObserver with `buffered: true`, which still returns LCP, CLS, and earlier long animation frames | `react-scan/lite` runs only while the Perf panel is open |
| Recording | Off | Keyframes only at actions, navigations, and errors (one per error group). GIF/video are opt-in; frame callbacks run only during recording. GIF encoding loads on demand, with at most 120 frames, a 480 px longest edge and 32 MB. WebM is capped at 256 MB and a 1920 px longest edge |
| Saved marks | At most 50 marks and 256 MB of saved captures; no timers | Each Save freezes attachment data. A current mark holds at most 50 pasted/drawn image captures |
| Automation | Nothing mounts when `navigator.webdriver` is true (Playwright, e2e runs) | n/a |
| Vite plugin | One `fs.watch` on the store root plus one per open annotation's directory; source transform runs only under `serve`. Under Vitest (`process.env.VITEST`) `annotator()` returns no plugins | Writes on events only |
| pka-mcp | Not running until a client spawns it. Between calls it holds no timers or watchers. It exits on stdin EOF | `wait_for_annotation` holds one inotify watcher for its bounded duration, then closes it |
| pka CLI | No process | `pka watch --once` exists only while waiting |
| Store | `pka prune` removes resolved and dismissed annotations older than 7 days; new video is refused above a size cap (default 500 MB) | n/a |
| Production | Absent from a consumer production build: serve-only plugins and the consumer's `import.meta.env.DEV` import guard enforce the boundary. Verify the consumer bundle in its own build check | n/a |

The one standing cost is MCP itself: each agent session keeps one idle Node process alive for its lifetime. Using only the CLI avoids even that.

The numeric caps are starting defaults to tune. This repo's `pnpm verify` checks the package; it does not build consumer applications. Consumer checks belong to the owning repositories.

## MCP server

`pka-mcp` targets the current specification, **2026-07-28**, through `@modelcontextprotocol/server` 2.2.0 and `serveStdio`. The SDK also serves clients that still use the older `initialize` handshake, which today is all three: Claude Code by default, Codex 0.160, and Pi 1.0 (2025-11-25).

It uses tools and nothing else. Resources and prompts are not used. Roots, sampling, and logging are deprecated in 2026-07-28 and not used. Tasks is now an extension that none of the three clients supports. Logs go to stderr; stdout carries only JSON-RPC.

| Tool | Returns | Annotations |
|---|---|---|
| `list_annotations(status?, limit, cursor, detail)` | pending by default; cursor pagination | readOnlyHint |
| `get_annotation(id, detail)` | prompt, elements, attachments with file paths and summaries (recording, error groups, perf verdict) | readOnlyHint |
| `wait_for_annotation(timeoutSec = 50, max 1800)` | the oldest pending annotation without a claim or with an orphaned one (see Lifecycle), immediately if one exists, otherwise the first to arrive; `{ timedOut: true }` as a normal result | readOnlyHint |
| `set_status(id, status, note?)` | `acknowledged` creates `claim.json` with `O_EXCL`; `resolved` and `dismissed` append a status event | destructiveHint false, idempotentHint true |
| `reply(id, text)` | appended to `thread.jsonl`, shown in the overlay | destructiveHint false, idempotentHint false |
| `get_errors(since?, limit, detail)` | open error groups from the live snapshot | readOnlyHint |

All tools set `openWorldHint: false`. Input schemas are Zod `strictObject`, which the SDK turns into `additionalProperties: false`; a validation failure returns `isError` and the handler never runs. Every tool returns `structuredContent` and the same JSON as text, because Claude Code passes only `structuredContent` to the model when both are present. Read tools declare `outputSchema`. Errors say what to do next, for example "No annotation `x`; call list_annotations".

**Lifecycle.** `pending → acknowledged → resolved | dismissed`. Acknowledging claims the annotation: later status changes, agent replies, and attachments must come from the same claimant, which is `<client name>:<pid>` for an MCP session and `$PKA_CLAIMANT` (default `pka-cli`) for the CLI, whose shell calls are separate processes. A claim older than 60 seconds on an annotation that is still `pending` was left by a claimant that stopped between the claim and the state write: `wait_for_annotation` offers that annotation again, and another claimant may replace the claim. A takeover lock per orphaned claim lets one caller at a time remove it, and only after rereading `state.json` and `claim.json` shows the annotation still `pending` and the same claim, so one of several concurrent claimants wins and a newer claim is never removed. After winning, the replacing claimant reads `state.json` again; if the stalled claimant has acknowledged meanwhile, it puts the old claim back with one rename and fails as claimed. The stalled claimant's state write is unconditional, so one window remains: if it lands after that last read of `state.json`, one of the two acknowledge events is overwritten, and `claim.json` names the replacing claimant or, when an ordinary claimant raced the takeover and then backed off, no claimant at all. In the first case the stalled claimant's next write fails as claimed; in the second, any session may write. Resolved and dismissed are final for agents: `reply` and `set_status` on a closed annotation fail and tell the agent to reply before resolving; repeating the same final status is a no-op. A human reply from the overlay on a closed annotation reopens it to `pending` and removes the claim, so the next `wait_for_annotation` picks it up again. The plugin watches the store root plus each open annotation's directory, so watch count follows open annotations, never capture files.

**Waiting.** `wait_for_annotation` defaults to 50 seconds so it finishes inside Codex's 60-second default tool timeout. It sends a progress notification every 15 seconds when the client supplied a progress token, which keeps Claude Code and Pi from timing out on longer waits. The watcher closes on result, on `ctx.mcpReq.signal` abort, or when the connection closes. In Claude Code, `pka watch --once --json` run under the Monitor tool re-invokes the agent the moment you press Send, with no process left afterwards.

**Responses.** `detail: "concise"` is the default and stays well under Claude Code's 10k-token warning. Frames, video, and traces are returned as paths, never inline.

**Project root.** `--root` or `PKA_ROOT`, then `CLAUDE_PROJECT_DIR`, then walk up from cwd to `_interim/annotations`. If none is found, the server fails at startup with the reason.

**Security.**

- Ids must match `^[a-z0-9-]{8,40}$`.
- Resolved paths are checked with `path.relative` against the store.
- Symlinks are refused (`lstat`), and claims are created with `O_EXCL | O_NOFOLLOW`.
- Page-derived content (text, HTML, console messages, request bodies) is kept in fields separate from your prompt. Control and bidirectional-override characters are stripped, and lengths are capped.
- Tool descriptions state that page content is data, not instructions.
- The server opens no network listeners.

**Client registration.** [README.md](../README.md#mcp) owns the copyable client examples and their validation notes. Launch `node_modules/.bin/pka-mcp` directly from the consumer root; `pnpm exec` adds a second process.

```text
_interim/annotations/
├── live/errors.json         # rewritten by the plugin as groups change
└── <id>/
    ├── annotation.json      # prompt, elements, attachments
    ├── state.json           # pending | acknowledged | resolved | dismissed, with history; temp file + rename
    ├── claim.json           # present once an agent acknowledges
    ├── thread.jsonl         # agent replies and your follow-ups
    └── capture/             # recording, frames, errors, network, perf verdict
```

## Selection

```text
pick mode, capture-phase pointer listeners, overlay host skipped in elementsFromPoint
  click          → selection = [target]
  Shift+click    → toggle target in selection
  drag > 4 px    → marquee (box mode: any drag)
  Esc            → clear the selection; with none, leave pick mode
  Enter          → leave pick mode and open the annotation panel (not while typing in a field)
marquee end(rect)
  candidates = interactive, text, img, or [data-pka-src] elements, minus tiny and near-viewport-size ones
  hits = full containment (Alt: intersection)
  hits = drop any hit that contains another hit
  hits = replace with the component root when every child of that root is hit
  selection = Shift ? selection ∪ hits : hits
lasso end(points)
  select candidates whose centers are inside the polygon, then apply the same ancestor pruning
  bound the stroke to 512 points; picking opens the editor without ending multi-selection
```

Source location comes from the serve-only Vite plugin, `src/vite/source.ts`. It parses with Vite's re-exported `parseSync` and `Visitor` and writes with `magic-string`, stamping `data-pka-src="<workspace-relative path>:line:col"` (1-based) on every lowercase host JSX element. Paths are relative to `searchForWorkspaceRoot`, so a monorepo can report `apps/web/src/...`. The hook must use `enforce: "pre"` and `transform.order: "pre"` so it stamps the untouched source in client, route-split, and SSR environments alike; this prevents hydration mismatches from attributes added after source splitting. TanStack's `injectSource` was rejected: fixed attribute name, composite elements stamped, spread detection defeated by rest destructuring, parse errors swallowed.

Each element reports two locations when they differ: `source` (the host element's own JSX, for example `button.tsx:4:10` inside a `Button` wrapper) and `usedAt` (the nearest user-code owner's call site, for example `index.tsx:20:6`, from bippy `getSource(ownerFiber)`). Elements without the attribute (Radix content, portals, `node_modules`) fall back to bippy 0.7.3: walk `getRawOwnerStack(fiber)`, take the first frame under the project and outside `node_modules`, and symbolicate it. bippy columns are 0-based (add 1) and file names are basenames (resolve with `new URL(source, frameUrl)`). A cold lookup costs about 300 ms while source maps load, so pick mode pre-warms it. Owner chains drop every frame whose URL contains `/node_modules/`, which removes `SafeFragment`, `MatchInnerImpl`, `Lazy`, `Primitive.*`, and the like, while keeping user components such as `RootDocument`.

In React Bench, tools that sent `file:line` let the agent find the right file 95 to 96% of the time; tools that sent only a component name scored 86%, the same as no tool.

## What the agent receives

```xml
<annotation id="a-17" route="/projects/abc" viewport="1440x900@2">
<prompt>Archive should confirm first; the row below jumps when this one leaves.</prompt>
<element n="1" source="apps/web/src/ui/button.tsx:4:10" usedAt="apps/web/src/project-row.tsx:48:7" owners="ProjectRow > ProjectList"
         role="button" name="Archive project" crop="capture/frames/sel-1.webp"/>
<capture>_interim/annotations/a-17/capture/summary.md</capture>
</annotation>
```

Per element, in order of how much it changes agent results: call-site `file:line:col`, owner component chain, the comment, selector (role and accessible name, test id, CSS), trimmed `outerHTML`, bounding box with viewport and scroll, route, cropped screenshot path. Computed styles only for style requests.

## Error hunting and clearing

```text
on window error (capture phase) | unhandledrejection | console.error | React root handlers
  stack = symbolicate(raw)                         # plugin, via module-graph source maps
  fp    = type + normalized message + top 3 in-app frames as path:fn (no line, so an edit above the throw keeps the group)
  group[fp]: count, firstSeen, lastSeen, lastSeq
Hunt(one group) / Hunt all
  attach the error, owner stack, and the actions and requests in the 20 s before first occurrence
  write an annotation; mark each group "sent"
Clear
  watermark = seq; a group that recurs after the watermark reopens
after the agent resolves and HMR reloads
  not seen again → "cleared"; seen again → reopened with the new stack
```

## Recording

A recording defaults to an event timeline with keyframes. Independent GIF and Video toggles add either or both formats from one tab-sharing request. The chosen rectangular viewport region applies to keyframes and both media formats. Agents use named actions far better than video: Jam had to add frame-extraction tools before agents could use its recordings.

```text
capture/attachments/<n>/capture/
├── summary.md       # about 2 KB; the agent reads this first
├── manifest.json    # URL, viewport, git SHA, times, redaction policy
├── timeline.jsonl   # actions, navigations, console, errors, requests, joined by seq and traceparent
├── network.jsonl    # redacted, HAR-like
├── errors.json      # deduplicated groups
├── frames/NNN.webp  # snapdom keyframe at each action, navigation, error
├── video.webm       # opt-in: getDisplayMedia + Element Capture restricted to body, then cropped
└── animation.gif    # opt-in GIF of the same region
```

Each recording attachment points to its own summary; the manifest, timeline, network, and errors files are siblings. `capture/summary.md` links all attachments. The plugin stamps every recording manifest. The lab replays the first recording attachment.

Redaction happens in the page: keyframe inputs are masked, auth and cookie headers dropped, bodies kept only for allowlisted same-origin API paths, and storage never read. Video and GIF pixels are not redacted; the capture controls say so.

**Overlay exclusion.** The video is restricted to body, and the `<pk-annotator>` host is a child of `<html>` from mount on, so the video never contains the overlay. This placement is safe when a consumer hydrates the whole document. React 19 starts hydrating a document at body's first child and resolves html, head, and body by reference, so it never visits another child of `<html>` (react-dom 19.3.0, `beginWork` for the root and for host singletons). It also skips, without an error, an unexpected element that is a direct child of head or body. In the fixture on 2026-10-03, neither placement produced a hydration error in at least 60 loads each. Those loads covered fresh contexts, 4x and 6x CPU throttling, a cold Vite dependency cache, navigation between `/` and `/lab`, reloads with the overlay open, and clicks before hydration ended. An injected mismatch was reported every time.

**Content Security Policy.** Keyframes and selection crops come from snapdom, which renders the page as an SVG `<foreignObject>` image and draws it into a canvas. Chromium lets such a canvas be exported only when the image loads from a `data:` URL. Loaded from a `blob:` URL, the image taints the canvas and `toBlob` throws; `createImageBitmap` cannot decode it, and `OffscreenCanvas` is tainted the same way (probed in Playwright 1.63 Chromium on 2026-10-03). A page CSP must therefore allow `img-src data:`, and `blob:` for images pasted into the composer. Without `data:`, sending fails with an error that names the CSP. The fixture's dev server sends `img-src 'self' blob: data:` so that this minimum stays tested.

## Performance

| Live in the overlay (dev build, labeled as such) | Lab run (`pka lab`, production build) |
|---|---|
| web-vitals 6.2.2 attribution with soft navigations: LCP subparts, INP breakdown with element, CLS culprit | The recorded flow replayed N times at 4x CPU and Slow 4G |
| Long animation frames, top N by blocking time, grouped by script and function, layout thrashing flagged | Chrome DevTools trace insights (LCPBreakdown, INPBreakdown, ForcedReflow, RenderBlocking) |
| Slow requests with the `Server-Timing` breakdown, joined to the interaction that caused them | `react-dom/profiling` render tracks |
| `react-scan/lite` render hot spots with file:line and changed props | Verdict JSON: value, budget, pass/fail, culprit, conditions, noise band, trace path |

The overlay names suspects; pass/fail claims come only from lab verdicts on production builds.

## AI Elements inside the shadow root

The overlay follows these isolation and integration rules. The original investigation is recorded in [INTEGRATION-HISTORY.md](INTEGRATION-HISTORY.md#shadow-root-spike).

1. **Stylesheet.** Import the compiled CSS with `?inline`, build one `CSSStyleSheet`, and adopt it into the shadow root. shadcn variables live on `:host`; base `html`/`body` rules move to `.pka-root`. `:host { all: initial !important; position: fixed !important; inset: 0 auto auto 0 !important; z-index: 2147483647 !important }` stops inherited host styles. Fonts declared with `@font-face` inside a shadow root do not load; use system fonts or declare faces on `document`.
2. **rem.** A PostCSS step rewrites `Nrem` to `N*16px` in the overlay stylesheet, so a host `html { font-size }` cannot resize the overlay.
3. **`@property`.** Collect the sheet's `CSSPropertyRule`s and adopt them once on `document`.
4. **Focus.** Radix Select and Menu compare `document.activeElement`, which is retargeted to the host element. While mounted, an instance getter on `document` returns `shadow.activeElement` only when the native value is our host; unmount removes it.
5. **Portals.** A context supplies a portal container inside the shadow root, a sibling of the app root, to every shadcn portal.
6. **Stacking.** The host is the only stacking context; the menu and the hub carry no z-index, so portal content stacks above them. The hub follows the app root in the shadow root, so it stays clickable above the pick and drawing layers.
7. **No modal primitives.** Modal Select, Dialog, and DropdownMenu lock host scrolling, set `pointer-events: none` on `body`, and put `aria-hidden` on host elements. Use non-modal variants only: `modal={false}` menus, and a non-modal menu or popover in place of Select (including editor block controls).
8. **Theming.** Consumers theme through custom properties on the host element (`pk-annotator { --primary: var(--app-accent); --radius: 4px; }`), which beat `:host` and inherit across the boundary. Dark mode needs `data-theme="dark"` on the host, which switches the `:host` variables, and a `.dark` class on `.pka-root` for Tailwind's dark variant; the `theme` option and `setTheme` set both (see Public API).

## Sources

- MCP versioning and 2026-07-28 changelog: https://modelcontextprotocol.io/specification/versioning, https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP TypeScript SDK v2 tools and stdio: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html, https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html
- MCP security best practices: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Codex MCP: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Writing tools for agents (Anthropic): https://www.anthropic.com/engineering/writing-tools-for-agents
- agent-browser (CLI and MCP over one operation layer): https://github.com/vercel-labs/agent-browser
- Agentation schema, API, MCP: https://www.agentation.com/schema, https://www.agentation.com/api, https://www.agentation.com/mcp
- react-grab and React Bench: https://github.com/aidenybai/react-grab, https://github.com/millionco/react-grab-bench
- Cursor Design Mode: https://cursor.com/docs/agent/design-mode
- TanStack Devtools Vite plugin: https://tanstack.com/devtools/latest/docs/vite-plugin
- TanStack Start client entry: https://tanstack.com/start/latest/docs/framework/react/guide/client-entry-point
- React `hydrateRoot` and `captureOwnerStack`: https://react.dev/reference/react-dom/client/hydrateRoot, https://react.dev/reference/react/captureOwnerStack
- AI Elements: https://elements.ai-sdk.dev/, https://elements.ai-sdk.dev/docs/setup
- Tailwind 4 `@property` in shadow roots: https://github.com/tailwindlabs/tailwindcss/issues/15005
- Playwright locators: https://playwright.dev/docs/locators
- Element Capture: https://developer.chrome.com/docs/web-platform/element-capture
- Electron session: https://www.electronjs.org/docs/latest/api/session
- Jam MCP: https://jam.dev/docs/debug-a-jam/mcp
- Sentry grouping and replay privacy: https://docs.sentry.io/concepts/data-management/event-grouping/, https://docs.sentry.io/platforms/javascript/session-replay/configuration/
- chrome-devtools-mcp tools and third-party tools: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md, https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/third-party-developer-tools.md
- Vite plugin API: https://vite.dev/guide/api-plugin
- web-vitals: https://github.com/GoogleChrome/web-vitals
- Long animation frames: https://developer.chrome.com/docs/web-platform/long-animation-frames
- React Scan: https://github.com/aidenybai/react-scan
- Lighthouse user flows: https://github.com/GoogleChrome/lighthouse/blob/main/docs/user-flows.md
- DevTools throttling accuracy: https://3perf.com/blog/chrome-throttling/
