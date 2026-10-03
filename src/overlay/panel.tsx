import { useText } from "./language.ts";
import { XIcon, HistoryIcon, LogOutIcon } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";

import { COMPOSE, NOTE, SETTINGS, THREAD, useOverlay } from "./context.tsx";
const Composer = lazy(() =>
  import("./composer.tsx").then((module) => ({ default: module.Composer })),
);
import type { Corner } from "./launcher.ts";
import { ScreenshotPanel } from "./mark-layer.tsx";
import { cn } from "./lib/utils.ts";
import { panels } from "./registry.ts";
import { useList, useStore } from "./store.ts";
import { Thread } from "./thread.tsx";
import { Button } from "./ui/button.tsx";

// The dock is 36 px tall at a 16 px inset; panels open 8 px beyond it.
const PANEL_CORNER = {
  "top-left": "top-15 left-4",
  "top-right": "top-15 right-4",
  "bottom-left": "bottom-15 left-4",
  "bottom-right": "bottom-15 right-4",
} satisfies Record<Corner, string>;

function PanelFrame({
  title,
  close,
  children,
}: {
  title: string;
  close(): void;
  children: ReactNode;
}) {
  const t = useText();
  const { ui } = useOverlay();
  const corner = useStore(ui, (state) => state.corner);
  return (
    <section
      aria-label={t(title)}
      data-testid="pka-panel"
      className={cn(
        "fixed flex max-h-[min(36rem,calc(100vh-6rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10",
        "animate-in duration-150 fade-in-0 zoom-in-[0.98] motion-reduce:animate-none",
        PANEL_CORNER[corner],
      )}
    >
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b pr-1.5 pl-3">
        <h2 className="text-sm font-medium">{t(title)}</h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`${t("Close")} ${t(title)}`}
          onClick={close}
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

/** Renders the one open panel beside the dock. */
export function PanelHost() {
  const t = useText();
  const { ui } = useOverlay();
  const panel = useStore(ui, (state) => state.panel);
  const registered = useList(panels);
  const language = useStore(ui, (state) => state.language);
  const { thread, exit } = useOverlay();
  const busy = useStore(ui, (state) => state.busy);
  const close = () => {
    if (!busy) ui.set({ panel: null });
  };

  if (panel === "snapshot")
    return (
      <PanelFrame title="Screenshot" close={close}>
        <ScreenshotPanel />
      </PanelFrame>
    );
  if (panel === SETTINGS)
    return (
      <PanelFrame title="Settings" close={close}>
        <div className="space-y-3 p-3">
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              thread.set({ unread: false });
              ui.set({ panel: THREAD });
            }}
          >
            <HistoryIcon />
            {t("History")}
          </Button>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t("Language")}
            <select
              aria-label={t("Language")}
              value={language}
              className="rounded-md border bg-background px-2 py-1"
              onChange={(event) => {
                const next = event.target.value;
                if (next !== "en" && next !== "ko") throw new Error("Unsupported language");
                localStorage.setItem("pka:language", next);
                ui.set({ language: next });
              }}
            >
              <option value="en">English</option>
              <option value="ko">한국어</option>
            </select>
          </label>
          <Button variant="ghost" className="w-full justify-start text-destructive" onClick={exit}>
            <LogOutIcon />
            {t("Exit annotator")}
          </Button>
        </div>
      </PanelFrame>
    );
  if (panel === COMPOSE || panel === NOTE) {
    return (
      <PanelFrame title={panel === COMPOSE ? "Composer" : "Annotation"} close={close}>
        <Suspense
          fallback={<p className="p-3 text-sm text-muted-foreground">{t("Loading editor…")}</p>}
        >
          <Composer batch={panel === COMPOSE} />
        </Suspense>
      </PanelFrame>
    );
  }
  if (panel === THREAD) {
    return (
      <PanelFrame title="History" close={close}>
        <Thread />
      </PanelFrame>
    );
  }
  const definition = registered.find((candidate) => candidate.id === panel);
  if (definition === undefined) return null;
  return (
    <PanelFrame title={definition.label} close={close}>
      <definition.component close={close} />
    </PanelFrame>
  );
}
