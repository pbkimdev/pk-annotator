import type { LiteFiberSummary } from "react-scan/lite";

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

// React work tags: MemoComponent, SimpleMemoComponent; HostComponent, HostHoistable, HostSingleton.
const MEMO_TAGS = new Set([14, 15]);
const HOST_TAGS = new Set([5, 26, 27]);

function siteOf(fiber: LiteFiberSummary): FiberSite | undefined {
  const source = fiber.source;
  if (
    source === undefined ||
    source === null ||
    source.lineNumber === undefined ||
    source.columnNumber === undefined
  ) {
    return undefined;
  }
  return {
    fileName: source.fileName,
    lineNumber: source.lineNumber,
    columnNumber: source.columnNumber,
  };
}

// A library-created component (a route component, for example) has its element created in
// node_modules; its own JSX is the first descendant host element it owns.
function ownSite(
  tree: readonly LiteFiberSummary[],
  index: number,
  isProject: (fileName: string) => boolean,
): { site: FiberSite; kind: HotSpot["siteKind"] } | undefined {
  const fiber = tree[index];
  if (fiber === undefined) return undefined;
  const site = siteOf(fiber);
  if (site !== undefined && isProject(site.fileName)) return { site, kind: "used-at" };
  for (let next = index + 1; next < tree.length; next += 1) {
    const descendant = tree[next];
    if (descendant === undefined || descendant.depth <= fiber.depth) return undefined;
    const descendantSite = siteOf(descendant);
    if (
      HOST_TAGS.has(descendant.tag) &&
      descendant.ownerName === fiber.name &&
      descendantSite !== undefined &&
      isProject(descendantSite.fileName)
    ) {
      return { site: descendantSite, kind: "renders" };
    }
  }
  return undefined;
}

export function hotSpotKey(spot: Pick<HotSpot, "name" | "site">): string {
  return `${spot.name}@${spot.site.fileName}:${spot.site.lineNumber}:${spot.site.columnNumber}`;
}

function record(
  hotSpots: Map<string, HotSpot>,
  fiber: LiteFiberSummary,
  own: { site: FiberSite; kind: HotSpot["siteKind"] },
): void {
  const change = fiber.changeDescription;
  if (change === undefined || change === null) return;
  const key = hotSpotKey({ name: fiber.name, site: own.site });
  const spot = hotSpots.get(key) ?? {
    name: fiber.name,
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
  spot.renders += 1;
  spot.selfMs += fiber.selfBaseDuration;
  for (const prop of change.props ?? []) {
    if (!spot.props.includes(prop) && spot.props.length < MAX_PROPS) spot.props.push(prop);
  }
  if (change.state) spot.stateChanges += 1;
  if (change.hooks.length > 0) spot.hookChanges += 1;
  if (change.context) spot.contextChanges += 1;
  if (selfChanges(change) === 0) spot.cascades += 1;
  hotSpots.set(key, spot);
}

function selfChanges(change: NonNullable<LiteFiberSummary["changeDescription"]>): number {
  return (
    (change.props?.length ?? 0) +
    change.hooks.length +
    (change.state ? 1 : 0) +
    (change.context ? 1 : 0)
  );
}

/**
 * Adds the components that re-rendered in one react-scan/lite commit tree to `hotSpots`.
 *
 * The tree lists every committed fiber, including ones that bailed out on the update path
 * and stale ones whose change description compares old alternates. A component counts as
 * rendered when it was processed in this commit (actualStartTime at or after the root's) and
 * either something of its own changed or its nearest composite ancestor rendered and it is
 * not memoized. First mounts are skipped. Only components with a project source are kept,
 * which also drops the overlay's own root.
 */
export function addCommit(
  hotSpots: Map<string, HotSpot>,
  tree: readonly LiteFiberSummary[],
  isProject: (fileName: string) => boolean,
): boolean {
  const rootStart = tree[0]?.actualStartTime;
  if (rootStart === undefined) return false;
  // rendered[d]: whether the nearest composite at depth d or above rendered in this commit.
  const rendered: boolean[] = [];
  let changed = false;
  tree.forEach((fiber, index) => {
    rendered.length = fiber.depth;
    const parentRendered = rendered[fiber.depth - 1] ?? false;
    const change = fiber.changeDescription;
    if (change === undefined || change === null) {
      rendered.push(parentRendered);
      return;
    }
    const fresh = fiber.actualStartTime >= rootStart;
    const didRender =
      fresh &&
      (change.isFirstMount ||
        selfChanges(change) > 0 ||
        (parentRendered && !MEMO_TAGS.has(fiber.tag)));
    rendered.push(didRender);
    if (!didRender || change.isFirstMount) return;
    const own = ownSite(tree, index, isProject);
    if (own === undefined) return;
    record(hotSpots, fiber, own);
    changed = true;
  });
  return changed;
}
