// @vitest-environment happy-dom
import { instrument, type FiberRoot } from "bippy";
import { describe, expect, it } from "vitest";

import type { ActionEntry, RequestEntry } from "../../shared/timeline.ts";
import { addCommit, frameCause, slowRequests, type HotSpot } from "./join.ts";

// React registers with the DevTools hook when it loads, so the hook comes first.
const commits: FiberRoot[] = [];
instrument({ onCommitFiberRoot: (_rendererId, root) => commits.push(root) });
const { createElement: h, memo, useMemo, useState } = await import("react");
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");

const origin = "http://127.0.0.1:3303";
const isProject = (fileName: string) => fileName.includes("join.test");

function action(
  seq: number,
  at: string,
  testId: string,
  timing: Pick<ActionEntry, "performanceMs" | "durationMs"> = {},
): ActionEntry {
  return { kind: "action", seq, at, type: "click", target: { tag: "button", testId }, ...timing };
}

function request(
  seq: number,
  at: string,
  durationMs: number,
  performanceMs?: number,
): RequestEntry {
  const entry: RequestEntry = {
    kind: "request",
    seq,
    at,
    initiator: "fetch",
    method: "GET",
    url: `${origin}/api/${seq}`,
    state: "done",
    status: 200,
    durationMs,
    stream: false,
    serverFn: false,
    requestHeaders: {},
    responseHeaders: {},
  };
  if (performanceMs !== undefined) entry.performanceMs = performanceMs;
  return entry;
}

describe("slowRequests", () => {
  it("joins a request to the last earlier action only inside the cause window", () => {
    const actions = [
      action(1, "2026-10-02T10:00:00.000Z", "first"),
      action(3, "2026-10-02T10:00:05.000Z", "second"),
    ];
    const joined = slowRequests(
      [request(2, "2026-10-02T10:00:00.040Z", 120), request(4, "2026-10-02T10:00:07.000Z", 900)],
      actions,
    );
    expect(joined.map((entry) => [entry.seq, entry.cause?.target, entry.cause?.handler])).toEqual([
      [4, undefined, undefined],
      [2, 'button[data-testid="first"]', "onClick"],
    ]);
  });

  it("measures from the end of merged typing on the monotonic clock, and on Date for legacy pairs", () => {
    const typing: ActionEntry = {
      ...action(1, "2026-10-02T10:00:00.000Z", "search", { performanceMs: 1000, durationMs: 2500 }),
      type: "input",
    };
    // The Date clock stepped back 5 s between this action and its request.
    const stepped = action(3, "2026-10-02T10:00:20.000Z", "save", { performanceMs: 9000 });
    const legacy = action(5, "2026-10-02T10:00:30.000Z", "legacy", { performanceMs: 20_000 });
    const joined = slowRequests(
      [
        // 2.8 s after typing began, 300 ms after its last keystroke.
        request(2, "2026-10-02T10:00:02.800Z", 300, 3800),
        request(4, "2026-10-02T10:00:15.200Z", 200, 9200),
        // Without its own performanceMs the pair falls back to Date: 2 s apart.
        request(6, "2026-10-02T10:00:32.000Z", 100),
      ],
      [typing, stepped, legacy],
    );
    expect(joined.map((entry) => [entry.seq, entry.cause?.seq, entry.cause?.afterMs])).toEqual([
      [2, 1, 300],
      [4, 3, 200],
      [6, undefined, undefined],
    ]);
  });
});

describe("frameCause", () => {
  const timeOrigin = Date.parse("2026-10-02T10:00:00.000Z");

  it("attributes a frame to typing that overlaps it and to an event delayed into it", () => {
    const typing: ActionEntry = {
      ...action(1, "2026-10-02T10:00:01.000Z", "search", { performanceMs: 1000, durationMs: 2000 }),
      type: "input",
    };
    expect(frameCause(2900, 120, [typing], timeOrigin)?.seq).toBe(1);
    // Created 15 ms before the frame that ran its handler.
    const delayed = action(2, "2026-10-02T10:00:05.000Z", "save", { performanceMs: 4985 });
    expect(frameCause(5000, 80, [typing, delayed], timeOrigin)?.seq).toBe(2);
    // Created after the frame ended, so it ran in a later one.
    const later = action(3, "2026-10-02T10:00:06.000Z", "next", { performanceMs: 6090 });
    expect(frameCause(6000, 80, [later], timeOrigin)).toBeUndefined();
  });

  it("falls back to the Date timestamp, with clock slack, for legacy actions", () => {
    const legacy = action(1, "2026-10-02T10:00:00.130Z", "legacy");
    expect(frameCause(100, 20, [legacy], timeOrigin)?.afterMs).toBe(30);
    expect(frameCause(200, 20, [legacy], timeOrigin)).toBeUndefined();
  });
});

function render(element: ReturnType<typeof h>): ReturnType<typeof createRoot> {
  const root = createRoot(document.createElement("div"));
  flushSync(() => root.render(element));
  return root;
}

function commit(hotSpots: Map<string, HotSpot>, update: () => void): boolean {
  commits.length = 0;
  flushSync(update);
  const root = commits.at(-1);
  if (root === undefined) throw new Error("React committed nothing");
  return addCommit(hotSpots, root.current, isProject);
}

describe("addCommit", () => {
  it("counts updated components and their cascades, not bailed-out ancestors, memo, or mounts", () => {
    let addRow = (): void => undefined;
    const Row = ({ label }: { label: string }) => h("li", null, label);
    const MemoRow = memo(({ label }: { label: string }) => h("li", null, label));
    const Fresh = () => h("li", null, "fresh");
    function List() {
      const [rows, setRows] = useState(1);
      addRow = () => setRows((count) => count + 1);
      return h(
        "ul",
        null,
        h(Row, { label: `${rows} rows` }),
        h(MemoRow, { label: "fixed" }),
        rows > 1 ? h(Fresh) : null,
      );
    }
    const Header = () => h("h1", null, "title");
    const Layout = () => h("main", null, h(Header), h(List));
    render(h(Layout));

    const hotSpots = new Map<string, HotSpot>();
    expect(commit(hotSpots, () => addRow())).toBe(true);
    expect(
      [...hotSpots.values()].map((spot) => [
        spot.name,
        spot.siteKind,
        spot.hookChanges,
        spot.props,
        spot.cascades,
      ]),
    ).toEqual([
      ["List", "used-at", 1, [], 0],
      ["Row", "used-at", 0, ["label"], 0],
    ]);
  });

  it("finds a library-created component's own element after a null render and in memoized JSX", () => {
    let setShown = (_shown: boolean): void => undefined;
    function Page() {
      const [shown, setState] = useState(true);
      setShown = setState;
      return shown ? h("section", null, "page") : null;
    }
    let tick = (): void => undefined;
    const Card = ({ children }: { children: ReturnType<typeof h> }) => h("article", null, children);
    function Shell() {
      const [, setTicks] = useState(0);
      tick = () => setTicks((count) => count + 1);
      // React skips Card, so the paragraph Shell owns sits in a subtree that did not render.
      return useMemo(() => h(Card, null, h("p", null, "memo")), []);
    }
    // A router creates the page elements in node_modules.
    // SAFETY: the function body calls its first argument with its second and returns the result.
    const library = new Function(
      "h",
      "Page",
      "return h(Page);\n//# sourceURL=http://127.0.0.1:3303/node_modules/router/index.js",
    ) as (create: typeof h, type: () => ReturnType<typeof h> | null) => ReturnType<typeof h>;
    render(h("div", null, library(h, Page), library(h, Shell)));

    const hotSpots = new Map<string, HotSpot>();
    expect(commit(hotSpots, () => setShown(false))).toBe(false);
    expect(commit(hotSpots, () => setShown(true))).toBe(true);
    expect(commit(hotSpots, () => tick())).toBe(true);
    expect([...hotSpots.values()].map((spot) => [spot.name, spot.siteKind, spot.renders])).toEqual([
      ["Page", "renders", 1],
      ["Shell", "renders", 1],
    ]);
  });

  it("finds a re-rendered component past 5,000 fibers", () => {
    let bump = (): void => undefined;
    const Leaf = ({ index }: { index: number }) => h("span", null, h("b", null, index));
    function Counter() {
      const [count, setCount] = useState(0);
      bump = () => setCount((value) => value + 1);
      return h("output", null, count);
    }
    const leaves = Array.from({ length: 2000 }, (_, index) => h(Leaf, { key: index, index }));
    render(h("div", null, ...leaves, h(Counter)));

    const hotSpots = new Map<string, HotSpot>();
    commit(hotSpots, () => bump());
    commit(hotSpots, () => bump());
    expect([...hotSpots.values()].map((spot) => [spot.name, spot.renders])).toEqual([
      ["Counter", 2],
    ]);
  });
});
