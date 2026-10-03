import { useText } from "./language.ts";
import { HistoryIcon, PenLineIcon, SendIcon, XIcon } from "lucide-react";
import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

import { AgentIcon } from "./agent-icon.tsx";
import { COMPOSE, NOTE, THREAD, useOverlay } from "./context.tsx";
const Composer = lazy(() =>
  import("./composer.tsx").then((module) => ({ default: module.Composer })),
);
import type { Corner } from "./launcher.ts";
import { cn } from "./lib/utils.ts";
import { panels } from "./registry.ts";
import { useList, useStore } from "./store.ts";
import { Thread } from "./thread.tsx";
import { Button } from "./ui/button.tsx";

// The hub is 44 px at a 20 px inset; panels open 12 px beyond it and grow out of its corner.
const PANEL_CORNER = {
  "top-left": "top-19 left-5 origin-top-left slide-in-from-top-2",
  "top-right": "top-19 right-5 origin-top-right slide-in-from-top-2",
  "bottom-left": "bottom-19 left-5 origin-bottom-left slide-in-from-bottom-2",
  "bottom-right": "bottom-19 right-5 origin-bottom-right slide-in-from-bottom-2",
} satisfies Record<Corner, string>;

function PanelFrame({
  id,
  title,
  icon: Icon,
  close,
  children,
}: {
  /** Names the panel's icon in an agent theme. */
  id: string;
  title: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  close(): void;
  children: ReactNode;
}) {
  const t = useText();
  const { ui } = useOverlay();
  const corner = useStore(ui, (state) => state.corner);
  // Hidden rather than unmounted, so drafts, dictation, and panel state survive the menu.
  const menuOpen = useStore(ui, (state) => state.menu !== "closed");
  return (
    <section
      aria-label={t(title)}
      data-testid="pka-panel"
      hidden={menuOpen}
      className={cn(
        "pka-panel fixed flex max-h-[min(38rem,calc(100vh-7rem))] w-[min(25rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-[20px] bg-popover text-popover-foreground ring-1 ring-foreground/10",
        "shadow-[0_1px_2px_rgb(0_0_0/0.08),0_24px_48px_-16px_rgb(0_0_0/0.3)] dark:shadow-[0_1px_2px_rgb(0_0_0/0.3),0_24px_56px_-12px_rgb(0_0_0/0.6)]",
        "animate-in duration-150 ease-out fade-in-0 zoom-in-[0.96] motion-reduce:animate-none",
        PANEL_CORNER[corner],
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 pr-2 pl-4">
        <AgentIcon name={id} icon={Icon} className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.005em]">
          {t(title)}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full text-muted-foreground"
          aria-label={`${t("Close")} ${t(title)}`}
          onClick={close}
        >
          <AgentIcon name="close" icon={XIcon} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

/** Renders the one open panel beside the hub. */
export function PanelHost() {
  const t = useText();
  const { ui } = useOverlay();
  const panel = useStore(ui, (state) => state.panel);
  const registered = useList(panels);
  const busy = useStore(ui, (state) => state.busy);
  const close = () => {
    if (!busy) ui.set({ panel: null });
  };

  if (panel === COMPOSE || panel === NOTE) {
    return (
      <PanelFrame
        id={panel === COMPOSE ? "compose" : "note"}
        title={panel === COMPOSE ? "Send" : "Annotation"}
        icon={panel === COMPOSE ? SendIcon : PenLineIcon}
        close={close}
      >
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
      <PanelFrame id="history" title="History" icon={HistoryIcon} close={close}>
        <Thread />
      </PanelFrame>
    );
  }
  const definition = registered.find((candidate) => candidate.id === panel);
  if (definition === undefined) return null;
  return (
    <PanelFrame id={definition.id} title={definition.label} icon={definition.icon} close={close}>
      <definition.component close={close} />
    </PanelFrame>
  );
}
