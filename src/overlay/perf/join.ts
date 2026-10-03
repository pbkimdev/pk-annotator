import { getDisplayName, type Fiber, type Props } from "bippy";
import { formatOwnerStack, parseStack } from "bippy/source";

import type {
  ActionEntry,
  ActionTarget,
  NavigationEntry,
  RequestEntry,
  ServerTiming,
} from "../../shared/timeline.ts";

/** How long after an action a request still counts as caused by it. */
export const CAUSE_WINDOW_MS = 1000;
/** Slack between the Date clock of capture actions and the performance clock of frames. */
const CLOCK_SLACK_MS = 20;
export const MAX_REQUESTS = 8;
const MAX_PROPS = 8;

export type Cause = {
  seq: number;
  type: ActionEntry["type"];
  /** The React prop that handles this event, for example "onClick". */
  handler: string;
  target: string;
  source?: string;
  /** Milliseconds from the action to the request or frame start. */
  afterMs: number;
};

export type SlowRequest = {
  seq: number;
  method: string;
  url: string;
  status?: number;
  state: RequestEntry["state"];
  durationMs: number;
  serverTiming: ServerTiming[];
  cause?: Cause;
};

const HANDLER = {
  click: "onClick",
  input: "onChange",
  change: "onChange",
  submit: "onSubmit",
  keydown: "onKeyDown",
} satisfies Record<ActionEntry["type"], string>;

export function targetLabel(target: ActionTarget): string {
  if (target.testId !== undefined) return `${target.tag}[data-testid="${target.testId}"]`;
  if (target.id !== undefined) return `${target.tag}#${target.id}`;
  const name = target.label ?? target.text;
  return name === undefined ? target.tag : `${target.tag} "${name}"`;
}

function causeOf(action: ActionEntry, afterMs: number): Cause {
  const cause: Cause = {
    seq: action.seq,
    type: action.type,
    handler: HANDLER[action.type],
    target: targetLabel(action.target),
    afterMs: Math.round(afterMs),
  };
  if (action.target.src !== undefined) cause.source = action.target.src;
  return cause;
}

function isAction(entry: ActionEntry | NavigationEntry): entry is ActionEntry {
  return entry.kind === "action";
}

/**
 * The settled requests that took longest, each joined to the last action recorded before
 * it (by capture seq) when the request started within CAUSE_WINDOW_MS of that action.
 */
export function slowRequests(
  requests: readonly RequestEntry[],
  entries: readonly (ActionEntry | NavigationEntry)[],
): SlowRequest[] {
  const actions = entries.filter(isAction);
  return requests
    .filter(
      (request): request is RequestEntry & { durationMs: number } =>
        !request.stream &&
        request.durationMs !== undefined &&
        (request.state === "done" || request.state === "failed"),
    )
    .toSorted((a, b) => b.durationMs - a.durationMs)
    .slice(0, MAX_REQUESTS)
    .map((request) => {
      const slow: SlowRequest = {
        seq: request.seq,
        method: request.method,
        url: request.url,
        state: request.state,
        durationMs: request.durationMs,
        serverTiming: request.serverTiming ?? [],
      };
      if (request.status !== undefined) slow.status = request.status;
      const action = actions.findLast((candidate) => candidate.seq < request.seq);
      if (action !== undefined) {
        const afterMs = Date.parse(request.at) - Date.parse(action.at);
        if (afterMs >= 0 && afterMs <= CAUSE_WINDOW_MS) slow.cause = causeOf(action, afterMs);
      }
      return slow;
    });
}

/**
 * The action whose event ran inside a frame, given the frame's start and duration on the
 * performance clock. Capture stamps actions with Date, so the comparison allows some slack.
 */
export function frameCause(
  start: number,
  duration: number,
  entries: readonly (ActionEntry | NavigationEntry)[],
  timeOrigin: number,
): Cause | undefined {
  const action = entries.filter(isAction).findLast((candidate) => {
    const at = Date.parse(candidate.at) - timeOrigin;
    return at >= start - CLOCK_SLACK_MS && at <= start + duration + CLOCK_SLACK_MS;
  });
  if (action === undefined) return undefined;
  return causeOf(action, Math.max(0, Date.parse(action.at) - timeOrigin - start));
}

export type FiberSite = { fileName: string; lineNumber: number; columnNumber: number };

export type HotSpot = {
  name: string;
  /** Where the component's element is created, or its own first host element when a library creates it. */
  site: FiberSite;
  siteKind: "used-at" | "renders";
  renders: number;
  selfMs: number;
  props: string[];
  stateChanges: number;
  hookChanges: number;
  contextChanges: number;
  /** Re-renders with nothing of its own changed: the parent rendered it again. */
  cascades: number;
};

type OwnSite = { site: FiberSite; kind: HotSpot["siteKind"] };

// React work tags and the fiber flag React sets when a component's render ran.
const CLASS_TAG = 1;
const COMPOSITE_TAGS = new Set([0, CLASS_TAG, 11, 14, 15]);
const HOST_TAGS = new Set([5, 26, 27]);
const PERFORMED_WORK = 1;

function siteOf(fiber: Fiber): FiberSite | undefined {
  const stack = fiber._debugStack?.stack;
  if (stack === undefined) return undefined;
  const frame = parseStack(formatOwnerStack(stack))[0];
  if (
    frame?.fileName === undefined ||
    frame.lineNumber === undefined ||
    frame.columnNumber === undefined
  ) {
    return undefined;
  }
  return {
    fileName: frame.fileName,
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
  };
}

function ownedBy(fiber: Fiber, owner: Fiber): boolean {
  return fiber._debugOwner === owner || fiber._debugOwner === owner.alternate;
}

// Reading a debug stack formats it, so each component instance resolves its site once, at
// its first counted render. Both fibers of an instance share the entry; null records an
// instance with no project site, such as a library's internal component.
const sites = new WeakMap<Fiber, OwnSite | null>();

// A library-created component (a route component, for example) has its element created in
// node_modules; its own JSX is the first descendant host element it owns.
function ownSite(fiber: Fiber, isProject: (fileName: string) => boolean): OwnSite | undefined {
  const cached =
    sites.get(fiber) ?? (fiber.alternate === null ? undefined : sites.get(fiber.alternate));
  if (cached !== undefined) return cached ?? undefined;
  let own: OwnSite | null = null;
  const site = siteOf(fiber);
  if (site !== undefined && isProject(site.fileName)) own = { site, kind: "used-at" };
  const pending = fiber.child === null ? [] : [fiber.child];
  for (let next = pending.pop(); own === null && next !== undefined; next = pending.pop()) {
    if (next.sibling !== null) pending.push(next.sibling);
    if (next.child !== null) pending.push(next.child);
    if (!HOST_TAGS.has(next.tag) || !ownedBy(next, fiber)) continue;
    const hostSite = siteOf(next);
    if (hostSite !== undefined && isProject(hostSite.fileName)) {
      own = { site: hostSite, kind: "renders" };
    }
  }
  sites.set(fiber, own);
  return own ?? undefined;
}

export function hotSpotKey(spot: Pick<HotSpot, "name" | "site">): string {
  return `${spot.name}@${spot.site.fileName}:${spot.site.lineNumber}:${spot.site.columnNumber}`;
}

type Change = { props: string[]; state: boolean; hooks: boolean; context: boolean };

// Props, or a class component's state object.
function changedKeys(next: Props, prior: Props): string[] {
  return [...new Set([...Object.keys(next), ...Object.keys(prior)])].filter(
    (key) => !Object.is(next[key], prior[key]),
  );
}

// Function components keep their hooks as a list; any changed value counts.
function hooksChanged(fiber: Fiber, previous: Fiber): boolean {
  let next = fiber.memoizedState;
  let prior = previous.memoizedState;
  while (next !== null || prior !== null) {
    if (next === null || prior === null) return false;
    if (!Object.is(next.memoizedState, prior.memoizedState)) return true;
    next = next.next;
    prior = prior.next;
  }
  return false;
}

function contextChanged(fiber: Fiber, previous: Fiber): boolean {
  let next = fiber.dependencies?.firstContext ?? null;
  let prior = previous.dependencies?.firstContext ?? null;
  while (next !== null && prior !== null && next.context === prior.context) {
    if (!Object.is(next.memoizedValue, prior.memoizedValue)) return true;
    next = next.next;
    prior = prior.next;
  }
  return false;
}

function changeOf(fiber: Fiber, previous: Fiber): Change {
  // A class component keeps its state object where a function component keeps hooks.
  const isClass = fiber.tag === CLASS_TAG;
  const state = fiber.memoizedState;
  const priorState = previous.memoizedState;
  return {
    props: changedKeys(fiber.memoizedProps, previous.memoizedProps),
    state:
      isClass &&
      (state === null || priorState === null
        ? state !== priorState
        : changedKeys(state, priorState).length > 0),
    hooks: !isClass && hooksChanged(fiber, previous),
    context: contextChanged(fiber, previous),
  };
}

function record(hotSpots: Map<string, HotSpot>, fiber: Fiber, previous: Fiber, own: OwnSite): void {
  const name = getDisplayName(fiber.type) ?? "Anonymous";
  const key = hotSpotKey({ name, site: own.site });
  const spot = hotSpots.get(key) ?? {
    name,
    site: own.site,
    siteKind: own.kind,
    renders: 0,
    selfMs: 0,
    props: [],
    stateChanges: 0,
    hookChanges: 0,
    contextChanges: 0,
    cascades: 0,
  };
  const change = changeOf(fiber, previous);
  spot.renders += 1;
  spot.selfMs += fiber.selfBaseDuration ?? 0;
  for (const prop of change.props) {
    if (!spot.props.includes(prop) && spot.props.length < MAX_PROPS) spot.props.push(prop);
  }
  if (change.state) spot.stateChanges += 1;
  if (change.hooks) spot.hookChanges += 1;
  if (change.context) spot.contextChanges += 1;
  if (change.props.length === 0 && !change.state && !change.hooks && !change.context) {
    spot.cascades += 1;
  }
  hotSpots.set(key, spot);
}

/**
 * Adds the components that re-rendered in one commit to `hotSpots`, given the committed
 * HostRoot fiber.
 *
 * The walk follows only the work React did: a subtree whose children React reused as they
 * were did not render, so its fibers are not visited, however large the tree. A component
 * counts when React ran its render in this commit (the PerformedWork flag, which React
 * clears on every fiber it processes). First mounts are skipped. Only components with a
 * project source are kept, which also drops the overlay's own root; the source is read
 * only for components that rendered.
 */
export function addCommit(
  hotSpots: Map<string, HotSpot>,
  root: Fiber,
  isProject: (fileName: string) => boolean,
): boolean {
  let changed = false;
  const pending = [root];
  for (let fiber = pending.pop(); fiber !== undefined; fiber = pending.pop()) {
    const previous = fiber.alternate;
    // Mounted in this commit, and so was everything below it.
    if (previous === null) continue;
    if (COMPOSITE_TAGS.has(fiber.tag) && (fiber.flags & PERFORMED_WORK) !== 0) {
      const own = ownSite(fiber, isProject);
      if (own !== undefined) {
        record(hotSpots, fiber, previous, own);
        changed = true;
      }
    }
    if (fiber.child === previous.child) continue;
    const children: Fiber[] = [];
    for (let child = fiber.child; child !== null; child = child.sibling) children.push(child);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return changed;
}
