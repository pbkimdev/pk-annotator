import loraUrl from "@fontsource-variable/lora/files/lora-latin-wght-normal.woff2";
import poppins400Url from "@fontsource/poppins/files/poppins-latin-400-normal.woff2";
import poppins500Url from "@fontsource/poppins/files/poppins-latin-500-normal.woff2";
import poppins600Url from "@fontsource/poppins/files/poppins-latin-600-normal.woff2";

import { agentKind, type AgentKind } from "../shared/agent.ts";
import type { AgentMessage } from "../shared/channel.ts";
import { AGENT_LABEL, AGENT_LOGO, AGENT_MASCOT } from "./agent-art.ts";
import { CLAUDE_ICONS } from "./claude-icons.ts";
import { agentIcons } from "./registry.ts";

// The agent theme loads with the first agent message. Its tokens use !important inside the
// shadow root, which beats a consumer's tokens on the host element (an important declaration
// from an inner tree context wins), so the agent's palette replaces the consumer's while the
// agent is connected. Without an agent nothing here applies.

const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const SETTLE = "cubic-bezier(0.16, 1, 0.3, 1)";

// Palettes from the published brand colors. Claude: anthropics/skills brand-guidelines (Dark
// #141413, Light #faf9f5, Mid Gray #b0aea5, Light Gray #e8e6dc, Orange #d97757, Blue #6a9bcc,
// Green #788c5d). On light surfaces Orange and Blue fall below 3:1, so marks there use a
// darker clay and blue of the same hue; secondary text uses a darker Mid Gray for 4.5:1.
// Codex: the neutrals and blue chatgpt.com uses (#0d0d0d, #5d5d5d, #f3f3f3, #212121, #3566f0).
const AGENT_CSS = `
:host([data-agent="claude"]) {
  --background: #faf9f5 !important;
  --foreground: #141413 !important;
  --card: #faf9f5 !important;
  --card-foreground: #141413 !important;
  --popover: #faf9f5 !important;
  --popover-foreground: #141413 !important;
  --primary: #bf502b !important;
  --primary-foreground: #ffffff !important;
  --secondary: #f0eee6 !important;
  --secondary-foreground: #141413 !important;
  --muted: #f0eee6 !important;
  --muted-foreground: #5e5d59 !important;
  --accent: #e8e6dc !important;
  --accent-foreground: #141413 !important;
  --border: #e8e6dc !important;
  --input: #d6d3c8 !important;
  --ring: #3e7ab6 !important;
  --radius: 12px !important;
  --pka-pick: #bf502b !important;
  --pka-pick-foreground: #ffffff !important;
  --pka-hub-mark: #d97757;
  --pka-status-pending: #bf502b;
  --pka-status-acknowledged: #3e7ab6;
  --pka-status-resolved: #788c5d;
  --pka-status-dismissed: #87867f;
  --pka-shadow: 20 20 19;
  --font-sans: "pka Poppins", Arial, system-ui, sans-serif !important;
  --font-heading: "pka Poppins", Arial, system-ui, sans-serif !important;
  --pka-font-body: "pka Lora", Georgia, ui-serif, serif;
}
:host([data-agent="claude"][data-theme="dark"]) {
  --background: #141413 !important;
  --foreground: #faf9f5 !important;
  --card: #1f1e1d !important;
  --card-foreground: #faf9f5 !important;
  --popover: #1f1e1d !important;
  --popover-foreground: #faf9f5 !important;
  --primary: #d97757 !important;
  --primary-foreground: #141413 !important;
  --secondary: #2a2925 !important;
  --secondary-foreground: #faf9f5 !important;
  --muted: #2a2925 !important;
  --muted-foreground: #b0aea5 !important;
  --accent: #33322e !important;
  --accent-foreground: #faf9f5 !important;
  --border: rgb(250 249 245 / 0.1) !important;
  --input: rgb(250 249 245 / 0.16) !important;
  --ring: #6a9bcc !important;
  --pka-pick: #d97757 !important;
  --pka-pick-foreground: #141413 !important;
  --pka-status-pending: #d97757;
  --pka-status-acknowledged: #6a9bcc;
  --pka-status-dismissed: #b0aea5;
  --pka-shadow: 0 0 0;
}
:host([data-agent="codex"]) {
  --background: #fcfcfc !important;
  --foreground: #0d0d0d !important;
  --card: #ffffff !important;
  --card-foreground: #0d0d0d !important;
  --popover: #ffffff !important;
  --popover-foreground: #0d0d0d !important;
  --primary: #0d0d0d !important;
  --primary-foreground: #ffffff !important;
  --secondary: #f3f3f3 !important;
  --secondary-foreground: #0d0d0d !important;
  --muted: #f3f3f3 !important;
  --muted-foreground: #5d5d5d !important;
  --accent: #ececec !important;
  --accent-foreground: #0d0d0d !important;
  --border: rgb(13 13 13 / 0.1) !important;
  --input: rgb(13 13 13 / 0.15) !important;
  --ring: #3566f0 !important;
  --radius: 16px !important;
  --pka-pick: #3566f0 !important;
  --pka-pick-foreground: #ffffff !important;
  --pka-hub-mark: var(--pka-hub-ink);
  --pka-status-pending: #5d5d5d;
  --pka-status-acknowledged: #3566f0;
  --pka-status-resolved: #0d0d0d;
  --pka-status-dismissed: #8f8f8f;
  --pka-shadow: 0 0 0;
  /* OpenAI Sans is proprietary; this is the system stack chatgpt.com falls back to. */
  --font-sans: ui-sans-serif, -apple-system, system-ui, "Segoe UI", Inter, Helvetica, Arial, sans-serif !important;
  --font-heading: ui-sans-serif, -apple-system, system-ui, "Segoe UI", Inter, Helvetica, Arial, sans-serif !important;
}
:host([data-agent="codex"][data-theme="dark"]) {
  --background: #181818 !important;
  --foreground: #ffffff !important;
  --card: #212121 !important;
  --card-foreground: #ffffff !important;
  --popover: #212121 !important;
  --popover-foreground: #ffffff !important;
  --primary: #ffffff !important;
  --primary-foreground: #0d0d0d !important;
  --secondary: #303030 !important;
  --secondary-foreground: #ffffff !important;
  --muted: #303030 !important;
  --muted-foreground: #afafaf !important;
  --accent: #3a3a3a !important;
  --accent-foreground: #ffffff !important;
  --border: rgb(255 255 255 / 0.12) !important;
  --input: rgb(255 255 255 / 0.18) !important;
  --ring: #6e9bff !important;
  --pka-pick: #6e9bff !important;
  --pka-pick-foreground: #0d0d0d !important;
  --pka-status-pending: #afafaf;
  --pka-status-acknowledged: #6e9bff;
  --pka-status-resolved: #ffffff;
  --pka-status-dismissed: #8f8f8f;
}

/* Type and icons. Claude: Poppins for labels and titles, Lora for prompts and replies, and
   Phosphor's regular weight (1.5 units on a 24-unit grid) for any lucide icon left over.
   Codex: the system stack, and lucide at the 1.33 px on 20 px stroke of OpenAI's icons. */
:host([data-agent="claude"]) :is(.pka-editor, .pka-prose) {
  font-family: var(--pka-font-body);
  font-size: 15px;
  line-height: 1.55;
}
:host([data-agent="claude"]) .pka-editor .pka-ref,
:host([data-agent="claude"]) .pka-editor code {
  font-family: var(--font-sans);
  font-size: 11px;
}
:host([data-agent="claude"]) .pka-editor code { font-family: var(--font-mono); }
:host([data-agent="claude"]) svg.lucide { stroke-width: 1.5; }
:host([data-agent="codex"]) svg.lucide { stroke-width: 1.6; }
:host([data-agent]) .pka-editor ::selection {
  background: color-mix(in oklch, var(--pka-pick) 22%, transparent);
  color: inherit;
}
:host([data-agent]) .pka-status { background-color: var(--pka-status, currentColor); }
:host([data-agent]) .pka-status[data-status="pending"] { --pka-status: var(--pka-status-pending); }
:host([data-agent]) .pka-status[data-status="acknowledged"] { --pka-status: var(--pka-status-acknowledged); }
:host([data-agent]) .pka-status[data-status="resolved"] { --pka-status: var(--pka-status-resolved); }
:host([data-agent]) .pka-status[data-status="dismissed"] { --pka-status: var(--pka-status-dismissed); }
:host([data-agent]) .pka-count,
:host([data-agent]) .pka-badge { font-family: var(--font-sans); }
/* The badge's 20 px line would push Poppins' taller figures below the circle's center. */
:host([data-agent="claude"]) .pka-editor .pka-ref-n { line-height: 1; }
:host([data-agent="claude"]) .pka-glyph [data-part="close"] { stroke-width: 1.5; }
:host([data-agent]) .pka-node:focus-visible { box-shadow: 0 0 0 1.5px var(--ring); }

/* Surfaces. Claude's float on a warm shadow with a hairline edge; Codex's composer is a pill
   and its actions are round, as in ChatGPT. */
:host([data-agent]) [data-testid="pka-panel"] {
  box-shadow:
    0 0 0 0.5px rgb(var(--pka-shadow) / 0.08),
    0 2px 8px rgb(var(--pka-shadow) / 0.05),
    0 16px 40px -8px rgb(var(--pka-shadow) / 0.18) !important;
}
:host([data-agent][data-theme="dark"]) [data-testid="pka-panel"] {
  box-shadow:
    0 0 0 0.5px rgb(255 255 255 / 0.08),
    0 4px 12px rgb(0 0 0 / 0.4),
    0 16px 40px rgb(0 0 0 / 0.5) !important;
}
:host([data-agent]) [data-testid="pka-panel"] h2 { font-size: 14px; font-weight: 600; letter-spacing: 0; }
:host([data-agent="codex"]) [data-testid="pka-send"] { font-weight: 500; }
:host([data-agent="claude"]) .pka-readout-label,
:host([data-agent="claude"]) .pka-readout-key { font-family: var(--font-sans); }

/* Logos sit over the glyph. Entering, the glyph's moons spiral into the core, the core slides
   to the center and dissolves, and the mark arrives out of that point: Claude's blooms with a
   quarter turn, the OpenAI mark spins in. Leaving runs the other way: each state carries the
   delays of the transition that leads into it. */
.pka-agent-logo {
  position: absolute;
  inset: 0;
  width: 24px;
  height: 24px;
  margin: auto;
  overflow: visible;
  pointer-events: none;
  opacity: 0;
  scale: 0;
  transform-origin: 50% 50%;
}
.pka-agent-logo[data-kind="claude"] {
  fill: var(--pka-hub-mark, #d97757);
  rotate: -100deg;
  transition: opacity 120ms linear 160ms, scale 280ms ease-in, rotate 280ms ease-in;
}
:host([data-agent="claude"]) .pka-agent-logo[data-kind="claude"] {
  opacity: 1;
  scale: 1;
  rotate: 0deg;
  transition:
    opacity 120ms linear 220ms,
    scale 760ms ${SPRING} 220ms,
    rotate 1100ms ${SETTLE} 220ms;
}
.pka-agent-logo[data-kind="codex"] {
  fill: var(--pka-hub-ink);
  rotate: -240deg;
  transition: opacity 120ms linear 160ms, scale 280ms ease-in, rotate 280ms ease-in;
}
:host([data-agent="codex"]) .pka-agent-logo[data-kind="codex"] {
  opacity: 1;
  scale: 1;
  rotate: 0deg;
  transition:
    opacity 140ms linear 220ms,
    scale 640ms ${SETTLE} 220ms,
    rotate 1000ms ${SETTLE} 220ms;
}
:host([data-agent]) .pka-glyph [data-part="orbit"] {
  transform: rotate(-200deg) scale(0.15);
  opacity: 0;
  transition: transform 380ms cubic-bezier(0.5, 0, 0.75, 0), opacity 200ms linear 160ms;
}
:host([data-agent]) .pka-glyph [data-part="core"] {
  transform: translate(-4.2px, -4.2px) scale(0);
  transition: transform 440ms cubic-bezier(0.45, 0, 0.2, 1) 60ms;
}
:host(:not([data-agent])) .pka-glyph [data-part="orbit"] {
  transition: transform 520ms ${SETTLE} 200ms, opacity 200ms linear 200ms;
}
:host(:not([data-agent])) .pka-glyph [data-part="core"] {
  transition: transform 420ms ${SPRING} 140ms, fill 180ms;
}
/* Recording and the open menu keep their own hub states. */
:host([data-agent]) .pka-launcher[data-mode="record"] .pka-glyph [data-part="core"] {
  transform: translate(-4.2px, -4.2px) scale(1.25);
}
:host([data-agent]) .pka-launcher[data-mode="record"] .pka-agent-logo,
:host([data-agent]) .pka-launcher[aria-expanded="true"] .pka-agent-logo,
:host([data-agent]) .pka-launcher[data-count]:not([aria-expanded="true"]) .pka-agent-logo {
  opacity: 0;
  scale: 0.5;
  transition: opacity 140ms linear, scale 220ms ease-in;
}
:host([data-agent]) .pka-launcher[aria-expanded="true"] .pka-glyph [data-part="core"] {
  transform: scale(0);
}

/* The mascot stands beside the hub on the side that faces the page. */
.pka-mascot {
  position: absolute;
  bottom: 1px;
  width: 24px;
  height: 17px;
  pointer-events: none;
  transition: opacity 160ms linear, scale 220ms ${SPRING};
  transform-origin: 50% 100%;
}
.pka-launcher[data-corner$="right"] .pka-mascot { right: calc(100% + 5px); }
.pka-launcher[data-corner$="left"] .pka-mascot { left: calc(100% + 5px); }
.pka-launcher[aria-expanded="true"] .pka-mascot,
.pka-launcher[data-dragging] .pka-mascot {
  opacity: 0;
  scale: 0.6;
}
.pka-mascot .pka-mascot-art {
  position: absolute;
  bottom: 0;
  left: 50%;
  overflow: visible;
  opacity: 0;
  translate: -50% 8px;
  scale: 0.2;
  transform-origin: 50% 100%;
  filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.28));
  transition: opacity 120ms linear, translate 220ms ease-in, scale 220ms ease-in;
}
:host([data-agent="claude"]) .pka-mascot .pka-mascot-art[data-kind="claude"],
:host([data-agent="codex"]) .pka-mascot .pka-mascot-art[data-kind="codex"] {
  opacity: 1;
  translate: -50% 0;
  scale: 1;
  transition:
    opacity 100ms linear 620ms,
    translate 560ms ${SPRING} 620ms,
    scale 560ms ${SPRING} 620ms;
}
.pka-mascot .pka-mascot-art[data-kind="claude"] { width: 24px; height: 14.12px; }
.pka-mascot .pka-mascot-art[data-kind="codex"] { width: 19px; height: 16.15px; }

/* While an agent works on an annotation from this tab. Claude's mark turns and pulses
   between small and full size, as Claude Code's ✻ spinner grows and shrinks, and Clawd steps
   from foot to foot. The OpenAI mark breathes as it turns slowly, and the cursor blinks. */
:host([data-agent="claude"]) .pka-launcher[data-working] .pka-agent-logo[data-kind="claude"] {
  animation:
    pka-agent-turn 2.4s linear infinite,
    pka-claude-pulse 1.2s ease-in-out infinite;
}
:host([data-agent="claude"]) .pka-launcher[data-working] [data-part="feet"][data-side="left"] {
  animation: pka-clawd-step 480ms steps(1) infinite;
}
:host([data-agent="claude"]) .pka-launcher[data-working] [data-part="feet"][data-side="right"] {
  animation: pka-clawd-step 480ms steps(1) -240ms infinite;
}
:host([data-agent="codex"]) .pka-launcher[data-working] .pka-agent-logo[data-kind="codex"] {
  animation:
    pka-agent-turn 8s linear infinite,
    pka-codex-breathe 2s ease-in-out infinite;
}
:host([data-agent="codex"]) .pka-launcher[data-working] [data-part="cursor"] {
  animation: pka-codex-blink 1s steps(1) infinite;
}
@keyframes pka-agent-turn { to { rotate: 1turn; } }
@keyframes pka-claude-pulse { 50% { scale: 0.62; } }
@keyframes pka-codex-breathe { 50% { scale: 0.82; opacity: 0.7; } }
@keyframes pka-clawd-step { 50% { opacity: 0; } }
@keyframes pka-codex-blink { 50% { opacity: 0; } }

/* A reply or resolve: the mark spins once and settles, and the mascot hops twice; Clawd
   raises its arms as Claude Code's arms-up pose does, the terminal nods. */
:host([data-agent="claude"]) .pka-launcher[data-react] .pka-agent-logo[data-kind="claude"] {
  animation: pka-claude-reply 720ms ${SETTLE};
}
:host([data-agent="codex"]) .pka-launcher[data-react] .pka-agent-logo[data-kind="codex"] {
  animation: pka-codex-reply 720ms ${SETTLE};
}
@keyframes pka-claude-reply {
  from { rotate: -180deg; scale: 0.6; }
  45% { scale: 1.18; }
}
@keyframes pka-codex-reply {
  from { rotate: -120deg; scale: 0.7; }
  45% { scale: 1.12; }
}
.pka-launcher[data-react] .pka-mascot {
  animation: pka-mascot-hop 720ms cubic-bezier(0.3, 0.7, 0.4, 1);
}
.pka-launcher[data-react] [data-part="arms"][data-pose="down"] {
  animation: pka-clawd-arms 720ms steps(1);
}
.pka-launcher[data-react] [data-part="arms"][data-pose="up"] {
  animation: pka-clawd-arms-up 720ms steps(1);
}
.pka-launcher[data-react] [data-part="prompt"] {
  animation: pka-codex-nod 720ms ease-in-out;
}
@keyframes pka-mascot-hop {
  22% { translate: 0 -6px; }
  44% { translate: 0 0; }
  64% { translate: 0 -3px; }
  80% { translate: 0 0; }
}
@keyframes pka-clawd-arms { 0%, 84% { opacity: 0; } 85%, 100% { opacity: 1; } }
@keyframes pka-clawd-arms-up { 0%, 84% { opacity: 1; } 85%, 100% { opacity: 0; } }
@keyframes pka-codex-nod { 25%, 60% { translate: 1.4px 0; } }

/* Beside the hub the Codex terminal is filled, so it stays legible over any page. */
.pka-mascot { color: var(--pka-hub-ink); }
.pka-mascot [data-part="body"]:is(rect) { fill: var(--pka-surface); }

/* Connecting, the agent's color spreads from the hub across the page and the overlay's
   colors cross-fade under it; disconnecting, it draws back into the hub. */
.pka-agent-wash {
  position: fixed;
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(
    closest-side,
    transparent 0%,
    color-mix(in oklch, var(--pka-wash) 8%, transparent) 64%,
    color-mix(in oklch, var(--pka-wash) 24%, transparent) 95%,
    transparent 100%
  );
  animation: pka-agent-wash 960ms cubic-bezier(0.2, 0.7, 0.25, 1) forwards;
}
.pka-agent-wash[data-kind="claude"] { --pka-wash: #d97757; }
.pka-agent-wash[data-kind="codex"] { --pka-wash: #0d0d0d; }
:host([data-theme="dark"]) .pka-agent-wash[data-kind="codex"] { --pka-wash: #ececec; }
.pka-agent-wash[data-direction="leave"] {
  animation-duration: 640ms;
  animation-direction: reverse;
  animation-timing-function: cubic-bezier(0.6, 0, 0.8, 0.3);
}
@keyframes pka-agent-wash {
  from { scale: 0.02; opacity: 1; }
  55% { opacity: 1; }
  to { scale: 1; opacity: 0; }
}
:host([data-agent-shift]) .pka-root * {
  transition:
    background-color 520ms ease,
    border-color 520ms ease,
    color 520ms ease,
    fill 520ms ease,
    stroke 520ms ease !important;
}
:host([data-agent-instant]) .pka-launcher,
:host([data-agent-instant]) .pka-launcher * {
  transition: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .pka-launcher *, .pka-agent-wash {
    transition: none !important;
    animation: none !important;
  }
}
`;

const sheet = new CSSStyleSheet();
sheet.replaceSync(AGENT_CSS);

export type AgentView = { host: HTMLElement; shadow: ShadowRoot; hub: HTMLButtonElement };

const installed = new WeakSet<ShadowRoot>();

// fontsource's Latin subset range: Hangul and other scripts fall through to system fonts.
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
let fontsAdded = false;

/**
 * Claude's brand faces (OFL), inlined as data URLs so the bundle needs no asset handling.
 * The family names are the overlay's own, so they never match a consumer's font-family, and
 * a face downloads nothing: its bytes decode only when overlay text first uses it.
 */
function addClaudeFonts(): void {
  if (fontsAdded) return;
  fontsAdded = true;
  const faces: [string, string, string][] = [
    ["pka Poppins", poppins400Url, "400"],
    ["pka Poppins", poppins500Url, "500"],
    ["pka Poppins", poppins600Url, "600"],
    ["pka Lora", loraUrl, "400 700"],
  ];
  for (const [family, url, weight] of faces) {
    document.fonts.add(
      new FontFace(family, `url(${url}) format("woff2")`, {
        weight,
        display: "swap",
        unicodeRange: LATIN,
      }),
    );
  }
}

function install({ shadow, hub }: AgentView): void {
  if (installed.has(shadow)) return;
  installed.add(shadow);
  shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
  const glyph = hub.querySelector(".pka-glyph");
  if (glyph === null) throw new Error("The hub has no glyph to place the agent logo beside");
  glyph.insertAdjacentHTML("afterend", AGENT_LOGO.claude + AGENT_LOGO.codex);
  const mascot = document.createElement("span");
  mascot.className = "pka-mascot";
  mascot.setAttribute("aria-hidden", "true");
  mascot.innerHTML = AGENT_MASCOT.claude + AGENT_MASCOT.codex;
  hub.append(mascot);
  // New parts need a computed style without the agent before the theme applies, or they
  // would start in their final state instead of transitioning into it.
  void hub.offsetWidth;
}

/** The color spreads from the hub to the farthest corner of the viewport, or draws back into it. */
function spread({ host, shadow, hub }: AgentView, kind: AgentKind, direction: "enter" | "leave") {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const box = hub.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const wash = document.createElement("div");
  wash.className = "pka-agent-wash";
  wash.dataset.kind = kind;
  wash.dataset.direction = direction;
  Object.assign(wash.style, {
    left: `${x - radius}px`,
    top: `${y - radius}px`,
    width: `${radius * 2}px`,
    height: `${radius * 2}px`,
  });
  host.dataset.agentShift = "";
  wash.addEventListener("animationend", () => {
    wash.remove();
    if (shadow.querySelector(".pka-agent-wash") === null) delete host.dataset.agentShift;
  });
  // Under the hub, above the overlay's panels, so the color passes over them.
  shadow.insertBefore(wash, hub);
}

export { AgentMessage } from "../shared/channel.ts";

/** Applies one pka:agent message. Returns the connected client's name for the hub's label, or null. */
export function showAgent(view: AgentView, message: AgentMessage): string | null {
  const { agent } = message;
  // Already connected when the page loaded: settle into the theme without the entrance.
  const animate = message.cause === "change";
  install(view);
  const { host, hub } = view;
  const kind = agent === null ? null : agentKind(agent.name);
  const shown = host.dataset.agent;
  const previous = shown === "claude" || shown === "codex" ? shown : null;
  if (kind !== previous) {
    if (!animate) host.dataset.agentInstant = "";
    if (kind === "claude") addClaudeFonts();
    agentIcons.set(kind === "claude" ? CLAUDE_ICONS : null);
    if (kind === null) delete host.dataset.agent;
    else host.dataset.agent = kind;
    if (animate) {
      if (kind !== null) spread(view, kind, "enter");
      else if (previous !== null) spread(view, previous, "leave");
    } else {
      void hub.offsetWidth;
      delete host.dataset.agentInstant;
    }
  }
  if (agent === null) return null;
  return kind === null ? agent.name : AGENT_LABEL[kind];
}
