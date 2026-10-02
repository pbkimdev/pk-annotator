import type { ViteHotContext } from "vite/types/hot.d.ts";

import { getBadge, subscribeBadge } from "./registry.ts";

export const HOST_TAG = "pk-annotator";
export const SHORTCUT_LABEL = "Alt+Shift+A";
export const CORNER_KEY = "pka:corner";
const OPEN_KEY = "pka:open";

export type Theme = "light" | "dark";
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type ThemeSignal = { get(): Theme; subscribe(listener: () => void): () => void };

/** What the launcher hands the lazily loaded UI chunk. */
export type UiContext = {
  host: HTMLElement;
  shadow: ShadowRoot;
  hot: ViteHotContext;
  theme: ThemeSignal;
  /** Called by the UI when the dock closes; the launcher shows itself again. */
  hidden(): void;
};

export type UiController = {
  show(): void;
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

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>' +
  '<path d="M12 8v6"/><path d="M9 11h6"/></svg>';

const LAUNCHER_CSS = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 auto auto 0 !important;
  z-index: 2147483647 !important;
}
.pka-launcher {
  all: initial;
  position: fixed;
  box-sizing: border-box;
  width: 36px;
  height: 36px;
  border-radius: 9999px;
  display: grid;
  place-items: center;
  cursor: pointer;
  color: var(--primary-foreground, #fafafa);
  background: var(--primary, #171717);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.12), 0 4px 12px rgb(0 0 0 / 0.12);
  transition: transform 120ms ease-out;
}
:host([data-theme="dark"]) .pka-launcher {
  color: var(--primary-foreground, #171717);
  background: var(--primary, #e5e5e5);
}
.pka-launcher:hover { transform: scale(1.06); }
.pka-launcher:focus-visible { outline: 2px solid var(--ring, #737373); outline-offset: 2px; }
.pka-launcher[hidden] { display: none; }
.pka-launcher[data-corner$="right"] { right: 16px; }
.pka-launcher[data-corner$="left"] { left: 16px; }
.pka-launcher[data-corner^="top"] { top: 16px; }
.pka-launcher[data-corner^="bottom"] { bottom: 16px; }
.pka-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  box-sizing: border-box;
  border-radius: 9999px;
  background: var(--destructive, #dc2626);
  color: #fff;
  font: 600 10px/16px system-ui, sans-serif;
  text-align: center;
}
.pka-badge[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) { .pka-launcher { transition: none; } }
`;

function watchTheme(
  host: HTMLElement,
  theme: "light" | "dark" | "system",
): ThemeSignal & {
  stop(): void;
} {
  const listeners = new Set<() => void>();
  const query = theme === "system" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
  let current: Theme = theme === "system" ? (query?.matches ? "dark" : "light") : theme;
  host.setAttribute("data-theme", current);
  const onChange = (event: MediaQueryListEvent) => {
    current = event.matches ? "dark" : "light";
    host.setAttribute("data-theme", current);
    for (const listener of listeners) listener();
  };
  query?.addEventListener("change", onChange);
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: () => query?.removeEventListener("change", onChange),
  };
}

export type Launcher = { unmount(): void };

/** Creates the host element and the plain DOM launcher; the React UI loads on first open. */
export function createLauncher(hot: ViteHotContext, theme: "light" | "dark" | "system"): Launcher {
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
  button.title = `Annotate (${SHORTCUT_LABEL})`;
  button.innerHTML = ICON;
  const badge = document.createElement("span");
  badge.className = "pka-badge";
  badge.setAttribute("aria-hidden", "true");
  button.append(badge);
  shadow.append(button);
  // Outside body, so a recording video restricted to body by Element Capture leaves the
  // overlay out. React 19 hydration of the document does not report the extra child.
  document.documentElement.append(host);

  const renderBadge = () => {
    const count = getBadge();
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
    button.setAttribute("aria-label", count === 0 ? "Open annotator" : `Open annotator (${count})`);
  };
  renderBadge();
  const stopBadge = subscribeBadge(renderBadge);

  let ui: Promise<UiController> | undefined;
  const loadUi = () => {
    ui ??= import("./app.tsx").then(({ open }) =>
      open({
        host,
        shadow,
        hot,
        theme: themeSignal,
        hidden() {
          sessionStorage.removeItem(OPEN_KEY);
          button.dataset.corner = readCorner();
          button.hidden = false;
          button.focus();
        },
      }),
    );
    return ui;
  };
  const show = async () => {
    const controller = await loadUi();
    button.hidden = true;
    sessionStorage.setItem(OPEN_KEY, "1");
    controller.show();
    return controller;
  };

  button.addEventListener("click", () => void show());
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== "KeyA" || !event.altKey || !event.shiftKey) return;
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    void show().then((controller) => controller.togglePick());
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  if (sessionStorage.getItem(OPEN_KEY) === "1") void show();

  return {
    unmount() {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      stopBadge();
      themeSignal.stop();
      void ui?.then((controller) => controller.unmount());
      host.remove();
    },
  };
}
