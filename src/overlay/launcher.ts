import type { ViteHotContext } from "vite/types/hot.d.ts";

import { getBadge, subscribeBadge } from "./registry.ts";

export const HOST_TAG = "pk-annotator";
export const SHORTCUT_LABEL = "Alt+Shift+A";
export const CORNER_KEY = "pka:corner";
const OPEN_KEY = "pka:open";

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
  /** Called by the UI when it minimizes; the launcher returns focus to the hub. */
  hidden(): void;
  exit(): void;
};

export type UiController = {
  show(): void;
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
  --pka-hub-surface: var(--popover, oklch(1 0 0));
  --pka-hub-ink: var(--popover-foreground, oklch(0.145 0 0));
  --pka-hub-accent: var(--pka-pick, oklch(0.6 0.19 255));
  --pka-hub-alert: var(--destructive, oklch(0.577 0.245 27.325));
}
:host([data-theme="dark"]) {
  --pka-hub-surface: var(--popover, oklch(0.205 0 0));
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
  background: var(--pka-hub-surface);
  box-shadow:
    0 0 0 1px color-mix(in oklch, var(--pka-hub-ink) 12%, transparent),
    0 1px 2px rgb(0 0 0 / 0.1),
    0 12px 28px -10px rgb(0 0 0 / 0.4);
  transition: transform 180ms ${EASE_OUT}, box-shadow 180ms ${EASE_OUT};
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
.pka-glyph { width: 26px; height: 26px; overflow: visible; fill: currentColor; }
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
  box-shadow: 0 0 0 2px var(--pka-hub-surface);
  color: #fff;
  font: 600 10px/18px system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.pka-badge[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) {
  .pka-launcher, .pka-glyph * { transition: none !important; animation: none !important; }
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
  const badge = document.createElement("span");
  badge.className = "pka-badge";
  badge.setAttribute("aria-hidden", "true");
  button.append(badge);
  shadow.append(button);
  // Outside body, so a recording video restricted to body by Element Capture leaves the
  // overlay out. React 19 hydrates a document from body's first child and resolves html,
  // head, and body by reference, so hydration never visits this element.
  document.documentElement.append(host);

  const renderBadge = () => {
    const count = getBadge();
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
    button.setAttribute(
      "aria-label",
      count === 0 ? "Annotator" : `Annotator, ${count} open errors`,
    );
  };
  renderBadge();
  const stopBadge = subscribeBadge(renderBadge);

  let ui: Promise<UiController> | undefined;
  const withUi = async (action: (controller: UiController) => void) => {
    ui ??= import("./app.tsx").then(({ open }) =>
      open({
        host,
        shadow,
        hot,
        theme: themeSignal,
        hub: button,
        exit() {
          sessionStorage.removeItem(OPEN_KEY);
          exit();
        },
        hidden() {
          sessionStorage.removeItem(OPEN_KEY);
          button.focus();
        },
      }),
    );
    const controller = await ui;
    sessionStorage.setItem(OPEN_KEY, "1");
    action(controller);
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
  if (sessionStorage.getItem(OPEN_KEY) === "1") void withUi((controller) => controller.show());

  return {
    setTheme: themeSignal.set,
    unmount() {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      stopBadge();
      themeSignal.stop();
      void ui?.then((controller) => controller.unmount());
      host.remove();
    },
  };
}
