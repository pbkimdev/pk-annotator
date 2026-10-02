import {
  GripVerticalIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  MousePointer2Icon,
  SquareDashedMousePointerIcon,
  XIcon,
} from "lucide-react";
import {
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import type { PickMode } from "../select/pick.ts";
import { COMPOSE, THREAD, useOverlay } from "./context.tsx";
import { CORNER_KEY, SHORTCUT_LABEL, type Corner } from "./launcher.ts";
import { cn } from "./lib/utils.ts";
import { panels } from "./registry.ts";
import { useList, useStore } from "./store.ts";
import { Button } from "./ui/button.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

const CORNER_CLASS = {
  "top-left": "top-4 left-4",
  "top-right": "top-4 right-4",
  "bottom-left": "bottom-4 left-4",
  "bottom-right": "bottom-4 right-4",
} satisfies Record<Corner, string>;

function DockButton({
  label,
  shortcut,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string; shortcut?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
        {shortcut !== undefined && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

function Separator() {
  return <div aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />;
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

export function Dock() {
  const { ui, thread, hide } = useOverlay();
  const picking = useStore(ui, (state) => state.picking);
  const panel = useStore(ui, (state) => state.panel);
  const corner = useStore(ui, (state) => state.corner);
  const selected = useStore(ui, (state) => state.selection.length);
  const unread = useStore(thread, (state) => state.unread);
  const registered = useList(panels);
  const dock = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);

  const moveTo = (next: Corner) => {
    localStorage.setItem(CORNER_KEY, next);
    ui.set({ corner: next });
  };
  const togglePick = (mode: PickMode) => ui.set({ picking: picking === mode ? null : mode });
  const togglePanel = (id: string) => {
    ui.set({ panel: panel === id ? null : id });
    if (id === THREAD) thread.set({ unread: false });
  };

  const onGripDown = (event: PointerEvent<HTMLButtonElement>) => {
    const rect = dock.current?.getBoundingClientRect();
    if (rect === undefined || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      x: rect.left,
      y: rect.top,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    });
  };
  const onGripMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag === null) return;
    setDrag({ ...drag, x: event.clientX - drag.dx, y: event.clientY - drag.dy });
  };
  const onGripUp = () => {
    const rect = dock.current?.getBoundingClientRect();
    setDrag(null);
    if (rect !== undefined)
      moveTo(nearestCorner(rect.left + rect.width / 2, rect.top + rect.height / 2));
  };
  const onGripKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = ARROW_CORNER.get(event.key)?.(corner);
    if (next === undefined) return;
    event.preventDefault();
    moveTo(next);
  };

  return (
    <div
      ref={dock}
      role="toolbar"
      aria-label="Annotator"
      data-testid="pka-dock"
      className={cn(
        "fixed flex items-center gap-0.5 rounded-xl bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10",
        drag === null && CORNER_CLASS[corner],
        drag === null &&
          "transition-[top,left,right,bottom] duration-150 ease-out motion-reduce:transition-none",
      )}
      style={drag === null ? undefined : { left: drag.x, top: drag.y }}
    >
      <button
        type="button"
        aria-label="Move dock (drag, or arrow keys)"
        title="Move dock (drag, or arrow keys)"
        className="grid h-7 w-4 cursor-grab touch-none place-items-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onKeyDown={onGripKey}
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <DockButton
        label="Pick elements"
        shortcut={SHORTCUT_LABEL}
        aria-pressed={picking === "pick"}
        className="aria-pressed:bg-pick aria-pressed:text-pick-foreground"
        onClick={() => togglePick("pick")}
      >
        <MousePointer2Icon />
      </DockButton>
      <DockButton
        label="Select an area"
        aria-pressed={picking === "box"}
        className="aria-pressed:bg-pick aria-pressed:text-pick-foreground"
        onClick={() => togglePick("box")}
      >
        <SquareDashedMousePointerIcon />
      </DockButton>
      {registered.length > 0 && <Separator />}
      {registered.map((definition) => (
        <DockButton
          key={definition.id}
          label={definition.label}
          aria-pressed={panel === definition.id}
          className="aria-pressed:bg-muted"
          onClick={() => togglePanel(definition.id)}
        >
          <definition.icon />
        </DockButton>
      ))}
      <Separator />
      <DockButton
        label={selected > 0 ? `Compose (${selected} selected)` : "Compose"}
        aria-pressed={panel === COMPOSE}
        className="relative aria-pressed:bg-muted"
        onClick={() => togglePanel(COMPOSE)}
      >
        <MessageSquarePlusIcon />
        {selected > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-pick px-1 text-[10px] leading-none font-semibold text-pick-foreground"
          >
            {selected}
          </span>
        )}
      </DockButton>
      <DockButton
        label={unread ? "Sent annotations (new replies)" : "Sent annotations"}
        aria-pressed={panel === THREAD}
        className="relative aria-pressed:bg-muted"
        onClick={() => togglePanel(THREAD)}
      >
        <MessagesSquareIcon />
        {unread && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 size-1.5 rounded-full bg-pick ring-2 ring-popover"
          />
        )}
      </DockButton>
      <Separator />
      <DockButton label="Close annotator" onClick={hide}>
        <XIcon />
      </DockButton>
    </div>
  );
}
