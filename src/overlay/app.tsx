import { ArrowDownUpIcon, TerminalIcon } from "lucide-react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { OverlayContext, NOTE, useOverlay, type Overlay, type UiState } from "./context.tsx";
import { readCorner, type UiContext, type UiController } from "./launcher.ts";
import { PanelHost } from "./panel.tsx";
import { ConsolePanel } from "./panels/console.tsx";
import { stopHuntTracking } from "./panels/hunt.ts";
import { NetworkPanel } from "./panels/network.tsx";
import { registerPerfPanel } from "./panels/perf.tsx";
import { registerRecordPanel } from "./panels/record.tsx";
import { MarkLayer } from "./mark-layer.tsx";
import { PickLayer } from "./pick-layer.tsx";
import { PortalContainerContext } from "./portal-container.tsx";
import { RadialMenu } from "./radial-menu.tsx";
import { attachments, registerPanel } from "./registry.ts";
import css from "./shadow.css?inline";
import { createStore, useStore } from "./store.ts";
import { connectThread } from "./thread-store.ts";
import { TooltipProvider } from "./ui/tooltip.tsx";

const overlaySheet = new CSSStyleSheet();
overlaySheet.replaceSync(css);

// Chromium ignores @property inside shadow trees (tailwindlabs/tailwindcss#15005), so the
// compiled @property rules are adopted once on the document.
const propertySheet = new CSSStyleSheet();
propertySheet.replaceSync(
  [...overlaySheet.cssRules]
    .filter((rule) => rule instanceof CSSPropertyRule)
    .map((rule) => rule.cssText)
    .join("\n"),
);

// Radix Select, Menu, and FocusScope compare against document.activeElement, which the
// browser retargets to the shadow host. While mounted, report the focused element inside
// the shadow root, and only when the native value is our host.
function patchActiveElement(shadow: ShadowRoot): () => void {
  const native = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement")?.get;
  if (native === undefined) throw new Error("Document.prototype.activeElement has no getter");
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get(this: Document) {
      const active: Element | null = native.call(this);
      return active === shadow.host ? (shadow.activeElement ?? active) : active;
    },
  });
  return () => {
    Reflect.deleteProperty(document, "activeElement");
  };
}

function App() {
  const { ui } = useOverlay();
  const visible = useStore(ui, (state) => state.visible);
  useEffect(() => {
    let previous = attachments.get();
    const stop = attachments.subscribe(() => {
      const next = attachments.get();
      if (next.some((item) => !previous.includes(item))) ui.set({ panel: NOTE });
      previous = next;
    });
    return () => {
      stop();
    };
  }, [ui]);
  return (
    <>
      <PickLayer />
      <MarkLayer />
      {visible && <PanelHost />}
      <RadialMenu />
    </>
  );
}

/** Mounts the React UI into the launcher's shadow root. Called once, on first open. */
export function open(context: UiContext): UiController {
  const { host, shadow, hot, theme, hub } = context;
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, propertySheet];
  shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, overlaySheet];
  const restoreActiveElement = patchActiveElement(shadow);

  const appRoot = document.createElement("div");
  appRoot.className = "pka-root";
  const portalRoot = document.createElement("div");
  portalRoot.className = "pka-root";
  // The hub follows the app root, so it stays clickable above the pick and drawing layers.
  shadow.insertBefore(appRoot, hub);
  shadow.append(portalRoot);
  const applyTheme = () => {
    for (const element of [appRoot, portalRoot]) {
      element.classList.toggle("dark", theme.get() === "dark");
    }
  };
  applyTheme();
  const stopTheme = theme.subscribe(applyTheme);

  const ui = createStore<UiState>({
    visible: false,
    menu: "closed",
    prompt: "",
    globalPrompt: "",
    marks: [],
    editing: null,
    busy: false,
    recording: false,
    gesture: null,
    recordRegion: null,
    language: localStorage.getItem("pka:language") === "ko" ? "ko" : "en",
    picking: null,
    panel: null,
    selection: [],
    hover: null,
    lasso: null,
    marquee: null,
    corner: readCorner(),
  });
  const thread = connectThread(hot);
  const overlay: Overlay = {
    host,
    hub,
    hot,
    theme,
    ui,
    thread,
    exit: context.exit,
    hide() {
      ui.set({
        visible: false,
        menu: "closed",
        picking: null,
        gesture: null,
        hover: null,
        marquee: null,
      });
      context.hidden();
    },
  };

  const stopPanels = [
    registerRecordPanel((recording) => ui.set({ recording })),
    registerPanel({
      id: "network",
      label: "Network",
      icon: ArrowDownUpIcon,
      component: NetworkPanel,
    }),
    registerPanel({ id: "console", label: "Console", icon: TerminalIcon, component: ConsolePanel }),
    registerPerfPanel(),
  ];

  const root = createRoot(appRoot);
  root.render(
    <StrictMode>
      <OverlayContext value={overlay}>
        <PortalContainerContext value={portalRoot}>
          <TooltipProvider delayDuration={400}>
            <App />
          </TooltipProvider>
        </PortalContainerContext>
      </OverlayContext>
    </StrictMode>,
  );

  return {
    show() {
      ui.set({ visible: true });
    },
    toggleMenu(fromKeyboard) {
      const { visible, menu } = ui.get();
      if (visible && menu !== "closed") ui.set({ menu: "closed" });
      else ui.set({ visible: true, menu: fromKeyboard ? "keyboard" : "pointer" });
    },
    closeMenu() {
      ui.set({ menu: "closed" });
    },
    setCorner(corner) {
      ui.set({ corner, menu: "closed" });
    },
    togglePick() {
      if (ui.get().busy) return;
      ui.set({ visible: true, picking: ui.get().picking === null ? "pick" : null });
    },
    unmount() {
      root.unmount();
      for (const stop of stopPanels) stop();
      stopHuntTracking();
      stopTheme();
      thread.disconnect();
      attachments.clear();
      restoreActiveElement();
      appRoot.remove();
      portalRoot.remove();
      shadow.adoptedStyleSheets = shadow.adoptedStyleSheets.filter(
        (sheet) => sheet !== overlaySheet,
      );
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (sheet) => sheet !== propertySheet,
      );
    },
  };
}
