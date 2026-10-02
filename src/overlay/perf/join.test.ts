import type { LiteFiberSummary } from "react-scan/lite";
import { describe, expect, it } from "vitest";

import type { ActionEntry, RequestEntry } from "../../shared/timeline.ts";
import { addCommit, slowRequests, type HotSpot } from "./join.ts";

const origin = "http://127.0.0.1:3303";
const isProject = (fileName: string) => fileName.startsWith(`${origin}/src/`);

function click(seq: number, at: string, testId: string): ActionEntry {
  return { kind: "action", seq, at, type: "click", target: { tag: "button", testId } };
}

function request(seq: number, at: string, durationMs: number): RequestEntry {
  return {
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
}

describe("slowRequests", () => {
  it("joins a request to the last earlier action only inside the cause window", () => {
    const actions = [
      click(1, "2026-10-02T10:00:00.000Z", "first"),
      click(3, "2026-10-02T10:00:05.000Z", "second"),
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

function fiber(
  name: string,
  depth: number,
  start: number,
  change: Partial<NonNullable<LiteFiberSummary["changeDescription"]>> | null,
  site?: string,
): LiteFiberSummary {
  return {
    name,
    depth,
    tag: change === null ? 5 : 0,
    actualDuration: 1,
    actualStartTime: start,
    selfBaseDuration: 0.5,
    treeBaseDuration: 1,
    source:
      site === undefined ? null : { fileName: `${origin}${site}`, lineNumber: 3, columnNumber: 5 },
    ownerName: null,
    changeDescription:
      change === null
        ? null
        : {
            isFirstMount: false,
            props: [],
            state: false,
            context: false,
            hooks: [],
            parent: true,
            ...change,
          },
  };
}

describe("addCommit", () => {
  it("counts updated components and their cascades, not bailed-out ancestors or stale fibers", () => {
    const hotSpots = new Map<string, HotSpot>();
    const changed = addCommit(
      hotSpots,
      [
        fiber("HostRoot", 0, 100, null),
        // On the update path: processed in this commit, nothing of its own changed.
        fiber("Layout", 1, 100, {}, "/src/layout.tsx"),
        // Stale: last rendered long before this commit; its change description is noise.
        fiber("Header", 2, 10, { hooks: [1] }, "/src/header.tsx"),
        fiber("List", 2, 101, { hooks: [0] }, "/src/list.tsx"),
        fiber("Row", 3, 102, {}, "/src/row.tsx"),
        fiber("MemoRow", 3, 102, {}, "/src/row.tsx"),
      ].map((entry) => (entry.name === "MemoRow" ? { ...entry, tag: 15 } : entry)),
      isProject,
    );
    expect(changed).toBe(true);
    expect(
      [...hotSpots.values()].map((spot) => [spot.name, spot.hookChanges, spot.cascades]),
    ).toEqual([
      ["List", 1, 0],
      ["Row", 0, 1],
    ]);
  });
});
