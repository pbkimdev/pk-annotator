import type { Box } from "../shared/schema.ts";
import {
  lassoHits,
  marqueeCandidates,
  marqueeHits,
  type Point,
  type Containment,
} from "./marquee.ts";
import { isComponentRoot } from "./source.ts";

export type PickMode = "pick" | "box" | "lasso";
export type SelectHow = "replace" | "toggle" | "add";

export type PickHandlers = {
  hover(element: Element | null): void;
  select(elements: Element[], how: SelectHow): void;
  marquee(box: Box | null, containment: Containment): void;
  lasso(points: readonly Point[] | null): void;
  escape(): void;
  enter(): void;
};

const DRAG_THRESHOLD = { pick: 4, box: 1, lasso: 3 } as const;

const elementTree = {
  parent: (element: Element) => element.parentElement,
  children: (element: Element) => [...element.children],
  isComponentRoot,
};

/**
 * Captures pointer and key events while picking. `layer` covers the page inside the
 * shadow root; events whose path includes it are page picks, and nothing else on the
 * page sees them. Events on the menu, hub, and panels pass through untouched.
 */
export function startPicking(
  host: Element,
  layer: Element,
  mode: PickMode,
  handlers: PickHandlers,
): () => void {
  let frame = 0;
  let points: Point[] = [];
  let lastPoint: { x: number; y: number } | undefined;
  let drag: { x: number; y: number; active: boolean } | undefined;

  const onPage = (event: Event) => event.composedPath().includes(layer);
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const elementAt = (x: number, y: number) =>
    document
      .elementsFromPoint(x, y)
      .find(
        (element) =>
          element !== host && element !== document.documentElement && element !== document.body,
      ) ?? null;
  const dragBox = (event: PointerEvent): Box => {
    const start = drag ?? { x: event.clientX, y: event.clientY };
    return {
      x: Math.min(start.x, event.clientX),
      y: Math.min(start.y, event.clientY),
      w: Math.abs(event.clientX - start.x),
      h: Math.abs(event.clientY - start.y),
    };
  };
  const containmentOf = (event: PointerEvent): Containment =>
    event.altKey ? "intersect" : "contain";

  const onPointerMove = (event: PointerEvent) => {
    if (!onPage(event)) return;
    swallow(event);
    if (drag !== undefined) {
      const box = dragBox(event);
      if (!drag.active && Math.max(box.w, box.h) > DRAG_THRESHOLD[mode]) {
        drag.active = true;
        handlers.hover(null);
      }
      if (drag.active && mode === "lasso") {
        const last = points.at(-1)!;
        if (Math.hypot(last.x - event.clientX, last.y - event.clientY) >= 3) {
          if (points.length >= 512) points = points.filter((_, index) => index % 2 === 0);
          points.push({ x: event.clientX, y: event.clientY });
          handlers.lasso([...points]);
        }
      } else if (drag.active) handlers.marquee(box, containmentOf(event));
      return;
    }
    lastPoint = { x: event.clientX, y: event.clientY };
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (lastPoint !== undefined && drag === undefined) {
        handlers.hover(elementAt(lastPoint.x, lastPoint.y));
      }
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!onPage(event)) return;
    swallow(event);
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, active: false };
    points = [{ x: event.clientX, y: event.clientY }];
    if (layer instanceof HTMLElement || layer instanceof SVGElement) {
      layer.setPointerCapture(event.pointerId);
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!onPage(event)) return;
    swallow(event);
    if (drag === undefined || event.button !== 0) return;
    const wasDrag = drag.active;
    const box = dragBox(event);
    drag = undefined;
    if (wasDrag) {
      handlers.marquee(null, containmentOf(event));
      const candidates = marqueeCandidates(host);
      const hits =
        mode === "lasso"
          ? lassoHits(points, candidates, elementTree)
          : marqueeHits(box, candidates, containmentOf(event), elementTree);
      handlers.lasso(null);
      handlers.select(hits, event.shiftKey ? "add" : "replace");
      return;
    }
    const target = elementAt(event.clientX, event.clientY);
    if (target !== null) handlers.select([target], event.shiftKey ? "toggle" : "replace");
    handlers.hover(target);
  };

  const onPageEvent = (event: Event) => {
    if (onPage(event)) swallow(event);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // A menu, including the overlay's own, handles its keys before picking does.
    if (event.composedPath().some(isMenu)) return;
    if (event.key === "Escape") {
      swallow(event);
      if (drag?.active) handlers.marquee(null, "contain");
      drag = undefined;
      handlers.lasso(null);
      handlers.escape();
    } else if (event.key === "Enter" && !event.composedPath().some(isTextField)) {
      swallow(event);
      handlers.enter();
    }
  };

  const listening = new AbortController();
  const options = { capture: true, signal: listening.signal };
  window.addEventListener("pointermove", onPointerMove, options);
  window.addEventListener("pointerdown", onPointerDown, options);
  window.addEventListener("pointerup", onPointerUp, options);
  window.addEventListener(
    "pointercancel",
    () => {
      if (drag?.active) handlers.marquee(null, "contain");
      drag = undefined;
      handlers.lasso(null);
    },
    options,
  );
  for (const type of ["click", "mousedown", "mouseup", "dblclick", "auxclick", "contextmenu"]) {
    window.addEventListener(type, onPageEvent, options);
  }
  window.addEventListener("keydown", onKeyDown, options);
  return () => {
    listening.abort();
    if (frame !== 0) cancelAnimationFrame(frame);
    handlers.hover(null);
    handlers.marquee(null, "contain");
    handlers.lasso(null);
  };
}

function isTextField(target: EventTarget): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isMenu(target: EventTarget): boolean {
  return target instanceof Element && target.getAttribute("role") === "menu";
}
