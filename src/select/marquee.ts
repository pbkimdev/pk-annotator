import type { Box } from "../shared/schema.ts";

export type Candidate<E> = { element: E; box: Box };

export type HitTree<E> = {
  parent(element: E): E | null;
  children(element: E): readonly E[];
  isComponentRoot(element: E): boolean;
};

export type Containment = "contain" | "intersect";

/**
 * Resolves the elements a marquee selects. Candidates come in document order.
 * Hits are fully contained (or intersecting with Alt); a hit that contains another hit
 * is dropped; a component root replaces its children when every child is hit.
 */
export function marqueeHits<E>(
  marquee: Box,
  candidates: readonly Candidate<E>[],
  containment: Containment,
  tree: HitTree<E>,
): E[] {
  const test = containment === "contain" ? contains : intersects;
  const hits = candidates.filter((candidate) => test(marquee, candidate.box));
  const hitSet = new Set(hits.map((candidate) => candidate.element));

  const ancestors = new Set<E>();
  for (const element of hitSet) {
    for (let parent = tree.parent(element); parent !== null; parent = tree.parent(parent)) {
      if (ancestors.has(parent)) break;
      ancestors.add(parent);
    }
  }
  const order = new Map(candidates.map((candidate, index) => [candidate.element, index]));
  let selected = [...hitSet].filter((element) => !ancestors.has(element));

  for (let changed = true; changed;) {
    changed = false;
    const current = new Set(selected);
    const parents = new Set(
      selected.map((element) => tree.parent(element)).filter((parent) => parent !== null),
    );
    for (const parent of parents) {
      const children = tree.children(parent);
      if (!tree.isComponentRoot(parent) || !children.every((child) => current.has(child))) {
        continue;
      }
      const first = Math.min(...children.map((child) => order.get(child) ?? Infinity));
      order.set(parent, first);
      selected = [...selected.filter((element) => !children.includes(element)), parent];
      changed = true;
    }
  }
  return selected.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const INTERACTIVE =
  "a[href], button, input, select, textarea, summary, label, img, svg, video, canvas, " +
  "[role], [tabindex]:not([tabindex='-1']), [contenteditable]:not([contenteditable='false']), " +
  "[data-pka-src]";

const MIN_SIDE = 4;
const NEAR_VIEWPORT = 0.9;

/** Interactive, text, img, or stamped elements in document order, minus tiny and near-viewport-size ones. */
export function marqueeCandidates(exclude: Element): Candidate<Element>[] {
  const candidates: Candidate<Element>[] = [];
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  for (const element of document.body.querySelectorAll("*")) {
    if (element === exclude || !(element.matches(INTERACTIVE) || hasOwnText(element))) continue;
    if (element.closest("svg") !== element && element.closest("svg") !== null) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) continue;
    if (
      rect.width >= viewportWidth * NEAR_VIEWPORT &&
      rect.height >= viewportHeight * NEAR_VIEWPORT
    ) {
      continue;
    }
    candidates.push({ element, box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } });
  }
  return candidates;
}

function hasOwnText(element: Element): boolean {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true;
  }
  return false;
}
