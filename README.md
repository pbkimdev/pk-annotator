# pk-annotator

Point at your running app, say what should change, and your coding agent gets the request with the evidence: source file and line, selector, screenshot, console, network, recording, and performance.

[Website](https://pk-annotator.paulbkim.dev) · [한국어](README.ko.md) · MIT

pk-annotator is a dev-only overlay for Vite and React apps. Anyone reviewing the dev build can pick elements, draw, screenshot, or record, then write a prompt and press Send. The annotation lands in a local file store that Claude Code, Codex, or Pi read through the bundled `pka-mcp` server, and the agent's replies appear on the page. Nothing ships in a production build. While the overlay is closed, the page keeps bounded console, error, and network capture and, after this tab sends an annotation, follows its status and replies; the overlay UI and performance observers load when you use them.

## Install

Requires Node 24+, Vite 8, and React 19. Yarn 2+ also requires `nodeLinker: node-modules` in `.yarnrc.yml`; Plug’n’Play is not supported.

**Ask your agent.** Paste this into Claude Code, Codex, or Pi from the project root:

```text
Set up pk-annotator in this project by following https://pk-annotator.paulbkim.dev/agents.md
```

**Or run the installer** from the project root. It adds the dev dependency with your package manager and registers `pka-mcp` with Claude Code when `claude` is installed:

```sh
curl -fsSL https://pk-annotator.paulbkim.dev/install.sh | sh
```

Then add the plugin and mount the overlay as below. To install by hand instead, run `pnpm add -D pk-annotator` (or the npm, Yarn, or Bun equivalent) in the workspace root.

## Set up

```ts
// vite.config.ts
import { annotator } from "pk-annotator/vite";

export default defineConfig({
  plugins: [...annotator()],
});
```

```tsx
// client entry, before React renders
let rootOptions = {};
if (import.meta.env.DEV) {
  try {
    const { mount } = await import("pk-annotator/overlay");
    rootOptions = mount({ hot: import.meta.hot!, theme: "system" }).reactRootOptions;
  } catch (cause) {
    console.error("pk-annotator did not load; the page runs without it", cause);
  }
}
createRoot(document.getElementById("root")!, rootOptions).render(<App />);
// or: hydrateRoot(document, <App />, rootOptions);
```

Start the dev server and open the overlay with the launcher button or Alt+Shift+A. If the page sets a Content-Security-Policy, allow `img-src data: blob:` for screenshots.

## Connect an agent

Choose **Connect agent** in the overlay's menu. It copies a prompt with the exact `pka-mcp` command for this page; paste it into your agent session. To register by hand from the project root:

```sh
claude mcp add pka --scope project -- node_modules/.bin/pka-mcp      # Claude Code, .mcp.json
codex mcp add pka -- "$PWD/node_modules/.bin/pka-mcp" --root "$PWD"  # Codex, global
```

Codex keeps servers in its global config, so that entry points at one project. Also set `tool_timeout_sec = 1830` under `[mcp_servers.pka]` in `~/.codex/config.toml`, so a long `wait_for_annotation` is not cut off at the 300-second default. For Pi, add `{ "mcpServers": { "pka": { "command": "node_modules/.bin/pka-mcp", "exposure": "direct" } } }` to `.pi/mcp.json`.

The agent calls `wait_for_annotation`, claims what you send with `set_status`, answers with `reply`, and reads page errors with `get_errors`. While it is connected, the overlay takes on Claude's or Codex's look.

In Claude Code, each annotation can instead appear in the session the moment you send it. Start Claude Code with pka as a channel and confirm its prompt:

```sh
claude --dangerously-load-development-channels server:pka
```

Channels are a Claude Code research preview, and Team and Enterprise organizations must enable them. Annotations that were waiting before the session started are counted, not sent.

## Use

| Group    | Tools                                               |
| -------- | --------------------------------------------------- |
| Pick     | Select (Shift for several), Box, Lasso, Text        |
| Capture  | Screenshot with crop, area recording as GIF or WebM |
| Annotate | Freehand, Rectangle, Circle                         |
| Debug    | Console, Network, Performance                       |
| Settings | History, English/한국어, Exit                       |

Pick and Capture tools open the prompt editor; a finished drawing becomes a screenshot mark stacked for Send. Send at once, or Save marks and send them together. Text highlights the page text you select and sends it as a quote with its element, for fixing that exact wording. Element and capture badges in the text become `[element n]` and `[attachment n: label]` references for the agent. Without a connected agent, Send also copies the annotation as Markdown.

## CLI

```text
pka list | get <id> | watch --once | status <id> <state> | reply <id> <text> | errors | prune | lab
```

Every command takes `--json` and `--root DIR`; run `pka --help` for options. `pka lab` replays a recording against a production build and writes a performance verdict (needs Playwright).

## More

- [Reference](docs/REFERENCE.md): plugin options, theming, store location, claims, and the CLI in detail.
- [Design](docs/DESIGN.md): the behavior, resource budget, and security contract.
- [Developing](docs/DEVELOPING.md): working on pk-annotator itself.
