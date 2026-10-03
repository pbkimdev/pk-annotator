import { ArrowDownUpIcon, ClipboardCheckIcon, ClipboardXIcon, TerminalIcon } from "lucide-react";
import { StrictMode, useEffect, useId, useRef } from "react";
import { createRoot } from "react-dom/client";

import {
  COPIED_HINT_KEY,
  OverlayContext,
  NOTE,
  useOverlay,
  type Overlay,
  type UiState,
} from "./context.tsx";
import { useText } from "./language.ts";
import { readCorner, type Corner, type UiContext, type UiController } from "./launcher.ts";
import { cn } from "./lib/utils.ts";
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
import { Button } from "./ui/button.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const SELECT_TIP_KEY = "pka:select-tip";
const SELECT_TIP_LIMIT = 3;

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

// The panel anchors from panel.tsx, so the pop-up sits where a panel opens beside the hub.
const POPUP_CORNER = {
  "top-left": "top-19 left-5 origin-top-left slide-in-from-top-2",
  "top-right": "top-19 right-5 origin-top-right slide-in-from-top-2",
  "bottom-left": "bottom-19 left-5 origin-bottom-left slide-in-from-bottom-2",
  "bottom-right": "bottom-19 right-5 origin-bottom-right slide-in-from-bottom-2",
} satisfies Record<Corner, string>;

/** Reports the clipboard copy made by a Send while no agent is connected. */
function CopiedDialog({ outcome }: { outcome: "ok" | "failed" }) {
  const t = useText();
  const { ui, hub } = useOverlay();
  const corner = useStore(ui, (state) => state.corner);
  const ok = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const lineId = useId();
  useEffect(() => {
    ok.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      ui.set({ copied: null });
      hub.focus();
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
    };
  }, [ui, hub]);
  const close = () => {
    ui.set({ copied: null });
    hub.focus();
  };
  const Icon = outcome === "ok" ? ClipboardCheckIcon : ClipboardXIcon;
  return (
    <section
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={lineId}
      data-testid="pka-copied"
      data-outcome={outcome}
      className={cn(
        "fixed z-10 flex w-max max-w-[calc(100vw-2.5rem)] min-w-[min(20rem,calc(100vw-2.5rem))] flex-col gap-3 rounded-[20px] bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10",
        "shadow-[0_1px_2px_rgb(0_0_0/0.08),0_24px_48px_-16px_rgb(0_0_0/0.3)] dark:shadow-[0_1px_2px_rgb(0_0_0/0.3),0_24px_56px_-12px_rgb(0_0_0/0.6)]",
        "animate-in duration-200 ease-out fade-in-0 zoom-in-[0.96] motion-reduce:animate-none",
        POPUP_CORNER[corner],
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={cn(
            "mt-px size-4 shrink-0",
            outcome === "ok" ? "text-muted-foreground" : "text-destructive",
          )}
          strokeWidth={1.75}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={titleId} className="text-[13px] font-semibold tracking-[-0.005em]">
            {t(outcome === "ok" ? "Copied to clipboard" : "Couldn't copy to clipboard")}
          </h2>
          <p id={lineId} className="text-[13px] whitespace-nowrap text-muted-foreground">
            {t("Connect an agent over MCP for live replies")}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-3">
        {outcome === "ok" && (
          <label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 accent-primary dark:scheme-dark"
              onChange={(event) => {
                if (event.currentTarget.checked) sessionStorage.setItem(COPIED_HINT_KEY, "off");
                else sessionStorage.removeItem(COPIED_HINT_KEY);
              }}
            />
            {t("Don't show again")}
          </label>
        )}
        <Button ref={ok} size="sm" className="rounded-full px-4" onClick={close}>
          {t("OK")}
        </Button>
      </div>
    </section>
  );
}

function App() {
  const { ui } = useOverlay();
  const visible = useStore(ui, (state) => state.visible);
  const copied = useStore(ui, (state) => state.copied);
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
      {visible && copied !== null && <CopiedDialog outcome={copied} />}
      <RadialMenu />
    </>
  );
}

/** Mounts the React UI into the launcher's shadow root. Called once, on first open. */
export function open(context: UiContext): UiController {
  const { host, shadow, hot, theme, hub, thread } = context;
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
    language: localStorage.getItem("pka:language") === "ko" ? "ko" : "en",
    picking: null,
    selectTip: false,
    panel: null,
    selection: [],
    tooMany: null,
    hover: null,
    lasso: null,
    marquee: null,
    corner: readCorner(),
    copied: null,
  });
  let markCount = 0;
  const stopMarkCount = ui.subscribe(() => {
    const { length } = ui.get().marks;
    if (length === markCount) return;
    markCount = length;
    context.setMarkCount(length);
  });
  const overlay: Overlay = {
    host,
    hub,
    hot,
    theme,
    ui,
    thread,
    exit: context.exit,
  };
  // Counted here, outside React, so every way into Select counts once, including the
  // shortcut that opens the overlay before its first render.
  let picking = ui.get().picking;
  const stopSelectTip = ui.subscribe(() => {
    const next = ui.get().picking;
    if (next === picking) return;
    picking = next;
    if (next !== "pick") {
      if (ui.get().selectTip) ui.set({ selectTip: false });
      return;
    }
    const shown = Number(sessionStorage.getItem(SELECT_TIP_KEY));
    if (!(shown < SELECT_TIP_LIMIT)) return;
    sessionStorage.setItem(SELECT_TIP_KEY, String(shown + 1));
    ui.set({ selectTip: true });
  });

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
      stopSelectTip();
      stopMarkCount();
      for (const stop of stopPanels) stop();
      stopHuntTracking();
      stopTheme();
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
