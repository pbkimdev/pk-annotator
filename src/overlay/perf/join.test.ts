// @vitest-environment happy-dom
import { instrument, type FiberRoot } from "bippy";
import { describe, expect, it } from "vitest";

import type { ActionEntry, RequestEntry } from "../../shared/timeline.ts";
import { addCommit, slowRequests, type HotSpot } from "./join.ts";

// React registers with the DevTools hook when it loads, so the hook comes first.
const commits: FiberRoot[] = [];
instrument({ onCommitFiberRoot: (_rendererId, root) => commits.push(root) });
const { createElement: h, memo, useState } = await import("react");
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

  it("finds a re-rendered component past 5,000 fibers without walking unchanged subtrees", () => {
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
