import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { COMPOSE, THREAD, useOverlay } from "./context.tsx";
import { Composer } from "./composer.tsx";
import type { Corner } from "./launcher.ts";
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
  const { ui } = useOverlay();
  const corner = useStore(ui, (state) => state.corner);
  return (
    <section
      aria-label={title}
      data-testid="pka-panel"
      className={cn(
        "fixed flex max-h-[min(36rem,calc(100vh-6rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10",
        "animate-in duration-150 fade-in-0 zoom-in-[0.98] motion-reduce:animate-none",
        PANEL_CORNER[corner],
      )}
    >
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b pr-1.5 pl-3">
        <h2 className="text-sm font-medium">{title}</h2>
        <Button variant="ghost" size="icon-xs" aria-label={`Close ${title}`} onClick={close}>
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

/** Renders the one open panel beside the dock. */
export function PanelHost() {
  const { ui } = useOverlay();
  const panel = useStore(ui, (state) => state.panel);
  const registered = useList(panels);
  const close = () => ui.set({ panel: null });

  if (panel === COMPOSE) {
    return (
      <PanelFrame title="Compose" close={close}>
        <Composer />
      </PanelFrame>
    );
  }
  if (panel === THREAD) {
    return (
      <PanelFrame title="Sent annotations" close={close}>
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
