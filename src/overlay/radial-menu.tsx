import {
  BugIcon,
  CameraIcon,
  CircleDotIcon,
  CircleIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleArrowUpIcon,
  HighlighterIcon,
  HistoryIcon,
  LanguagesIcon,
  LassoSelectIcon,
  LoaderCircleIcon,
  MousePointerClickIcon,
  PencilIcon,
  PlugIcon,
  PowerIcon,
  RectangleHorizontalIcon,
  RotateCwIcon,
  SendIcon,
  Settings2Icon,
  SquareDashedMousePointerIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ComponentType,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import type { ViteHotContext } from "vite/types/hot.d.ts";

import type { PickMode } from "../select/pick.ts";
import { AgentIcon } from "./agent-icon.tsx";
import { isAgentConnected, subscribeAgentConnected } from "./agent-presence.ts";
import type { SetupInfoMessage, UpdateResultMessage } from "../shared/channel.ts";
import { listen, send } from "./channel-client.ts";
import { copyLater } from "./clipboard.ts";
import { COMPOSE, THREAD, useOverlay, type UiState } from "./context.tsx";
import { useText } from "./language.ts";
import { HUB_INSET, HUB_SIZE, SHORTCUT_LABEL, type Corner } from "./launcher.ts";
import { panels } from "./registry.ts";
import { useList, useStore } from "./store.ts";
import { getUpdate, setUpdate, subscribeUpdate } from "./update-state.ts";

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
// The connect item rests in the middle of the hollow. While another item's readout shows,
// it moves up beside the stem, clear of the readout and the band.
const CONNECT_REST = { radius: HINT_RADIUS, angle: 45 };
const CONNECT_ASIDE = { radius: 99, angle: 21 };
// Crossing from one item to the next clears the readout briefly; the item waits it out.
const CONNECT_RETURN_MS = 140;
const SETUP_TIMEOUT_MS = 5000;
// Longer than the plugin's 5-minute install timeout, so its own failure arrives first.
const UPDATE_TIMEOUT_MS = 6 * 60 * 1000;
/** Each corner's menu sweeps counterclockwise through the quadrant that faces the page. */
const START = {
  "bottom-left": 0,
  "bottom-right": 90,
  "top-right": 180,
  "top-left": 270,
} satisfies Record<Corner, number>;
const SPAN = 90;
const BRANCH_STEP = ((ITEM + 8) / BRANCH) * (180 / Math.PI);
const HOVER_INTENT_MS = 140;
const TOOL_GROUPS = ["pick", "capture", "annotate"] as const;
const TOOL_KEY = "pka:tool:";
type ToolGroup = (typeof TOOL_GROUPS)[number];
/** Each tool group's remembered tool id, kept for this tab session. */
type Tools = Readonly<Partial<Record<string, string>>>;

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
type Group = {
  id: string;
  label: string;
  icon: Icon;
  active: boolean;
  /** Repeats the hub's update dot on the group that holds the update. */
  dot?: boolean;
  children: Leaf[];
  /** A tool group shows, and on click runs, its remembered tool instead of opening. */
  tool?: Leaf;
};
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

/** Asks the dev server where its store is and how to launch pka-mcp for it. */
async function requestSetup(hot: ViteHotContext): Promise<SetupInfoMessage> {
  const { CHANNEL, SetupInfoMessage } = await import("../shared/channel.ts");
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      stop();
      reject(new Error("No reply from the dev server within 5 s for the MCP setup"));
    }, SETUP_TIMEOUT_MS);
    const stop = listen(hot, CHANNEL.setupInfo, SetupInfoMessage, (message) => {
      if (message.requestId !== requestId) return;
      window.clearTimeout(timer);
      stop();
      resolve(message);
    });
    send(hot, CHANNEL.setup, { requestId });
  });
}

/** Asks the dev server to install `version`; resolves when it is installed. */
async function requestUpdate(
  hot: ViteHotContext,
  version: string,
): Promise<Exclude<UpdateResultMessage["outcome"], "failed">> {
  const { CHANNEL, UpdateResultMessage } = await import("../shared/channel.ts");
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      stop();
      reject(
        new Error(`No reply from the dev server within 6 minutes for the update to ${version}`),
      );
    }, UPDATE_TIMEOUT_MS);
    const stop = listen(hot, CHANNEL.updateResult, UpdateResultMessage, (message) => {
      if (message.requestId !== requestId) return;
      window.clearTimeout(timer);
      stop();
      if (message.outcome === "failed") reject(new Error(message.message));
      else resolve(message.outcome);
    });
    send(hot, CHANNEL.installUpdate, { requestId, version });
  });
}

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The prompt an agent session follows to install pka-mcp for this page's store and wait. */
function connectPrompt(page: string, setup: SetupInfoMessage): string {
  const command = setup.command ?? [`${setup.root}/node_modules/.bin/pka-mcp`];
  const launch = [...command, "--root", setup.root].map(shellWord).join(" ");
  return [
    `Connect this session to the pk-annotator MCP server so you receive the annotations I send from ${page}.`,
    `That page's dev server stores them in ${setup.store}.`,
    ...(setup.command === null
      ? [
          `pka-mcp is not installed in ${setup.root}: add pk-annotator as a dev dependency there first.`,
        ]
      : []),
    "If this session lacks the pka tools (wait_for_annotation, list_annotations), install the server yourself, replacing any pka server registered with another --root:",
    `- Claude Code: claude mcp add pka --scope local -- ${launch}`,
    `- Codex: codex mcp add pka -- ${launch}, then set tool_timeout_sec = 1830 under [mcp_servers.pka] in ~/.codex/config.toml`,
    "A running session loads a new server only after a reconnect, so then ask me to run /mcp and reconnect pka in Claude Code, or to restart Codex.",
    "Once the tools are available, call wait_for_annotation.",
  ].join("\n");
}

function readTools(): Tools {
  return Object.fromEntries(
    TOOL_GROUPS.flatMap((group) => {
      const id = sessionStorage.getItem(TOOL_KEY + group);
      return id === null ? [] : [[group, id]];
    }),
  );
}

function useEntries(tools: Tools): Entry[] {
  const t = useText();
  const { ui, thread, exit, hot } = useOverlay();
  const update = useSyncExternalStore(subscribeUpdate, getUpdate);
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
  // A stored id from another version names no tool; the group's first tool is its default.
  const toolGroup = (id: ToolGroup, label: string, active: boolean, children: Leaf[]): Group => {
    const tool = children.find((child) => child.id === tools[id]) ?? children[0];
    if (tool === undefined) throw new Error(`Tool group ${id} has no tools`);
    return { id, label, icon: tool.icon, active, children, tool };
  };

  // Restarting the dev server reloads the page, which discards unsent marks, so they block it.
  function updateLeaf(offer: NonNullable<typeof update>): Leaf {
    const leaf = { id: "update", stay: true };
    if (offer.status === "installing") {
      return {
        ...leaf,
        label: `${t("Updating to")} ${offer.latest}…`,
        icon: LoaderCircleIcon,
        run() {},
      };
    }
    if (offer.status === "restart-manually") {
      return {
        ...leaf,
        label: t("Restart the dev server to finish"),
        icon: RotateCwIcon,
        run() {},
      };
    }
    if (pending > 0) {
      return {
        ...leaf,
        label: t("Send or clear marks to update"),
        icon: CircleArrowUpIcon,
        run() {},
      };
    }
    return {
      ...leaf,
      label:
        offer.status === "failed"
          ? `${t("Update failed. Retry")} ${offer.latest}`
          : `${t("Update to")} ${offer.latest}`,
      icon: offer.status === "failed" ? CircleAlertIcon : CircleArrowUpIcon,
      run() {
        setUpdate({ ...offer, status: "installing" });
        // On "restart" the dev server restarts and Vite's client reloads the page.
        requestUpdate(hot, offer.latest).then(
          (outcome) => {
            if (outcome === "restart-manually") setUpdate({ ...offer, status: outcome });
          },
          (cause: unknown) => {
            console.error(`[pk-annotator] updating to ${offer.latest} failed`, cause);
            setUpdate({ ...offer, status: "failed" });
          },
        );
      },
    };
  }

  return [
    toolGroup("pick", t("Pick elements"), picking !== null, [
      {
        id: "select",
        label: t("Select"),
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
      {
        id: "text",
        label: t("Text"),
        icon: HighlighterIcon,
        checked: picking === "text",
        run: () => togglePick("text"),
      },
    ]),
    toolGroup(
      "capture",
      t("Capture"),
      recording || panel === "record" || gesture === "screenshot" || gesture === "record-area",
      [
        {
          id: "screenshot",
          label: t("Screenshot"),
          icon: CameraIcon,
          checked: gesture === "screenshot",
          run: () => toggleGesture("screenshot"),
        },
        {
          id: "record",
          label: t("Record"),
          icon: CircleDotIcon,
          checked: panel === "record",
          run: () => togglePanel("record"),
        },
      ],
    ),
    toolGroup(
      "annotate",
      t("Annotate"),
      gesture === "rectangle" || gesture === "ellipse" || gesture === "freehand",
      [
        {
          id: "freehand",
          label: t("Freehand"),
          icon: PencilIcon,
          checked: gesture === "freehand",
          run: () => toggleGesture("freehand"),
        },
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
      ],
    ),
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
      label: t("Send"),
      icon: SendIcon,
      checked: panel === COMPOSE,
      badge: pending,
      run: () => togglePanel(COMPOSE),
    },
    {
      id: "settings",
      label: t("Settings"),
      icon: Settings2Icon,
      active: panel === THREAD,
      dot: update !== null,
      children: [
        ...(update === null ? [] : [updateLeaf(update)]),
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
  const enter = Math.round(
    (radius === RING ? 40 : 20) + (order / Math.max(count - 1, 1)) * (radius === RING ? 60 : 40),
  );
  const leave = (count - 1 - order) * 8;
  const tick = polar(15, angle);
  const face = "tool" in entry && entry.tool !== undefined ? entry.tool : entry;
  const icon = useMemo(
    () => <AgentIcon name={face.id} icon={face.icon} className="size-[18px]" />,
    [face.id, face.icon],
  );
  return (
    <button
      type="button"
      tabIndex={shown ? 0 : -1}
      aria-label={face.label}
      data-open={shown ? "" : undefined}
      className="pka-node"
      style={{
        transform: shown
          ? `translate(${x}px, ${y}px)`
          : `translate(${x * 0.82}px, ${y * 0.82}px) scale(0.5)`,
        transitionDelay: shown
          ? `${enter}ms, ${enter}ms, 0ms`
          : `${leave}ms, ${leave}ms, ${leave + 100}ms`,
      }}
      {...props}
    >
      {icon}
      {"children" in entry && (
        <span
          aria-hidden="true"
          className="pka-node-tick"
          style={{ left: ITEM / 2 + tick.x - 2, top: ITEM / 2 + tick.y - 2 }}
        />
      )}
      {"dot" in entry && entry.dot === true && <span aria-hidden="true" className="pka-node-dot" />}
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
        <feGaussianBlur in="SourceAlpha" stdDeviation={8} result="blur" />
        <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 20 -8.5" result="shape" />
        <feColorMatrix
          in="blur"
          values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 20 -7.5"
          result="outline"
        />
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
  const { ui, hub, hot } = useOverlay();
  const menu = useStore(ui, (state) => state.menu);
  const corner = useStore(ui, (state) => state.corner);
  const busy = useStore(ui, (state) => state.busy);
  const mode = useStore(ui, (state) =>
    state.recording ? "record" : state.picking !== null || state.gesture !== null ? "pick" : null,
  );
  const [tools, setTools] = useState(readTools);
  const entries = useEntries(tools);
  const [branch, setBranch] = useState<string | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const connected = useSyncExternalStore(subscribeAgentConnected, isAgentConnected);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [aside, setAside] = useState(false);
  const updateLabel = entries
    .flatMap((entry) => ("children" in entry ? entry.children : []))
    .find((child) => child.id === "update")?.label;
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
    setCopied(null);
    const target = root.current?.querySelector<HTMLElement>(
      menu === "keyboard" ? '[data-level="1"]' : '[role="menu"]',
    );
    target?.focus();
  }, [menu]);
  useEffect(() => () => window.clearTimeout(intent.current), []);
  useEffect(() => {
    if (updateLabel === undefined) return;
    setHint((current) =>
      current?.id === "settings/update" ? { ...current, label: updateLabel } : current,
    );
  }, [updateLabel]);
  useEffect(() => {
    // Its own readout keeps it in place, so it never slides out from under the pointer.
    if (hint?.id === "connect") return;
    if (hint !== null) {
      setAside(true);
      return;
    }
    const back = window.setTimeout(() => setAside(false), CONNECT_RETURN_MS);
    return () => window.clearTimeout(back);
  }, [hint]);
  useEffect(() => {
    if (!connected) return;
    const shadow = hub.getRootNode();
    const focused = shadow instanceof ShadowRoot ? shadow.activeElement : null;
    if (focused instanceof HTMLElement && focused.dataset.testid === "pka-connect") {
      root.current?.querySelector<HTMLElement>('[role="menu"]')?.focus();
    }
  }, [connected, hub]);
  useEffect(() => {
    if (menu === "closed") return;
    // A mouseout with no relatedTarget means the pointer left the browser window.
    const leave = (event: MouseEvent) => {
      if (event.relatedTarget === null) ui.set({ menu: "closed" });
    };
    document.addEventListener("mouseout", leave);
    return () => {
      document.removeEventListener("mouseout", leave);
    };
  }, [menu, ui]);

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
  const choose = (leaf: Leaf, group?: Group) => {
    if (busy) return;
    if (group?.tool !== undefined && group.tool.id !== leaf.id) {
      sessionStorage.setItem(TOOL_KEY + group.id, leaf.id);
      setTools((current) => ({ ...current, [group.id]: leaf.id }));
    }
    leaf.run();
    if (leaf.stay !== true) close();
  };
  const copySetup = async () => {
    try {
      await copyLater(requestSetup(hot).then((setup) => connectPrompt(location.href, setup)));
      setCopied("ok");
      setHint({ id: "connect", label: t("Copied to clipboard") });
    } catch (cause) {
      console.error("[pk-annotator] copying the MCP setup failed", cause);
      setCopied("failed");
      setHint({ id: "connect", label: t("Couldn't copy to clipboard") });
    }
  };
  const connectLabel = t("Connect agent");
  const connectAt = aside ? CONNECT_ASIDE : CONNECT_REST;
  // Leaving an item clears its readout, so the connect item can return to the middle.
  const leaveItem = (id: string) => {
    window.clearTimeout(intent.current);
    setHint((current) => (current?.id === id ? null : current));
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
  const connectCenter = polar(connectAt.radius, start + connectAt.angle);
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
          aria-hidden={!open || undefined}
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
                    onPointerLeave={() => leaveItem(entry.id)}
                    {...describe({ id: entry.id, label: entry.label })}
                  />
                </div>
              );
            const angles = groups.find((candidate) => candidate.group === entry)?.angles ?? [];
            const expanded = open && branch === entry.id;
            const { tool } = entry;
            const face: Hint = { id: entry.id, label: tool?.label ?? entry.label };
            if (tool?.shortcut !== undefined) face.shortcut = tool.shortcut;
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
                  aria-disabled={(tool !== undefined && busy) || undefined}
                  onClick={(event) =>
                    tool === undefined ? openBranch(entry.id, event.detail === 0) : choose(tool)
                  }
                  onPointerEnter={() => {
                    hover(entry.id);
                    setHint(face);
                  }}
                  onPointerLeave={() => leaveItem(entry.id)}
                  {...describe(face)}
                />
                <div
                  id={`${MENU_ID}-${entry.id}`}
                  role="menu"
                  aria-label={entry.label}
                  aria-hidden={!expanded || undefined}
                >
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
                        onClick={() => choose(child, entry)}
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
          <div role="none">
            <Node
              entry={{
                id: "connect",
                label: connectLabel,
                icon: copied === null ? PlugIcon : copied === "ok" ? CheckIcon : XIcon,
                stay: true,
                run: () => void copySetup(),
              }}
              angle={start + connectAt.angle}
              radius={connectAt.radius}
              order={entries.length}
              count={entries.length + 1}
              shown={open && !connected}
              role="menuitem"
              aria-hidden={connected || undefined}
              data-level={connected ? undefined : "1"}
              data-floating=""
              data-testid="pka-connect"
              onClick={() => void copySetup()}
              onPointerEnter={() => {
                hover(null);
                if (copied === null) setHint({ id: "connect", label: connectLabel });
              }}
              onPointerLeave={() => leaveItem("connect")}
              {...describe({ id: "connect", label: connectLabel })}
            />
          </div>
        </div>
        {open && hint !== null && (
          <div
            aria-hidden="true"
            className="pka-readout"
            data-tone={hint.id === "connect" ? "connect" : undefined}
            style={{
              transform:
                hint.id === "connect"
                  ? `translate(${connectCenter.x}px, ${connectCenter.y}px) translate(-50%, -50%)`
                  : `translate(${hintAt.x}px, ${hintAt.y}px) translate(-50%, -50%)`,
            }}
          >
            <span className="pka-readout-label">{hint.label}</span>
            {hint.shortcut !== undefined && <kbd className="pka-readout-key">{hint.shortcut}</kbd>}
          </div>
        )}
      </div>
    </>
  );
}
