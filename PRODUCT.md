# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated (Paul, 2026-10-03). The site in `site/` is a static Vite build with no UI framework, served by nginx, so the package's React and shadcn stack stays out of the page that markets it.

## Users

Developers who run coding agents (Claude Code, Codex, Pi) against a Vite app, and the teammates who review that app's dev build with them: designers, PMs, and QA who open the page, point at what is wrong, and want the change made without writing a ticket or reading source.

## Product Purpose

pk-annotator turns the running page into the place where change requests start. In a dev build, anyone can pick elements, draw, screenshot, or record, write a prompt, and send it. The coding agent receives the prompt together with source locations, the DOM description, console and network context, recordings, and performance data, and replies in the page. Success: a person who never opened the editor gets a precise change made by an agent from the browser.

## Positioning

The annotation carries the evidence an agent needs (React source file and line, selector, console errors, request bodies, recordings, performance verdicts) from a dev-only overlay that costs nothing in production and nothing while idle. It is its own MCP server and CLI over a local file store, so no cloud service, account, or browser extension sits between the page and the agent.

## Operating Context

- Runs under `vite dev` only; the Vite plugin adds source attributes and an HMR channel, and the overlay mounts from the client entry.
- Annotations are files under `_interim/annotations/` in the workspace; agents read them with `pka-mcp` (stdio MCP, tools only) or the `pka` CLI.
- Agents: Claude Code, Codex, Pi. When an agent connects, the overlay takes on that agent's look (Claude or Codex theme).
- Overlay languages: English and Korean.

## Capabilities and Constraints

- Pick: select (Shift for multiple), box, lasso. Capture: screenshot with crop, area GIF/WebM recording. Annotate: freehand, rectangle, circle. Debug: Console, Network, Performance.
- Tiptap prompt editor with inline element and attachment references, dictation, saved marks combined into one Send, Copy as Markdown, and a clipboard fallback when no agent is connected.
- MCP tools: `list_annotations`, `get_annotation`, `wait_for_annotation`, `set_status`, `reply`, `get_errors`. CLI adds `watch`, `prune`, and `lab` (production replay with budget verdicts, needs Playwright).
- Requirements: Node 24+, Vite 8, React 19. Dev-only: nothing ships in a production build, nothing mounts under `navigator.webdriver`.
- Distribution: public npm as `pk-annotator`, MIT (Paul, 2026-10-03). Releases through 0.5.0 were `@srv/pk-annotator` on the private Forgejo registry.

## Brand Commitments

- Name `pk-annotator`; commands `pka` and `pka-mcp`.
- The hub glyph: a core with three moons on a quarter orbit, a miniature of the radial menu (`src/overlay/launcher.ts`).

## Evidence on Hand

- The package itself and its fixture app (`fixtures/app`: picker examples, `/lab`, `/practice`, `/game`).
- No users, testimonials, benchmarks, download counts, or press exist. Do not invent them.

## Product Principles

1. The page is the interface: a request starts where the problem is visible.
2. Send evidence, not descriptions: source, state, and timing travel with every prompt.
3. Zero cost when unused: no production footprint, no idle work, bounded buffers.
4. Local and agent-agnostic: files and stdio, no service in between.

## Accessibility & Inclusion

Bilingual English and Korean. Keyboard operation and `prefers-reduced-motion` are part of the overlay's contract and the site must honor both.
