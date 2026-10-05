import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import {
  calibrateFromDocument,
  locate,
  ownerName,
  prewarm,
  type Location,
} from "../select/source.ts";
import { startPicking } from "../select/pick.ts";
import { findQuote, startTextPicking } from "../select/quote.ts";
import { getCapture } from "./capture.ts";
import { NOTE, elementKey, nextSelection, useOverlay } from "./context.tsx";
import { useText } from "./language.ts";
import { cn } from "./lib/utils.ts";
import { MAX_ELEMENTS, anchor, pickOf, remember, rememberQuote, type Picked } from "./send.ts";
import { useStore } from "./store.ts";

/**
 * Re-renders on scroll and resize while `active`, so boxes follow their elements, and on DOM
 * changes while `waiting`, so a mark finds its element when its route renders it again.
 */
function useLayoutTicks(active: boolean, waiting: boolean): void {
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const schedule = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          tick();
        });
      }
    };
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    const observer = waiting ? new MutationObserver(schedule) : undefined;
    observer?.observe(document.body, { childList: true, subtree: true });
    // The element can render between the render that missed it and this effect.
    if (waiting) schedule();
    return () => {
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active, waiting]);
}

export function shortPath(location: string): string {
  const parts = location.split("/");
  return parts.length <= 3 ? location : `…/${parts.slice(-2).join("/")}`;
}

function HoverBox({ element }: { element: Element }) {
  const [location, setLocation] = useState<Location | undefined>();
  useEffect(() => {
    let current = true;
    setLocation(undefined);
    void locate(element).then((resolved) => {
      if (current) setLocation(resolved);
    });
    return () => {
      current = false;
    };
  }, [element]);

  const rect = element.getBoundingClientRect();
  const name = location?.component ?? ownerName(element) ?? element.localName;
  const where = location?.source ?? location?.usedAt;
  const below = rect.top < 52;
  return (
    <>
      <div
        className="pointer-events-none fixed rounded-[3px] bg-pick/10 outline-2 outline-pick"
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      />
      <div
        data-testid="pka-hover-label"
        className="pointer-events-none fixed max-w-[min(32rem,calc(100vw-1rem))] rounded-md bg-foreground px-2 py-1 font-mono text-[11px] leading-4 text-background shadow-md"
        style={{
          left: Math.max(4, Math.min(rect.left, window.innerWidth - 260)),
          ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
        }}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-sans text-xs font-semibold">{name}</span>
          <span className="truncate opacity-80" title={where}>
            {where ?? (location === undefined ? "locating…" : "no source")}
          </span>
        </div>
        {location?.source !== undefined && location.usedAt !== undefined && (
          <div className="truncate opacity-60" title={location.usedAt}>
            used at {location.usedAt}
          </div>
        )}
      </div>
    </>
  );
}

// The number sits outside the box, above it or, near the viewport top, below it, so it
// never covers the selected element's own text.
const BADGE_HEIGHT = 16;

function SelectionBox({ rect, n, outline }: { rect: DOMRect; n: number; outline: boolean }) {
  return (
    <div
      className={cn("pointer-events-none fixed rounded-[3px]", outline && "outline-2 outline-pick")}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      <span
        data-testid="pka-selection-badge"
        className={cn(
          "absolute -left-0.5 grid h-4 min-w-4 place-items-center bg-pick px-1 font-sans text-[10px] leading-none font-semibold text-pick-foreground tabular-nums",
          rect.top < BADGE_HEIGHT + 2
            ? "top-full mt-0.5 rounded-b-[3px]"
            : "bottom-full mb-0.5 rounded-t-[3px]",
        )}
      >
        {n}
      </span>
    </div>
  );
}

const HIGHLIGHT = "pka-quote";
// ::highlight() styles text in the page, so its rule lives in a document sheet, not the shadow root.
const highlightSheet = new CSSStyleSheet();

// A quote's range, found again when a render replaced the text nodes it was in.
const ranges = new WeakMap<Picked, Range>();

function quoteRange(target: Element, pick: Picked): Range | null {
  if (pick.quote === undefined) return null;
  const cached = ranges.get(pick);
  if (
    cached !== undefined &&
    cached.startContainer.isConnected &&
    target.contains(cached.commonAncestorContainer) &&
    cached.toString() === pick.quote.exact
  ) {
    return cached;
  }
  const range = findQuote(target, pick.quote);
  if (range !== null) ranges.set(pick, range);
  return range;
}

/** Paints the quotes on the page in the pick color, or removes the highlight when there are none. */
function useQuoteHighlight(host: HTMLElement, quotes: readonly Range[]): void {
  // Scrolling re-renders every frame; the highlight changes only with its ranges or color.
  const painted = useRef<{ quotes: readonly Range[]; color: string }>({ quotes: [], color: "" });
  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const color = getComputedStyle(host).getPropertyValue("--pka-pick").trim();
    const previous = painted.current;
    if (
      previous.color === color &&
      previous.quotes.length === quotes.length &&
      previous.quotes.every((range, index) => range === quotes[index])
    ) {
      return;
    }
    painted.current = { quotes, color };
    if (quotes.length === 0) {
      CSS.highlights.delete(HIGHLIGHT);
      return;
    }
    highlightSheet.replaceSync(
      `::highlight(${HIGHLIGHT}) { background-color: color-mix(in oklch, ${color} 28%, transparent); text-decoration: underline 2px ${color}; }`,
    );
    if (!document.adoptedStyleSheets.includes(highlightSheet)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, highlightSheet];
    }
    CSS.highlights.set(HIGHLIGHT, new Highlight(...quotes));
  });
  useEffect(
    () => () => {
      painted.current = { quotes: [], color: "" };
      if ("highlights" in CSS) CSS.highlights.delete(HIGHLIGHT);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (sheet) => sheet !== highlightSheet,
      );
    },
    [],
  );
}

/** Hover box, numbered selection boxes, the marquee, and the pointer-catching layer. */
export function PickLayer() {
  const t = useText();
  const { host, ui } = useOverlay();
  const picking = useStore(ui, (state) => state.picking);
  const busy = useStore(ui, (state) => state.busy);
  const visible = useStore(ui, (state) => state.visible);
  const selection = useStore(ui, (state) => state.selection);
  const hover = useStore(ui, (state) => state.hover);
  const lasso = useStore(ui, (state) => state.lasso);
  const marks = useStore(ui, (state) => state.marks);
  const editing = useStore(ui, (state) => state.editing);
  const marquee = useStore(ui, (state) => state.marquee);
  const selectTip = useStore(ui, (state) => state.selectTip);
  const layer = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const active = visible && !busy && picking !== null;
  // Each pick is drawn only on the route it was made on; numbers count every pick, so a
  // mark keeps its number on every route.
  const route = useSyncExternalStore(getCapture().subscribe, () => location.pathname);
  const boxes = [
    ...marks
      .filter((mark) => mark.id !== editing)
      .flatMap((mark) =>
        mark.elements.map((element, index) => ({ element, pick: mark.picks[index] })),
      )
      .map(({ element, pick }, index) => ({
        element,
        pick,
        n: index + 1,
        key: `saved-${elementKey(element)}-${index}`,
      })),
    ...selection.map((element, index) => ({
      element,
      pick: pickOf(element),
      n: index + 1,
      key: String(elementKey(element)),
    })),
  ].map((box) => {
    if (box.pick === undefined) throw new Error(`Saved element ${box.n} has no pick`);
    const target = anchor(box.element, box.pick);
    const quote = target === null ? null : quoteRange(target, box.pick);
    return { ...box, pick: box.pick, route: box.pick.route, target, quote };
  });
  // A quote whose text is not on the page now waits for it like a pick whose element is not.
  const waiting = boxes.some(
    (box) =>
      box.route === route &&
      (box.target === null || (box.pick.quote !== undefined && box.quote === null)),
  );
  useQuoteHighlight(
    host,
    boxes.flatMap((box) => (box.quote === null ? [] : [box.quote])),
  );

  useLayoutTicks(visible && (boxes.length > 0 || hover !== null), visible && waiting);

  useEffect(() => {
    if (!active || layer.current === null) return;
    calibrateFromDocument();
    const center = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    prewarm(
      [center, document.querySelector("[data-pka-src]")].filter((element) => element !== null),
    );
    if (picking === "text") {
      return startTextPicking(host, {
        select: (element, quote, range) => {
          const { selection } = ui.get();
          const next = selection.includes(element) ? selection : [...selection, element];
          if (next.length > MAX_ELEMENTS) {
            ui.set({ tooMany: next.length, panel: NOTE });
            return;
          }
          // One pick per element: a second quote in an element replaces its first.
          rememberQuote(element, quote, range);
          ui.set({ selection: next, tooMany: null, panel: NOTE });
        },
        escape: () => {
          if (ui.get().selection.length > 0) ui.set({ selection: [], tooMany: null });
          else ui.set({ picking: null, tooMany: null });
        },
        enter: () => ui.set({ picking: null, panel: NOTE }),
      });
    }
    // Picking swallows pointermove at window capture, so the tip's listener goes first.
    const follow = (event: PointerEvent) => {
      if (tip.current === null) return;
      tip.current.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 18}px)`;
      tip.current.hidden = false;
    };
    window.addEventListener("pointermove", follow, { capture: true, passive: true });
    const stop = startPicking(host, layer.current, picking, {
      hover: (element) => ui.set({ hover: element }),
      select: (elements, how) => {
        const next = nextSelection(ui.get().selection, elements, how);
        // Refused before describing, locating, or badging a large box or lasso hit set.
        if (next.length > MAX_ELEMENTS) {
          ui.set({ tooMany: next.length, panel: NOTE });
          return;
        }
        remember(elements);
        ui.set({ selection: next, tooMany: null, panel: NOTE });
      },
      marquee: (box, containment) =>
        ui.set({ marquee: box === null ? null : { box, containment } }),
      lasso: (points) => ui.set({ lasso: points }),
      escape: () => {
        if (ui.get().selection.length > 0) ui.set({ selection: [], tooMany: null });
        else ui.set({ picking: null, tooMany: null });
      },
      enter: () => ui.set({ picking: null, panel: NOTE }),
    });
    return () => {
      window.removeEventListener("pointermove", follow, { capture: true });
      stop();
    };
  }, [active, picking, host, ui]);

  if (!visible) return null;
  return (
    <>
      <div
        ref={layer}
        data-testid="pka-pick-layer"
        aria-hidden="true"
        className={cn(
          "fixed inset-0",
          active && picking !== "text" ? "pointer-events-auto cursor-crosshair" : "hidden",
        )}
      />
      {boxes.map((box) => {
        if (box.target === null) return null;
        if (box.pick.quote === undefined) {
          return (
            <SelectionBox
              key={box.key}
              rect={box.target.getBoundingClientRect()}
              n={box.n}
              outline
            />
          );
        }
        // The highlight marks a quote; the number sits at its first line.
        const first = box.quote?.getClientRects()[0];
        return (
          first !== undefined && (
            <SelectionBox key={box.key} rect={first} n={box.n} outline={false} />
          )
        );
      })}
      {active && hover?.isConnected === true && marquee === null && <HoverBox element={hover} />}
      {active && picking === "pick" && selectTip && (
        // Hidden until the first pointer move places it; it then fades once and unmounts.
        <div
          ref={tip}
          hidden
          data-testid="pka-select-tip"
          className="pointer-events-none fixed top-0 left-0 animate-out rounded-md bg-foreground px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-background shadow-md delay-[2500ms] duration-500 fade-out fill-mode-forwards"
          onAnimationEnd={() => ui.set({ selectTip: false })}
        >
          {t("⇧ Multi-select")}
        </div>
      )}
      {lasso !== null && (
        <svg className="pointer-events-none fixed inset-0 size-full overflow-visible text-pick">
          <polygon
            points={lasso.map((point) => `${point.x},${point.y}`).join(" ")}
            fill="currentColor"
            fillOpacity="0.1"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      )}
      {marquee !== null && (
        <div
          data-testid="pka-marquee"
          className={cn(
            "pointer-events-none fixed rounded-[2px] border border-pick bg-pick/10",
            marquee.containment === "intersect" && "border-dashed bg-pick/5",
          )}
          style={{
            left: marquee.box.x,
            top: marquee.box.y,
            width: marquee.box.w,
            height: marquee.box.h,
          }}
        >
          <span className="absolute -bottom-6 left-0 rounded-sm bg-pick px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-pick-foreground">
            {marquee.containment === "intersect" ? "Touching" : "Inside"}
          </span>
        </div>
      )}
    </>
  );
}
