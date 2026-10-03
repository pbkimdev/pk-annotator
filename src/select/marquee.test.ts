import { describe, expect, it } from "vitest";

import type { Box } from "../shared/schema.ts";
import { lassoHits, marqueeHits, type Candidate, type HitTree } from "./marquee.ts";

type Node = { name: string; parent: Node | null; children: Node[]; root: boolean };

function node(name: string, parent: Node | null, root = false): Node {
  const created: Node = { name, parent, children: [], root };
  parent?.children.push(created);
  return created;
}

const tree: HitTree<Node> = {
  parent: (element) => element.parent,
  children: (element) => element.children,
  isComponentRoot: (element) => element.root,
};

const names = (nodes: Node[]) => nodes.map((element) => element.name);

// page
// ├── list (ul)            0,0   200x90
// │   ├── a (li)            0,0   200x30
// │   ├── b (li)            0,30  200x30
// │   └── c (li)            0,60  200x30
// └── card (component root) 0,100 200x60
//     ├── title            0,100 200x30
//     └── action           0,130 100x30
const page = node("page", null);
const list = node("list", page);
const a = node("a", list);
const b = node("b", list);
const c = node("c", list);
const card = node("card", page, true);
const title = node("title", card);
const action = node("action", card);

const boxes = new Map<Node, Box>([
  [list, { x: 0, y: 0, w: 200, h: 90 }],
  [a, { x: 0, y: 0, w: 200, h: 30 }],
  [b, { x: 0, y: 30, w: 200, h: 30 }],
  [c, { x: 0, y: 60, w: 200, h: 30 }],
  [card, { x: 0, y: 100, w: 200, h: 60 }],
  [title, { x: 0, y: 100, w: 200, h: 30 }],
  [action, { x: 0, y: 130, w: 100, h: 30 }],
]);
const candidates: Candidate<Node>[] = [...boxes].map(([element, box]) => ({ element, box }));

describe("marqueeHits", () => {
  it("keeps the innermost hits when an ancestor is also contained", () => {
    const hits = marqueeHits({ x: -4, y: -4, w: 208, h: 98 }, candidates, "contain", tree);
    expect(names(hits)).toEqual(["a", "b", "c"]);
  });

  it("selects only fully contained elements, or touching ones with intersection", () => {
    const marquee = { x: -4, y: 10, w: 208, h: 40 };
    expect(names(marqueeHits(marquee, candidates, "contain", tree))).toEqual([]);
    expect(names(marqueeHits(marquee, candidates, "intersect", tree))).toEqual(["a", "b"]);
  });

  it("collapses to a component root only when every child is hit", () => {
    const whole = marqueeHits({ x: -4, y: 96, w: 208, h: 68 }, candidates, "contain", tree);
    expect(names(whole)).toEqual(["card"]);
    const part = marqueeHits({ x: -4, y: 96, w: 208, h: 36 }, candidates, "contain", tree);
    expect(names(part)).toEqual(["title"]);
  });

  it("keeps document order across collapsed roots and plain hits", () => {
    const hits = marqueeHits({ x: -4, y: 50, w: 208, h: 120 }, candidates, "contain", tree);
    expect(names(hits)).toEqual(["c", "card"]);
  });
});

describe("lassoHits", () => {
  it("excludes elements inside the bounding box but outside a concave lasso", () => {
    const points = [
      { x: -2, y: -2 },
      { x: 202, y: -2 },
      { x: 202, y: 32 },
      { x: 80, y: 32 },
      { x: 80, y: 162 },
      { x: -2, y: 162 },
    ];
    expect(names(lassoHits(points, candidates, tree))).toEqual(["a", "action"]);
  });
});
