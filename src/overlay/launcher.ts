import type { ViteHotContext } from "vite/types/hot.d.ts";

import type { CHANNEL } from "../shared/channel.ts";
import { send } from "./channel-client.ts";
import { isAgentWorking, subscribeHubState } from "./hub-state.ts";
import { agentIcons, getBadge, subscribeBadge } from "./registry.ts";
import type { ThreadStore } from "./thread-store.ts";

export const HOST_TAG = "pk-annotator";
export const SHORTCUT_LABEL = "Alt+Shift+A";
export const CORNER_KEY = "pka:corner";
/** Annotations sent from this tab, which History lists and the hub follows. */
export const SENT_KEY = "pka:sent";
const AGENT: typeof CHANNEL.agent = "pka:agent";
const PRESENCE: typeof CHANNEL.presence = "pka:presence";
type Receive = Parameters<ViteHotContext["on"]>[1];

export type Theme = "light" | "dark";
export type ThemeSetting = Theme | "system";
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type ThemeSignal = { get(): Theme; subscribe(listener: () => void): () => void };

/** The hub's diameter and its inset from the corner; the menu and panels are laid out around it. */
export const HUB_SIZE = 44;
export const HUB_INSET = 20;

/** What the launcher hands the lazily loaded UI chunk. */
export type UiContext = {
  host: HTMLElement;
  shadow: ShadowRoot;
  hot: ViteHotContext;
  theme: ThemeSignal;
  /** The launcher button. The menu opens around it, and the UI reflects its state on it. */
  hub: HTMLButtonElement;
  /** Owned by the launcher, so a reload follows this tab's annotations without the UI. */
  thread: ThreadStore;
  exit(): void;
  /** The number of saved, unsent marks; the hub shows it in place of its glyph. */
  setMarkCount(count: number): void;
};

export type UiController = {
  toggleMenu(fromKeyboard: boolean): void;
  closeMenu(): void;
  setCorner(corner: Corner): void;
  togglePick(): void;
  unmount(): void;
};

export function readCorner(): Corner {
  const stored = localStorage.getItem(CORNER_KEY);
  return stored === "top-left" ||
    stored === "top-right" ||
    stored === "bottom-left" ||
    stored === "bottom-right"
    ? stored
    : "bottom-right";
}

function nearestCorner(x: number, y: number): Corner {
  const vertical = y < window.innerHeight / 2 ? "top" : "bottom";
  const horizontal = x < window.innerWidth / 2 ? "left" : "right";
  return `${vertical}-${horizontal}`;
}

const ARROW_CORNER = new Map<string, (corner: Corner) => Corner>([
  ["ArrowLeft", (corner) => (corner.startsWith("top") ? "top-left" : "bottom-left")],
  ["ArrowRight", (corner) => (corner.startsWith("top") ? "top-right" : "bottom-right")],
  ["ArrowUp", (corner) => (corner.endsWith("left") ? "top-left" : "top-right")],
  ["ArrowDown", (corner) => (corner.endsWith("left") ? "bottom-left" : "bottom-right")],
]);

// A core with three moons on a quarter orbit: a miniature of the menu, which sweeps
// counterclockwise into the same quadrant. The brightest moon leads the sweep.
const GLYPH =
  '<svg class="pka-glyph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
  '<g data-part="orbit">' +
  '<path d="M16.2 6.7A9.5 9.5 0 0 0 6.7 16.2" fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.3"/>' +
  '<circle cx="16.2" cy="6.7" r="2.1" opacity="0.45"/>' +
  '<circle cx="9.48" cy="9.48" r="2.1" opacity="0.75"/>' +
  '<circle cx="6.7" cy="16.2" r="2.1"/>' +
  "</g>" +
  '<circle data-part="core" cx="16.2" cy="16.2" r="3.25"/>' +
  '<path data-part="close" d="M7.5 7.5l9 9M16.5 7.5l-9 9"/>' +
  "</svg>";

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

const LAUNCHER_CSS = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 auto auto 0 !important;
  z-index: 2147483647 !important;
  --pka-surface: var(--popover, oklch(1 0 0));
  --pka-hub-ink: var(--popover-foreground, oklch(0.145 0 0));
  --pka-hub-accent: var(--pka-pick, oklch(0.6 0.19 255));
  --pka-hub-alert: var(--destructive, oklch(0.577 0.245 27.325));
  --pka-connect: #2563eb;
  --pka-connect-hover: #1d4ed8;
}
:host([data-theme="dark"]) {
  /* Lifted, so the hub and its menu stay distinct over a panel of the same surface. */
  --pka-surface: color-mix(in oklch, var(--popover, oklch(0.205 0 0)), var(--popover-foreground, oklch(0.985 0 0)) 5%);
  --pka-hub-ink: var(--popover-foreground, oklch(0.985 0 0));
  --pka-hub-accent: var(--pka-pick, oklch(0.7 0.16 255));
  --pka-hub-alert: var(--destructive, oklch(0.704 0.191 22.216));
}
.pka-launcher {
  all: initial;
  position: fixed;
  box-sizing: border-box;
  width: ${HUB_SIZE}px;
  height: ${HUB_SIZE}px;
  border-radius: 9999px;
  display: grid;
  place-items: center;
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  color: var(--pka-hub-ink);
  background: var(--pka-surface);
  box-shadow:
    0 0 0 1px color-mix(in oklch, var(--pka-hub-ink) 12%, transparent),
    0 1px 2px rgb(0 0 0 / 0.1),
    0 12px 28px -10px rgb(0 0 0 / 0.4);
  transition:
    transform 180ms ${EASE_OUT},
    box-shadow 180ms ${EASE_OUT},
    background-color 480ms ease,
    color 480ms ease;
}
.pka-launcher:hover { transform: scale(1.05); }
.pka-launcher:active { transform: scale(0.96); }
.pka-launcher:focus-visible { outline: 2px solid var(--ring, #737373); outline-offset: 3px; }
.pka-launcher[data-corner$="right"] { right: ${HUB_INSET}px; }
.pka-launcher[data-corner$="left"] { left: ${HUB_INSET}px; }
.pka-launcher[data-corner^="top"] { top: ${HUB_INSET}px; }
.pka-launcher[data-corner^="bottom"] { bottom: ${HUB_INSET}px; }
.pka-launcher[data-dragging] {
  right: auto;
  bottom: auto;
  cursor: grabbing;
  transform: scale(1.08);
  transition: none;
}
.pka-launcher[data-mode="pick"] {
  box-shadow:
    0 0 0 1.5px var(--pka-hub-accent),
    0 1px 2px rgb(0 0 0 / 0.1),
    0 12px 28px -10px rgb(0 0 0 / 0.4);
}
/* Open, the hub is the root of the menu's shape, which draws the edge and shadow. */
.pka-launcher[aria-expanded="true"] { box-shadow: none; }
.pka-glyph {
  width: 26px;
  height: 26px;
  overflow: visible;
  fill: currentColor;
  transition: opacity 160ms ${EASE_OUT}, scale 260ms ${EASE_OUT};
}
.pka-launcher[data-corner="bottom-left"] .pka-glyph { rotate: 90deg; }
.pka-launcher[data-corner="top-left"] .pka-glyph { rotate: 180deg; }
.pka-launcher[data-corner="top-right"] .pka-glyph { rotate: 270deg; }
.pka-glyph [data-part="orbit"] {
  fill: var(--pka-hub-accent);
  color: var(--pka-hub-accent);
  transform-origin: 16.2px 16.2px;
  transition: transform 360ms ${EASE_OUT}, opacity 200ms ${EASE_OUT};
}
.pka-glyph [data-part="core"] {
  transform-origin: 16.2px 16.2px;
  transition: transform 240ms ${EASE_OUT}, fill 180ms;
}
.pka-glyph [data-part="close"] {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  opacity: 0;
  transform-origin: 12px 12px;
  transform: rotate(90deg) scale(0.4);
  transition: transform 300ms ${EASE_OUT}, opacity 160ms ${EASE_OUT};
}
.pka-launcher:hover .pka-glyph [data-part="orbit"] { transform: rotate(-16deg); }
.pka-launcher[aria-expanded="true"] .pka-glyph [data-part="orbit"] {
  transform: rotate(-90deg) scale(0.2);
  opacity: 0;
}
.pka-launcher[aria-expanded="true"] .pka-glyph [data-part="core"] { transform: scale(0); }
.pka-launcher[aria-expanded="true"] .pka-glyph [data-part="close"] { opacity: 1; transform: none; }
.pka-launcher[data-mode="pick"] .pka-glyph [data-part="core"] { fill: var(--pka-hub-accent); }
.pka-launcher[data-mode="record"] .pka-glyph [data-part="core"] {
  fill: var(--pka-hub-alert);
  animation: pka-hub-pulse 1.6s ease-in-out infinite;
}
@keyframes pka-hub-pulse { 50% { opacity: 0.35; } }
/* While an agent works on an annotation from this tab, the moons circle the core. */
.pka-launcher[data-working] .pka-glyph [data-part="orbit"] {
  animation: pka-hub-orbit 2.4s linear infinite;
}
@keyframes pka-hub-orbit { to { transform: rotate(-360deg); } }
/* An agent reply or resolve: the hub swells once and a ring leaves it. */
.pka-launcher[data-react] { animation: pka-hub-react 560ms cubic-bezier(0.3, 0.7, 0.4, 1); }
.pka-launcher[data-react]::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  animation: pka-hub-ripple 720ms ${EASE_OUT} forwards;
}
@keyframes pka-hub-react { 30% { scale: 1.12; } 62% { scale: 0.97; } }
@keyframes pka-hub-ripple {
  from { box-shadow: 0 0 0 0 color-mix(in oklch, var(--pka-hub-mark, var(--pka-hub-accent)) 55%, transparent); }
  to { box-shadow: 0 0 0 16px transparent; }
}
.pka-count {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--pka-hub-ink);
  font: 600 15px/1 system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  opacity: 0;
  scale: 0.5;
  pointer-events: none;
  transition: opacity 160ms ${EASE_OUT}, scale 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.pka-launcher[data-count]:not([aria-expanded="true"]) .pka-count { opacity: 1; scale: 1; }
.pka-launcher[data-count]:not([aria-expanded="true"]) .pka-glyph { opacity: 0; scale: 0.5; }
.pka-badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  box-sizing: border-box;
  border-radius: 9999px;
  background: var(--pka-hub-alert);
  box-shadow: 0 0 0 2px var(--pka-surface);
  color: #fff;
  font: 600 10px/18px system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.pka-badge[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) {
  .pka-launcher, .pka-launcher *, .pka-launcher::before {
    transition: none !important;
    animation: none !important;
  }
  .pka-launcher[data-working] {
    box-shadow:
      0 0 0 2px var(--pka-hub-mark, var(--pka-hub-accent)),
      0 12px 28px -10px rgb(0 0 0 / 0.4);
  }
}
`;

function watchTheme(
  host: HTMLElement,
  initial: ThemeSetting,
): ThemeSignal & {
  set(setting: ThemeSetting): void;
  stop(): void;
} {
  const listeners = new Set<() => void>();
  const query = matchMedia("(prefers-color-scheme: dark)");
  let setting = initial;
  const resolve = (): Theme =>
    setting === "system" ? (query.matches ? "dark" : "light") : setting;
  let current = resolve();
  host.setAttribute("data-theme", current);
  const apply = () => {
    const next = resolve();
    if (next === current) return;
    current = next;
    host.setAttribute("data-theme", next);
    for (const listener of listeners) listener();
  };
  query.addEventListener("change", apply);
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      if (next !== "light" && next !== "dark" && next !== "system") {
        throw new Error(`setTheme expects "light", "dark", or "system", got ${String(next)}`);
      }
      setting = next;
      apply();
    },
    stop: () => query.removeEventListener("change", apply),
  };
}

export type Launcher = { setTheme(theme: ThemeSetting): void; unmount(): void };

/** Creates the host element and the plain DOM hub; the React UI loads on first open. */
export function createLauncher(
  hot: ViteHotContext,
  theme: ThemeSetting,
  exit: () => void,
): Launcher {
  if (document.querySelector(HOST_TAG) !== null) {
    throw new Error(`<${HOST_TAG}> is already mounted; call unmount() before mounting again`);
  }
  const host = document.createElement(HOST_TAG);
  const shadow = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(LAUNCHER_CSS);
  shadow.adoptedStyleSheets = [sheet];
  const themeSignal = watchTheme(host, theme);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "pka-launcher";
  button.dataset.corner = readCorner();
  button.title = `Annotator (${SHORTCUT_LABEL} picks) · drag to move`;
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = GLYPH;
  const count = document.createElement("span");
  count.className = "pka-count";
  count.setAttribute("aria-hidden", "true");
  const badge = document.createElement("span");
  badge.className = "pka-badge";
  badge.setAttribute("aria-hidden", "true");
  button.append(count, badge);
  shadow.append(button);
  // Outside body, so a recording video restricted to body by Element Capture leaves the
  // overlay out. React 19 hydrates a document from body's first child and resolves html,
  // head, and body by reference, so hydration never visits this element.
  document.documentElement.append(host);

  let marks = 0;
  let agentLabel: string | null = null;
  const renderLabel = () => {
    const errors = getBadge();
    const parts = ["Annotator"];
    if (agentLabel !== null) parts.push(`${agentLabel} connected`);
    if (marks > 0) parts.push(`${marks} unsent ${marks === 1 ? "mark" : "marks"}`);
    if (errors > 0) parts.push(`${errors} open errors`);
    button.setAttribute("aria-label", parts.join(", "));
  };
  const renderBadge = () => {
    const errors = getBadge();
    badge.hidden = errors === 0;
    badge.textContent = errors > 99 ? "99+" : String(errors);
    renderLabel();
  };
  renderBadge();
  const stopBadge = subscribeBadge(renderBadge);
  const setMarkCount = (next: number) => {
    if (!Number.isInteger(next) || next < 0) {
      throw new Error(`setMarkCount expects a non-negative integer, got ${next}`);
    }
    marks = next;
    if (next === 0) delete button.dataset.count;
    else button.dataset.count = "";
    // Keeps the last number while the count fades out.
    if (next > 0) count.textContent = next > 99 ? "99+" : String(next);
    renderLabel();
  };

  const renderWorking = () => {
    if (isAgentWorking()) button.dataset.working = "";
    else delete button.dataset.working;
  };
  renderWorking();
  const stopHubState = subscribeHubState((event) => {
    if (event === "working") {
      renderWorking();
      return;
    }
    // Restarts the reaction when another arrives before the last one ends.
    delete button.dataset.react;
    void button.offsetWidth;
    button.dataset.react = "";
  });
  button.addEventListener("animationend", (event) => {
    if (event.target === button && event.animationName === "pka-hub-react") {
      delete button.dataset.react;
    }
  });

  // The theme module and its schema load with the first agent message. The plugin answers
  // pka:presence only while an agent is connected, so a page without one loads neither.
  let agentTheme: Promise<typeof import("./agent-theme.ts")> | undefined;
  const receiveAgent: Receive = (payload) => {
    agentTheme ??= import("./agent-theme.ts");
    void agentTheme.then(({ AgentMessage, showAgent }) => {
      const parsed = AgentMessage.safeParse(payload);
      if (!parsed.success) {
        console.error(`[pk-annotator] dropped an invalid ${AGENT} message`, parsed.error);
        return;
      }
      agentLabel = showAgent({ host, shadow, hub: button }, parsed.data);
      renderLabel();
    });
  };
  hot.on(AGENT, receiveAgent);
  send(hot, PRESENCE, {});

  // The thread store loads with the UI, or at mount when this tab has sent annotations, so
  // the hub shows agent work and reactions after a reload without loading the React UI.
  let thread: Promise<ThreadStore> | undefined;
  const withThread = () =>
    (thread ??= import("./thread-store.ts").then(({ connectThread }) => connectThread(hot)));
  let ui: Promise<UiController> | undefined;
  const withUi = async (action: (controller: UiController) => void) => {
    ui ??= Promise.all([import("./app.tsx"), withThread()]).then(([{ open }, store]) =>
      open({
        host,
        shadow,
        hot,
        theme: themeSignal,
        hub: button,
        thread: store,
        exit,
        setMarkCount,
      }),
    );
    action(await ui);
  };

  const moveTo = (corner: Corner) => {
    const from = button.getBoundingClientRect();
    button.style.left = "";
    button.style.top = "";
    delete button.dataset.dragging;
    localStorage.setItem(CORNER_KEY, corner);
    button.dataset.corner = corner;
    void ui?.then((controller) => controller.setCorner(corner));
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = button.getBoundingClientRect();
    button.animate(
      [{ translate: `${from.left - to.left}px ${from.top - to.top}px` }, { translate: "0 0" }],
      { duration: 260, easing: EASE_OUT },
    );
  };

  // A press that travels past a few pixels drags the hub; it snaps to the nearest corner.
  let press: { id: number; x: number; y: number; dragging: boolean } | undefined;
  let dragged = false;
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragged = false;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener("pointermove", (event) => {
    if (press?.id !== event.pointerId) return;
    if (!press.dragging) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 6) return;
      press.dragging = true;
      button.dataset.dragging = "";
      void ui?.then((controller) => controller.closeMenu());
    }
    button.style.left = `${event.clientX - HUB_SIZE / 2}px`;
    button.style.top = `${event.clientY - HUB_SIZE / 2}px`;
  });
  button.addEventListener("pointerup", (event) => {
    if (press?.id !== event.pointerId) return;
    dragged = press.dragging;
    press = undefined;
    if (dragged) moveTo(nearestCorner(event.clientX, event.clientY));
  });
  button.addEventListener("pointercancel", () => {
    if (press?.dragging) moveTo(readCorner());
    press = undefined;
  });
  button.addEventListener("click", (event) => {
    if (dragged) {
      dragged = false;
      return;
    }
    // A click from Enter or Space has no pointer detail; that menu opens with focus inside.
    void withUi((controller) => controller.toggleMenu(event.detail === 0));
  });
  button.addEventListener("keydown", (event) => {
    const next = ARROW_CORNER.get(event.key)?.(readCorner());
    if (next === undefined) return;
    event.preventDefault();
    if (next !== readCorner()) moveTo(next);
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== "KeyA" || !event.altKey || !event.shiftKey) return;
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    void withUi((controller) => controller.togglePick());
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  const sent = sessionStorage.getItem(SENT_KEY);
  if (sent !== null && sent !== "[]") void withThread();

  return {
    setTheme: themeSignal.set,
    unmount() {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      hot.off(AGENT, receiveAgent);
      stopBadge();
      stopHubState();
      themeSignal.stop();
      agentIcons.set(null);
      void ui?.then((controller) => controller.unmount());
      void thread?.then((store) => store.disconnect());
      host.remove();
    },
  };
}
