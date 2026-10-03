import { agentKind, type AgentKind } from "../shared/agent.ts";
import type { AgentMessage } from "../shared/channel.ts";
import { AGENT_LABEL, AGENT_LOGO, AGENT_MASCOT } from "./agent-art.ts";

// The agent theme loads with the first agent message. Its tokens use !important inside the
// shadow root, which beats a consumer's tokens on the host element (an important declaration
// from an inner tree context wins), so the agent's palette replaces the consumer's while the
// agent is connected. Without an agent nothing here applies.

const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const SETTLE = "cubic-bezier(0.16, 1, 0.3, 1)";

const AGENT_CSS = `
:host([data-agent="claude"]) {
  --background: #faf9f5 !important;
  --foreground: #141413 !important;
  --card: #ffffff !important;
  --card-foreground: #141413 !important;
  --popover: #ffffff !important;
  --popover-foreground: #141413 !important;
  --primary: #b5532f !important;
  --primary-foreground: #ffffff !important;
  --secondary: #f0eee6 !important;
  --secondary-foreground: #141413 !important;
  --muted: #f0eee6 !important;
  --muted-foreground: #64625a !important;
  --accent: #ece9df !important;
  --accent-foreground: #141413 !important;
  --border: #e3dfd3 !important;
  --input: #d9d4c6 !important;
  --ring: #b5532f !important;
  --pka-pick: #b5532f !important;
  --pka-pick-foreground: #ffffff !important;
  --pka-hub-mark: #d97757;
}
:host([data-agent="claude"][data-theme="dark"]) {
  --background: #262624 !important;
  --foreground: #faf9f5 !important;
  --card: #30302e !important;
  --card-foreground: #faf9f5 !important;
  --popover: #30302e !important;
  --popover-foreground: #faf9f5 !important;
  --primary: #d97757 !important;
  --primary-foreground: #141413 !important;
  --secondary: #3a3936 !important;
  --secondary-foreground: #faf9f5 !important;
  --muted: #3a3936 !important;
  --muted-foreground: #b1aea4 !important;
  --accent: #3e3d39 !important;
  --accent-foreground: #faf9f5 !important;
  --border: rgb(250 249 245 / 0.12) !important;
  --input: rgb(250 249 245 / 0.16) !important;
  --ring: #d97757 !important;
  --pka-pick: #e0896b !important;
  --pka-pick-foreground: #141413 !important;
}
:host([data-agent="codex"]) {
  --background: #ffffff !important;
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
  --border: #e5e5e5 !important;
  --input: #d9d9d9 !important;
  --ring: #5d5d5d !important;
  --pka-pick: #0169cc !important;
  --pka-pick-foreground: #ffffff !important;
  --pka-hub-mark: var(--pka-hub-ink);
}
:host([data-agent="codex"][data-theme="dark"]) {
  --background: #181818 !important;
  --foreground: #ececec !important;
  --card: #212121 !important;
  --card-foreground: #ececec !important;
  --popover: #212121 !important;
  --popover-foreground: #ececec !important;
  --primary: #ececec !important;
  --primary-foreground: #0d0d0d !important;
  --secondary: #2a2a2a !important;
  --secondary-foreground: #ececec !important;
  --muted: #2a2a2a !important;
  --muted-foreground: #afafaf !important;
  --accent: #303030 !important;
  --accent-foreground: #ececec !important;
  --border: rgb(255 255 255 / 0.1) !important;
  --input: rgb(255 255 255 / 0.15) !important;
  --ring: #afafaf !important;
  --pka-pick: #48aaff !important;
  --pka-pick-foreground: #0d0d0d !important;
}

/* Logos sit over the glyph. Entering, the glyph's moons spiral into the core, the core slides
   to the center and dissolves, and the logo blooms out of that point. Leaving runs the other
   way: each state carries the delays of the transition that leads into it. */
.pka-agent-logo {
  position: absolute;
  inset: 0;
  width: 24px;
  height: 24px;
  margin: auto;
  overflow: visible;
  pointer-events: none;
  opacity: 0;
}
.pka-agent-logo[data-kind="claude"] {
  fill: var(--pka-hub-mark, #d97757);
  rotate: -70deg;
  transition: opacity 140ms linear 160ms, rotate 300ms ease-in;
}
.pka-agent-logo[data-kind="claude"] [data-part="ray"] {
  transform-box: view-box;
  transform-origin: 12px 12px;
  scale: 0;
  transition: scale 220ms ease-in calc(var(--i) * 10ms);
}
:host([data-agent="claude"]) .pka-agent-logo[data-kind="claude"] {
  opacity: 1;
  rotate: 0deg;
  transition: opacity 120ms linear 200ms, rotate 1000ms ${SETTLE} 200ms;
}
:host([data-agent="claude"]) .pka-agent-logo[data-kind="claude"] [data-part="ray"] {
  scale: 1;
  transition: scale 620ms ${SPRING} calc(220ms + var(--i) * 26ms);
}
.pka-agent-logo[data-kind="codex"] {
  fill: none;
  scale: 0.3;
  rotate: -120deg;
  transition: opacity 140ms linear 160ms, scale 300ms ease-in, rotate 300ms ease-in;
}
.pka-agent-logo[data-kind="codex"] [data-part="gap"] {
  stroke: var(--pka-surface);
  stroke-width: 2.7;
}
.pka-agent-logo[data-kind="codex"] [data-part="ink"] {
  stroke: var(--pka-hub-ink);
  stroke-width: 1.5;
}
:host([data-agent="codex"]) .pka-agent-logo[data-kind="codex"] {
  opacity: 1;
  scale: 1;
  rotate: 0deg;
  transition:
    opacity 160ms linear 220ms,
    scale 640ms ${SPRING} 220ms,
    rotate 900ms ${SETTLE} 220ms;
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
.pka-mascot .pka-mascot-art[data-kind="claude"] { width: 24px; height: 13.33px; }
.pka-mascot .pka-mascot-art[data-kind="codex"] { width: 19px; height: 16.15px; }

/* While an agent works on an annotation from this tab. Claude: the starburst turns and its
   rays breathe in a wave, as Claude Code's spinner does, and Clawd walks in place.
   Codex: the knot pulses while a shimmer runs around its links, and the cursor blinks. */
:host([data-agent="claude"]) .pka-launcher[data-working] .pka-agent-logo[data-kind="claude"] {
  animation: pka-agent-turn 9s linear infinite;
}
:host([data-agent="claude"]) .pka-launcher[data-working] [data-part="ray"] {
  animation: pka-agent-breathe 1.3s ease-in-out infinite;
  animation-delay: calc(var(--i) * -108ms);
}
:host([data-agent="claude"]) .pka-launcher[data-working] [data-part="legs"] {
  animation: pka-clawd-step 420ms linear infinite;
}
:host([data-agent="claude"]) .pka-launcher[data-working] [data-part="legs"][data-pair="b"] {
  animation-delay: -210ms;
}
:host([data-agent="codex"]) .pka-launcher[data-working] .pka-agent-logo[data-kind="codex"] {
  animation: pka-agent-pulse 1.6s ease-in-out infinite;
}
:host([data-agent="codex"]) .pka-launcher[data-working] [data-part="ink"] {
  animation: pka-codex-shimmer 1.6s ease-in-out infinite;
  animation-delay: calc(var(--i) * -267ms);
}
:host([data-agent="codex"]) .pka-launcher[data-working] [data-part="cursor"] {
  animation: pka-codex-blink 1s steps(1) infinite;
}
@keyframes pka-agent-turn { to { rotate: 360deg; } }
@keyframes pka-agent-breathe { 50% { scale: 0.58; } }
@keyframes pka-clawd-step { 0%, 49.9% { translate: 0 -1px; } 50%, 100% { translate: 0 0; } }
@keyframes pka-agent-pulse { 50% { scale: 0.86; } }
@keyframes pka-codex-shimmer { 50% { stroke-opacity: 0.5; } }
@keyframes pka-codex-blink { 50% { opacity: 0; } }

/* A reply or resolve: the mascot hops twice; Clawd raises its arms, the terminal nods. */
.pka-launcher[data-react] .pka-mascot {
  animation: pka-mascot-hop 720ms cubic-bezier(0.3, 0.7, 0.4, 1);
}
.pka-launcher[data-react] [data-part="arm"] {
  animation: pka-clawd-cheer 720ms steps(1);
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
@keyframes pka-clawd-cheer { 0%, 84% { translate: 0 -2px; } }
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
