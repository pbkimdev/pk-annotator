import type { AgentKind } from "../shared/agent.ts";

// Inline SVG for the agent themes, authored for this overlay. The logos take their colors
// from agent-theme.ts; the mascots carry their own, so the thread can show them without it.

const RAYS = [
  "M11.65 12L10.85 2.15A1.15 1.15 0 0 1 13.15 2.15L12.35 12Z",
  "M11.71 11.8L14.65 6.01A1.15 1.15 0 0 1 16.56 7.3L12.29 12.2Z",
  "M11.81 11.71L18.96 6.11A1.15 1.15 0 0 1 20.22 8.04L12.19 12.29Z",
  "M12.01 11.65L19.29 11.1A1.15 1.15 0 0 1 19.21 13.4L11.99 12.35Z",
  "M12.16 11.69L21.41 15.7A1.15 1.15 0 0 1 20.33 17.73L11.84 12.31Z",
  "M12.31 11.84L15.86 17.05A1.15 1.15 0 0 1 13.81 18.09L11.69 12.16Z",
  "M12.35 12L13.15 20.65A1.15 1.15 0 0 1 10.85 20.65L11.65 12Z",
  "M12.31 12.15L9.68 19.38A1.15 1.15 0 0 1 7.61 18.37L11.69 11.85Z",
  "M12.16 12.31L3.93 17.59A1.15 1.15 0 0 1 2.85 15.56L11.84 11.69Z",
  "M12.01 12.35L5.37 13.27A1.15 1.15 0 0 1 5.33 10.97L11.99 11.65Z",
  "M11.81 12.29L3.62 7.93A1.15 1.15 0 0 1 4.87 6L12.19 11.71Z",
  "M11.7 12.19L7.34 6.72A1.15 1.15 0 0 1 9.29 5.5L12.3 11.81Z",
];

/** The Claude starburst: twelve tapered rays of uneven length. Each ray carries its index for staggered motion. */
export const CLAUDE_LOGO =
  '<svg class="pka-agent-logo" data-kind="claude" viewBox="0 0 24 24" aria-hidden="true">' +
  RAYS.map((d, index) => `<path data-part="ray" style="--i:${index}" d="${d}"/>`).join("") +
  "</svg>";

// Six capsules in a pinwheel around a hexagonal opening; each is drawn over a gap stroke in
// the surface color, so crossings read as an interlaced knot. The first capsule is drawn
// again inside a wedge so it passes over the last one, as the others pass over their neighbor.
const LINK = 'x="14.2" y="4" width="4.6" height="11.57" rx="2.3"';
const link = (turn: number) =>
  `<g data-part="link" style="--i:${turn}" transform="rotate(${turn * 60} 12 12)">` +
  `<rect data-part="gap" ${LINK}/><rect data-part="ink" ${LINK}/></g>`;

/** The OpenAI knot, which Codex carries. */
export const CODEX_LOGO =
  '<svg class="pka-agent-logo" data-kind="codex" viewBox="0 0 24 24" aria-hidden="true">' +
  '<defs><clipPath id="pka-knot-wedge"><path d="M12 12L12 32L2 29.32L-5.32 22Z"/></clipPath></defs>' +
  [0, 1, 2, 3, 4, 5].map(link).join("") +
  `<g clip-path="url(#pka-knot-wedge)">${link(0)}</g>` +
  "</svg>";

// Clawd, Claude Code's crab, from its block-character banner: each terminal quadrant is one
// pixel, twice as tall as wide. Arms and the two leg pairs are separate parts so they can move.
const px = (x: number, y: number, w: number) =>
  `<rect x="${x}" y="${y * 2}" width="${w}" height="2"/>`;

export const CLAWD =
  '<svg class="pka-mascot-art" data-kind="claude" viewBox="0 0 18 10" fill="#d97757" shape-rendering="crispEdges" aria-hidden="true">' +
  `<g data-part="body">${px(3, 0, 12)}${px(3, 1, 2)}${px(6, 1, 6)}${px(13, 1, 2)}${px(3, 2, 12)}${px(3, 3, 12)}</g>` +
  `<g data-part="eyes" fill="#141413">${px(5, 1, 1)}${px(12, 1, 1)}</g>` +
  `<g data-part="arm" data-side="left">${px(1, 2, 2)}</g>` +
  `<g data-part="arm" data-side="right">${px(15, 2, 2)}</g>` +
  `<g data-part="legs" data-pair="a">${px(4, 4, 1)}${px(11, 4, 1)}</g>` +
  `<g data-part="legs" data-pair="b">${px(6, 4, 1)}${px(13, 4, 1)}</g>` +
  "</svg>";

/** A small terminal with a prompt for a face; the cursor blinks while Codex works. */
export const CODEX_MASCOT =
  '<svg class="pka-mascot-art" data-kind="codex" viewBox="0 0 20 17" fill="none" stroke="currentColor" aria-hidden="true">' +
  '<rect data-part="foot" x="5" y="14" width="2.4" height="2.6" rx="1" fill="currentColor" stroke="none"/>' +
  '<rect data-part="foot" x="12.6" y="14" width="2.4" height="2.6" rx="1" fill="currentColor" stroke="none"/>' +
  '<rect data-part="body" x="1" y="1" width="18" height="14" rx="4.5" stroke-width="1.3"/>' +
  '<path data-part="prompt" d="M5.6 5.4l3.1 2.6-3.1 2.6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<rect data-part="cursor" x="10.2" y="9.6" width="4.4" height="1.7" rx="0.85" fill="currentColor" stroke="none"/>' +
  "</svg>";

export const AGENT_LOGO = { claude: CLAUDE_LOGO, codex: CODEX_LOGO } satisfies Record<
  AgentKind,
  string
>;
export const AGENT_MASCOT = { claude: CLAWD, codex: CODEX_MASCOT } satisfies Record<
  AgentKind,
  string
>;
export const AGENT_LABEL = { claude: "Claude Code", codex: "Codex" } satisfies Record<
  AgentKind,
  string
>;
