import { useText } from "./language.ts";
import {
  GripVerticalIcon,
  MessageSquarePlusIcon,
  MousePointer2Icon,
  SquareDashedMousePointerIcon,
  LassoIcon,
  MinusIcon,
  SettingsIcon,
  VideoIcon,
  BugIcon,
  PencilIcon,
  SquareIcon,
  CircleIcon,
  CameraIcon,
  CropIcon,
  ChevronDownIcon,
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
import { COMPOSE, SETTINGS, useOverlay } from "./context.tsx";
import { CORNER_KEY, SHORTCUT_LABEL, type Corner } from "./launcher.ts";
import { cn } from "./lib/utils.ts";
import { panels } from "./registry.ts";
import { useList, useStore } from "./store.ts";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

const CORNER_CLASS = {
  "top-left": "top-4 left-4",
  "top-right": "top-4 right-4",
  "bottom-left": "bottom-4 left-4",
  "bottom-right": "bottom-4 right-4",
} satisfies Record<Corner, string>;

// shadcn's Toggle marks its pressed state with accent; consumers map accent to their
// selected surface. The dark variant outranks the ghost button's dark hover, which
// would otherwise hide the state under the pointer that just pressed it. A selected
// surface can sit within 1.2:1 of the dock, so a foreground underline carries the state.
const PRESSED =
  "aria-pressed:bg-accent aria-pressed:text-accent-foreground dark:aria-pressed:bg-accent aria-pressed:shadow-[inset_0_-2px_0_var(--foreground)]";

function DockButton({
  label,
  shortcut,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string; shortcut?: string; children: ReactNode }) {
  const t = useText();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t(label)} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {t(label)}
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
  const t = useText();
  const { ui, hide } = useOverlay();
  const picking = useStore(ui, (state) => state.picking);
  const panel = useStore(ui, (state) => state.panel);
  const corner = useStore(ui, (state) => state.corner);
  const selected = useStore(ui, (state) => state.selection.length);
  const busy = useStore(ui, (state) => state.busy);
  const marks = useStore(ui, (state) => state.marks.length);
  const registered = useList(panels);
  const CaptureIcon =
    registered.find((definition) => definition.id === "record")?.icon ?? VideoIcon;
  const dock = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);

  const moveTo = (next: Corner) => {
    localStorage.setItem(CORNER_KEY, next);
    ui.set({ corner: next });
  };
  const togglePick = (mode: PickMode) =>
    ui.set({ picking: picking === mode ? null : mode, gesture: null });
  const togglePanel = (id: string) => {
    ui.set({ panel: panel === id ? null : id });
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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <DockButton
            label="Pick elements"
            shortcut={SHORTCUT_LABEL}
            disabled={busy}
            aria-pressed={picking !== null}
            className="w-10 aria-pressed:bg-pick aria-pressed:text-pick-foreground"
          >
            <MousePointer2Icon />
            <ChevronDownIcon className="size-2.5" />
          </DockButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={corner.startsWith("top") ? "bottom" : "top"}>
          <DropdownMenuItem onSelect={() => togglePick("pick")}>
            <MousePointer2Icon />
            {t("Single")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => togglePick("box")}>
            <SquareDashedMousePointerIcon />
            {t("Box")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => togglePick("lasso")}>
            <LassoIcon />
            {t("Lasso")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <DockButton
            label="Capture"
            disabled={busy}
            aria-pressed={panel === "record"}
            className={cn("w-10", PRESSED)}
          >
            <CaptureIcon />
            <ChevronDownIcon className="size-2.5" />
          </DockButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={corner.startsWith("top") ? "bottom" : "top"}>
          <DropdownMenuItem onSelect={() => togglePanel("record")}>
            <VideoIcon />
            {t("Record")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => ui.set({ panel: "snapshot", picking: null })}>
            <CameraIcon />
            {t("Screenshot")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => ui.set({ gesture: "screenshot", picking: null, panel: null })}
          >
            <CropIcon />
            {t("Crop screenshot")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => ui.set({ gesture: "record-area", picking: null, panel: null })}
          >
            <SquareDashedMousePointerIcon />
            {t("Recording area")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <DockButton label="Annotate" disabled={busy} className="w-10">
            <PencilIcon />
            <ChevronDownIcon className="size-2.5" />
          </DockButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={corner.startsWith("top") ? "bottom" : "top"}>
          <DropdownMenuItem
            onSelect={() => ui.set({ gesture: "rectangle", picking: null, panel: null })}
          >
            <SquareIcon />
            {t("Rectangle")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => ui.set({ gesture: "ellipse", picking: null, panel: null })}
          >
            <CircleIcon />
            {t("Circle")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => ui.set({ gesture: "freehand", picking: null, panel: null })}
          >
            <PencilIcon />
            {t("Freehand")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Separator />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <DockButton
            label="Debug"
            disabled={busy}
            aria-pressed={panel !== "record" && registered.some(({ id }) => id === panel)}
            className={cn("w-10", PRESSED)}
          >
            <BugIcon />
            <ChevronDownIcon className="size-2.5" />
          </DockButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={corner.startsWith("top") ? "bottom" : "top"}>
          {registered
            .filter((definition) => definition.id !== "record")
            .map((definition) => (
              <DropdownMenuItem key={definition.id} onSelect={() => togglePanel(definition.id)}>
                <definition.icon />
                {t(definition.id === "perf" ? "Performance" : definition.label)}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DockButton
        label="Composer"
        disabled={busy}
        aria-pressed={panel === COMPOSE}
        className={cn("relative", PRESSED)}
        onClick={() => togglePanel(COMPOSE)}
      >
        <MessageSquarePlusIcon />
        {marks + (selected > 0 ? 1 : 0) > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-pick px-1 text-[10px] font-semibold text-pick-foreground"
          >
            {marks + (selected > 0 ? 1 : 0)}
          </span>
        )}
      </DockButton>
      <Separator />
      <DockButton
        label="Settings"
        disabled={busy}
        aria-pressed={panel === SETTINGS}
        className={PRESSED}
        onClick={() => togglePanel(SETTINGS)}
      >
        <SettingsIcon />
      </DockButton>
      <DockButton label="Minimize" disabled={busy} onClick={hide}>
        <MinusIcon />
      </DockButton>
    </div>
  );
}
