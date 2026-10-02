import { NetworkIcon, SquareTerminalIcon } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PromptInputProvider } from "./ai-elements/prompt-input.tsx";
import { OverlayContext, useOverlay, type Overlay, type UiState } from "./context.tsx";
import { Dock } from "./dock.tsx";
import { readCorner, type UiContext, type UiController } from "./launcher.ts";
import { PanelHost } from "./panel.tsx";
import { ConsolePanel } from "./panels/console.tsx";
import { stopHuntTracking } from "./panels/hunt.ts";
import { NetworkPanel } from "./panels/network.tsx";
import { registerPerfPanel } from "./panels/perf.tsx";
import { registerRecordPanel } from "./panels/record.tsx";
import { PickLayer } from "./pick-layer.tsx";
import { PortalContainerContext } from "./portal-container.tsx";
import { registerPanel } from "./registry.ts";
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
  return (
    <>
      <PickLayer />
      {visible && (
        <>
          <Dock />
          <PanelHost />
        </>
      )}
    </>
  );
}

/** Mounts the React UI into the launcher's shadow root. Called once, on first open. */
export function open(context: UiContext): UiController {
  const { host, shadow, hot, theme } = context;
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, propertySheet];
  shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, overlaySheet];
  const restoreActiveElement = patchActiveElement(shadow);

  const appRoot = document.createElement("div");
  appRoot.className = "pka-root";
  const portalRoot = document.createElement("div");
  portalRoot.className = "pka-root";
  shadow.append(appRoot, portalRoot);
  const applyTheme = () => {
    for (const element of [appRoot, portalRoot]) {
      element.classList.toggle("dark", theme.get() === "dark");
    }
  };
  applyTheme();
  const stopTheme = theme.subscribe(applyTheme);

  const ui = createStore<UiState>({
    visible: false,
    picking: null,
    panel: null,
    selection: [],
    hover: null,
    marquee: null,
    corner: readCorner(),
  });
  const thread = connectThread(hot);
  const overlay: Overlay = {
    host,
    hot,
    theme,
    ui,
    thread,
    hide() {
      ui.set({ visible: false, picking: null, hover: null, marquee: null });
      context.hidden();
    },
  };

  const stopPanels = [
    registerRecordPanel(),
    registerPanel({ id: "network", label: "Network", icon: NetworkIcon, component: NetworkPanel }),
    registerPanel({
      id: "console",
      label: "Console",
      icon: SquareTerminalIcon,
      component: ConsolePanel,
    }),
    registerPerfPanel(),
  ];

  const root = createRoot(appRoot);
  root.render(
    <StrictMode>
      <OverlayContext value={overlay}>
        <PortalContainerContext value={portalRoot}>
          <TooltipProvider delayDuration={400}>
            <PromptInputProvider>
              <App />
            </PromptInputProvider>
          </TooltipProvider>
        </PortalContainerContext>
      </OverlayContext>
    </StrictMode>,
  );

  return {
    show() {
      ui.set({ visible: true, corner: readCorner() });
    },
    togglePick() {
      ui.set({ visible: true, picking: ui.get().picking === null ? "pick" : null });
    },
    unmount() {
      root.unmount();
      for (const stop of stopPanels) stop();
      stopHuntTracking();
      stopTheme();
      thread.disconnect();
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
