import {
  ApertureIcon,
  BugIcon,
  CameraIcon,
  CircleDotIcon,
  CircleIcon,
  CropIcon,
  FocusIcon,
  HistoryIcon,
  LanguagesIcon,
  LassoSelectIcon,
  LayersIcon,
  LineSquiggleIcon,
  Minimize2Icon,
  MousePointer2Icon,
  MousePointerClickIcon,
  PenToolIcon,
  PowerIcon,
  RectangleHorizontalIcon,
  Settings2Icon,
  SquareDashedMousePointerIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";

import type { PickMode } from "../select/pick.ts";
import { COMPOSE, THREAD, useOverlay, type UiState } from "./context.tsx";
import { useText } from "./language.ts";
import { HUB_INSET, HUB_SIZE, SHORTCUT_LABEL, type Corner } from "./launcher.ts";
import { panels } from "./registry.ts";
import { useList, useStore } from "./store.ts";

const MENU_ID = "pka-menu";
const ITEM = 40;
const BAND = 52;
// Radii from the hub's center: items on the first ring, a group's children on the second.
// The gap keeps the two bands apart under the blur, so they join only at the stem.
const RING = 156;
const BRANCH = RING + BAND + 20;
// Room past the outermost band and past the hub for the round caps and the blur.
const MARGIN = BAND / 2 + 24;
const CANVAS = BRANCH + MARGIN;
const HINT_RADIUS = 78;
/** Each corner's menu sweeps counterclockwise through the quadrant that faces the page. */
const START = {
  "bottom-left": 0,
  "bottom-right": 90,
  "top-right": 180,
  "top-left": 270,
} satisfies Record<Corner, number>;
const SPAN = 90;
const BRANCH_STEP = ((ITEM + 8) / BRANCH) * (180 / Math.PI);
const STEM_MS = 100;
const SWEEP_MS = 300;
const HOVER_INTENT_MS = 140;

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>;
type Leaf = {
  id: string;
  label: string;
  icon: Icon;
  /** Present on toggles; a toggle is announced as a checkbox item. */
  checked?: boolean;
  shortcut?: string;
  badge?: number;
  /** Keeps the menu open, so the change is visible in place. */
  stay?: boolean;
  run(): void;
};
type Group = { id: string; label: string; icon: Icon; active: boolean; children: Leaf[] };
type Entry = Leaf | Group;
type Hint = { id: string; label: string; shortcut?: string };

function polar(radius: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return { x: radius * Math.cos(radians), y: -radius * Math.sin(radians) };
}

/** An arc on screen from one angle to the other, so a dash drawn along it grows that way. */
function arc(radius: number, from: number, to: number): string {
  const a = polar(radius, from);
  const b = polar(radius, to);
  const clockwise = to < from ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${radius} ${radius} 0 0 ${clockwise} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/** A straight stroke along a radius, from the inner radius outward. */
function ray(degrees: number, from: number, to: number): string {
  const a = polar(from, degrees);
  const b = polar(to, degrees);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} L ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/**
 * Children run counterclockwise from their parent, or clockwise where the quadrant ends
 * first, so the ring grows out of its parent. A ring too long for either side is pulled
 * back inside the quadrant.
 */
function branchAngles(start: number, parent: number, count: number): number[] {
  const span = (count - 1) * BRANCH_STEP;
  let first = parent;
  let step = BRANCH_STEP;
  if (parent + span > start + SPAN) {
    if (parent - span >= start) step = -BRANCH_STEP;
    else first = start + SPAN - span;
  }
  return Array.from({ length: count }, (_, index) => first + index * step);
}

function useEntries(): Entry[] {
  const t = useText();
  const { ui, thread, hide, exit } = useOverlay();
  const picking = useStore(ui, (state) => state.picking);
  const gesture = useStore(ui, (state) => state.gesture);
  const panel = useStore(ui, (state) => state.panel);
  const recording = useStore(ui, (state) => state.recording);
  const language = useStore(ui, (state) => state.language);
  const pending = useStore(
    ui,
    (state) => state.marks.length + (state.selection.length > 0 ? 1 : 0),
  );
  const registered = useList(panels);
  const debug = registered.filter((definition) => definition.id !== "record");

  const togglePick = (mode: PickMode) =>
    ui.set({ picking: picking === mode ? null : mode, gesture: null });
  const togglePanel = (id: string) => ui.set({ panel: panel === id ? null : id });
  const toggleGesture = (mode: NonNullable<UiState["gesture"]>) =>
    ui.set({ gesture: gesture === mode ? null : mode, picking: null, panel: null });

  return [
    {
      id: "pick",
      label: t("Pick elements"),
      icon: MousePointer2Icon,
      active: picking !== null,
      children: [
        {
          id: "single",
          label: t("Single"),
          icon: MousePointerClickIcon,
          checked: picking === "pick",
          shortcut: SHORTCUT_LABEL,
          run: () => togglePick("pick"),
        },
        {
          id: "box",
          label: t("Box"),
          icon: SquareDashedMousePointerIcon,
          checked: picking === "box",
          run: () => togglePick("box"),
        },
        {
          id: "lasso",
          label: t("Lasso"),
          icon: LassoSelectIcon,
          checked: picking === "lasso",
          run: () => togglePick("lasso"),
        },
      ],
    },
    {
      id: "capture",
      label: t("Capture"),
      icon: ApertureIcon,
      active:
        recording ||
        panel === "record" ||
        panel === "snapshot" ||
        gesture === "screenshot" ||
        gesture === "record-area",
      children: [
        {
          id: "record",
          label: t("Record"),
          icon: CircleDotIcon,
          checked: panel === "record",
          run: () => togglePanel("record"),
        },
        {
          id: "screenshot",
          label: t("Screenshot"),
          icon: CameraIcon,
          run: () => ui.set({ panel: "snapshot", picking: null }),
        },
        {
          id: "crop",
          label: t("Crop screenshot"),
          icon: CropIcon,
          checked: gesture === "screenshot",
          run: () => toggleGesture("screenshot"),
        },
        {
          id: "area",
          label: t("Recording area"),
          icon: FocusIcon,
          checked: gesture === "record-area",
          run: () => toggleGesture("record-area"),
        },
      ],
    },
    {
      id: "annotate",
      label: t("Annotate"),
      icon: PenToolIcon,
      active: gesture === "rectangle" || gesture === "ellipse" || gesture === "freehand",
      children: [
        {
          id: "rectangle",
          label: t("Rectangle"),
          icon: RectangleHorizontalIcon,
          checked: gesture === "rectangle",
          run: () => toggleGesture("rectangle"),
        },
        {
          id: "ellipse",
          label: t("Circle"),
          icon: CircleIcon,
          checked: gesture === "ellipse",
          run: () => toggleGesture("ellipse"),
        },
        {
          id: "freehand",
          label: t("Freehand"),
          icon: LineSquiggleIcon,
          checked: gesture === "freehand",
          run: () => toggleGesture("freehand"),
        },
      ],
    },
    {
      id: "debug",
      label: t("Debug"),
      icon: BugIcon,
      active: debug.some((definition) => definition.id === panel),
      children: debug.map((definition) => ({
        id: definition.id,
        label: t(definition.id === "perf" ? "Performance" : definition.label),
        icon: definition.icon,
        checked: panel === definition.id,
        run: () => togglePanel(definition.id),
      })),
    },
    {
      id: "compose",
      label: t("Composer"),
      icon: LayersIcon,
      checked: panel === COMPOSE,
      badge: pending,
      run: () => togglePanel(COMPOSE),
    },
    {
      id: "settings",
      label: t("Settings"),
      icon: Settings2Icon,
      active: panel === THREAD,
      children: [
        {
          id: "history",
          label: t("History"),
          icon: HistoryIcon,
          checked: panel === THREAD,
          run() {
            thread.set({ unread: false });
            togglePanel(THREAD);
          },
        },
        {
          id: "language",
          label: `${t("Language")}: ${language === "ko" ? "한국어" : "English"}`,
          icon: LanguagesIcon,
          stay: true,
          run() {
            const next = language === "ko" ? "en" : "ko";
            localStorage.setItem("pka:language", next);
            ui.set({ language: next });
          },
        },
        { id: "minimize", label: t("Minimize"), icon: Minimize2Icon, run: hide },
        { id: "exit", label: t("Exit annotator"), icon: PowerIcon, run: exit },
      ],
    },
  ];
}

/** One item on a ring. Its position, entrance order, and exit order come from the menu. */
function Node({
  entry,
  angle,
  radius,
  order,
  count,
  shown,
  ...props
}: {
  entry: Entry;
  angle: number;
  radius: number;
  order: number;
  count: number;
  shown: boolean;
} & Omit<ComponentProps<"button">, "children" | "className" | "style">) {
  const { x, y } = polar(radius, angle);
  // Items enter in the order the band reaches them and leave in reverse.
  const enter = Math.round(STEM_MS + (order / Math.max(count - 1, 1)) * (SWEEP_MS - 120));
  const leave = (count - 1 - order) * 18;
  const tick = polar(15, angle);
  return (
    <button
      type="button"
      tabIndex={shown ? 0 : -1}
      aria-label={entry.label}
      data-open={shown ? "" : undefined}
      className="pka-node"
      style={{
        transform: shown
          ? `translate(${x}px, ${y}px)`
          : `translate(${x * 0.82}px, ${y * 0.82}px) scale(0.5)`,
        transitionDelay: shown
          ? `${enter}ms, ${enter}ms, 0ms, 0ms, 0ms`
          : `${leave}ms, ${leave}ms, ${leave + 180}ms, 0ms, 0ms`,
      }}
      {...props}
    >
      <entry.icon className="size-[18px]" strokeWidth={1.75} />
      {"children" in entry && (
        <span
          aria-hidden="true"
          className="pka-node-tick"
          style={{ left: ITEM / 2 + tick.x - 2, top: ITEM / 2 + tick.y - 2 }}
        />
      )}
      {"badge" in entry && entry.badge !== undefined && entry.badge > 0 && (
        <span aria-hidden="true" className="pka-node-badge">
          {entry.badge > 99 ? "99+" : entry.badge}
        </span>
      )}
    </button>
  );
}

type Ring = { id: string; stem: string; band: string; open: boolean };

/**
 * The menu's surface. A disk under the hub and each ring's stem and band are blurred and
 * thresholded into one shape, so the joins round off; the shape is then filled and edged.
 */
function Body({ x, y, rings }: { x: number; y: number; rings: Ring[] }) {
  const area = { x, y, width: CANVAS + MARGIN, height: CANVAS + MARGIN };
  return (
    <svg
      aria-hidden="true"
      className="pka-body"
      data-open={rings.some((ring) => ring.open) ? "" : undefined}
      viewBox={`${x} ${y} ${area.width} ${area.height}`}
      style={{ left: x, top: y, width: area.width, height: area.height }}
    >
      <filter id="pka-body" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB" {...area}>
        <feGaussianBlur in="SourceAlpha" stdDeviation={8} />
        <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 20 -8.5" result="shape" />
        <feMorphology in="shape" operator="dilate" radius={1} result="outline" />
        <feFlood className="pka-body-edge" />
        <feComposite in2="outline" operator="in" result="edge" />
        <feFlood className="pka-body-fill" />
        <feComposite in2="shape" operator="in" result="fill" />
        <feMerge>
          <feMergeNode in="edge" />
          <feMergeNode in="fill" />
        </feMerge>
      </filter>
      <g filter="url(#pka-body)">
        <circle r={HUB_SIZE / 2 + 1} />
        {rings.map((ring) => (
          <g key={ring.id} className="pka-ring" data-open={ring.open ? "" : undefined}>
            <path className="pka-ring-stem" d={ring.stem} pathLength={1} />
            <path className="pka-ring-band" d={ring.band} pathLength={1} />
          </g>
        ))}
      </g>
    </svg>
  );
}

/** Moves focus among sibling items with the menu keys; returns whether it handled the key. */
function moveFocus(siblings: HTMLElement[], current: HTMLElement, key: string): boolean {
  // From the menu itself, Down reaches the first item and Up the last.
  const index = siblings.indexOf(current);
  const target = {
    ArrowDown: siblings[(index + 1) % siblings.length],
    ArrowUp: siblings[((index === -1 ? 0 : index) - 1 + siblings.length) % siblings.length],
    Home: siblings[0],
    End: siblings.at(-1),
  }[key];
  if (target === undefined) return false;
  target.focus();
  return true;
}

/**
 * The hub's menu: a ring of items that sweeps counterclockwise out of the hub's corner.
 * Hovering or choosing a group sweeps its children out on a second ring in the same way.
 */
export function RadialMenu() {
  const t = useText();
  const { ui, hub } = useOverlay();
  const menu = useStore(ui, (state) => state.menu);
  const corner = useStore(ui, (state) => state.corner);
  const busy = useStore(ui, (state) => state.busy);
  const mode = useStore(ui, (state) =>
    state.recording ? "record" : state.picking !== null || state.gesture !== null ? "pick" : null,
  );
  const entries = useEntries();
  const [branch, setBranch] = useState<string | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const intent = useRef<number | undefined>(undefined);
  const open = menu !== "closed";

  useEffect(() => {
    hub.setAttribute("aria-expanded", String(open));
    hub.setAttribute("aria-controls", MENU_ID);
  }, [hub, open]);
  useEffect(() => {
    if (mode === null) delete hub.dataset.mode;
    else hub.dataset.mode = mode;
  }, [hub, mode]);
  useEffect(() => {
    if (menu === "closed") return;
    setBranch(null);
    setHint(null);
    const target = root.current?.querySelector<HTMLElement>(
      menu === "keyboard" ? '[data-level="1"]' : '[role="menu"]',
    );
    target?.focus();
  }, [menu]);
  useEffect(() => () => window.clearTimeout(intent.current), []);

  const close = () => {
    window.clearTimeout(intent.current);
    const shadow = hub.getRootNode();
    const focused = shadow instanceof ShadowRoot ? shadow.activeElement : null;
    ui.set({ menu: "closed" });
    if (focused !== null && root.current?.contains(focused)) hub.focus();
  };
  const hover = (id: string | null) => {
    window.clearTimeout(intent.current);
    if (branch === null || branch === id) setBranch(id);
    else intent.current = window.setTimeout(() => setBranch(id), HOVER_INTENT_MS);
  };
  const openBranch = (id: string, focusFirst: boolean) => {
    window.clearTimeout(intent.current);
    flushSync(() => setBranch(id));
    if (focusFirst) root.current?.querySelector<HTMLElement>(`[data-parent="${id}"]`)?.focus();
  };
  const choose = (leaf: Leaf) => {
    if (busy) return;
    leaf.run();
    if (leaf.stay !== true) close();
  };
  const describe = (next: Hint) => ({
    onFocus: () => setHint(next),
    onBlur: () => setHint((current) => (current?.id === next.id ? null : current)),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const item = event.target;
    if (!(item instanceof HTMLElement) || root.current === null) return;
    const parent = item.dataset.parent;
    const siblings = [
      ...root.current.querySelectorAll<HTMLElement>(
        parent === undefined ? '[data-level="1"]' : `[data-parent="${parent}"]`,
      ),
    ];
    const movable = item.dataset.level !== undefined || item.id === MENU_ID;
    let handled = movable && moveFocus(siblings, item, event.key);
    if (event.key === "Escape") {
      handled = true;
      if (parent === undefined) close();
      else {
        setBranch(null);
        root.current.querySelector<HTMLElement>(`[data-group="${parent}"]`)?.focus();
      }
    } else if (event.key === "ArrowRight" && item.dataset.group !== undefined) {
      handled = true;
      openBranch(item.dataset.group, true);
    } else if (event.key === "ArrowLeft" && parent !== undefined) {
      handled = true;
      setBranch(null);
      root.current.querySelector<HTMLElement>(`[data-group="${parent}"]`)?.focus();
    }
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  };
  // The scrim takes outside clicks. Blur closes only when Tab moves focus to another
  // control; a focused child that hides when its branch switches blurs to nothing.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (!open || !(next instanceof Element) || next === hub || root.current?.contains(next)) return;
    close();
  };

  const start = START[corner];
  const step = SPAN / (entries.length - 1);
  const center = HUB_INSET + HUB_SIZE / 2;
  const vertical = corner.startsWith("top") ? "top" : "bottom";
  const horizontal = corner.endsWith("left") ? "left" : "right";
  // Past the hollow's middle, away from the stem.
  const hintAt = polar(HINT_RADIUS, start + 55);
  const groups = entries.flatMap((entry, index) =>
    "children" in entry
      ? [
          {
            group: entry,
            parent: start + index * step,
            angles: branchAngles(start, start + index * step, entry.children.length),
          },
        ]
      : [],
  );
  const rings: Ring[] = [
    {
      id: MENU_ID,
      stem: ray(start, HUB_SIZE / 2 - 6, RING - BAND / 2 + 8),
      band: arc(RING, start, start + SPAN),
      open,
    },
    ...groups.map(({ group, parent, angles }) => ({
      id: group.id,
      stem: ray(parent, RING + BAND / 2 - 8, BRANCH - BAND / 2 + 8),
      band: arc(BRANCH, angles[0] ?? parent, angles.at(-1) ?? parent),
      open: open && branch === group.id,
    })),
  ];

  return (
    <>
      <div
        aria-hidden="true"
        className="pka-radial-scrim"
        data-open={open ? "" : undefined}
        style={{
          backgroundImage: `radial-gradient(circle at ${horizontal} ${center}px ${vertical} ${center}px, var(--pka-scrim), transparent ${BRANCH + BAND}px)`,
        }}
        onPointerDown={close}
      />
      <div
        ref={root}
        className="pka-radial"
        data-testid="pka-menu"
        style={{ [vertical]: center, [horizontal]: center }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      >
        <Body
          x={horizontal === "right" ? -CANVAS : -MARGIN}
          y={vertical === "bottom" ? -CANVAS : -MARGIN}
          rings={rings}
        />
        <div
          id={MENU_ID}
          role="menu"
          aria-label={t("Annotator")}
          tabIndex={-1}
          className="pka-radial-menu"
        >
          {entries.map((entry, index) => {
            const angle = start + index * step;
            const level = { angle, radius: RING, order: index, count: entries.length, shown: open };
            if (!("children" in entry))
              return (
                <div key={entry.id} role="none">
                  <Node
                    {...level}
                    entry={entry}
                    role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                    aria-checked={entry.checked}
                    aria-disabled={busy || undefined}
                    data-level="1"
                    data-active={entry.checked === true ? "" : undefined}
                    onClick={() => choose(entry)}
                    onPointerEnter={() => {
                      hover(null);
                      setHint({ id: entry.id, label: entry.label });
                    }}
                    onPointerLeave={() => window.clearTimeout(intent.current)}
                    {...describe({ id: entry.id, label: entry.label })}
                  />
                </div>
              );
            const angles = groups.find((candidate) => candidate.group === entry)?.angles ?? [];
            const expanded = open && branch === entry.id;
            return (
              <div key={entry.id} role="none">
                <Node
                  {...level}
                  entry={entry}
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={expanded}
                  aria-controls={`${MENU_ID}-${entry.id}`}
                  data-level="1"
                  data-active={entry.active ? "" : undefined}
                  data-group={entry.id}
                  onClick={(event) => openBranch(entry.id, event.detail === 0)}
                  onPointerEnter={() => {
                    hover(entry.id);
                    setHint({ id: entry.id, label: entry.label });
                  }}
                  onPointerLeave={() => window.clearTimeout(intent.current)}
                  {...describe({ id: entry.id, label: entry.label })}
                />
                <div id={`${MENU_ID}-${entry.id}`} role="menu" aria-label={entry.label}>
                  {entry.children.map((child, order) => {
                    const next: Hint = { id: `${entry.id}/${child.id}`, label: child.label };
                    if (child.shortcut !== undefined) next.shortcut = child.shortcut;
                    return (
                      <Node
                        key={child.id}
                        entry={child}
                        angle={angles[order] ?? angle}
                        radius={BRANCH}
                        order={order}
                        count={entry.children.length}
                        shown={expanded}
                        role={child.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                        aria-checked={child.checked}
                        aria-disabled={busy || undefined}
                        data-level="2"
                        data-parent={entry.id}
                        data-active={child.checked === true ? "" : undefined}
                        onClick={() => choose(child)}
                        onPointerEnter={() => {
                          window.clearTimeout(intent.current);
                          setHint(next);
                        }}
                        onPointerLeave={() =>
                          setHint((current) => (current?.id === next.id ? null : current))
                        }
                        {...describe(next)}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {open && hint !== null && (
          <div
            aria-hidden="true"
            className="pka-readout"
            style={{ transform: `translate(${hintAt.x}px, ${hintAt.y}px) translate(-50%, -50%)` }}
          >
            <span className="pka-readout-label">{hint.label}</span>
            {hint.shortcut !== undefined && <kbd className="pka-readout-key">{hint.shortcut}</kbd>}
          </div>
        )}
      </div>
    </>
  );
}
