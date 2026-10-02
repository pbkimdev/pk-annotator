import { useEffect, useReducer, useRef, useState } from "react";

import {
  calibrateFromDocument,
  locate,
  ownerName,
  prewarm,
  type Location,
} from "../select/source.ts";
import { startPicking } from "../select/pick.ts";
import { COMPOSE, elementKey, nextSelection, useOverlay } from "./context.tsx";
import { cn } from "./lib/utils.ts";
import { remember } from "./send.ts";
import { useStore } from "./store.ts";

/** Re-renders on scroll and resize while `active`, so boxes follow their elements. */
function useLayoutTicks(active: boolean): void {
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
    return () => {
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [active]);
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

function SelectionBox({ element, n }: { element: Element; n: number }) {
  if (!element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return (
    <div
      className="pointer-events-none fixed rounded-[3px] outline-2 outline-pick"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      <span
        data-testid="pka-selection-badge"
        className="absolute -top-2.5 -left-2.5 grid size-5 place-items-center rounded-full bg-pick font-sans text-[11px] font-semibold text-pick-foreground shadow-sm ring-2 ring-background"
      >
        {n}
      </span>
    </div>
  );
}

/** Hover box, numbered selection boxes, the marquee, and the pointer-catching layer. */
export function PickLayer() {
  const { host, ui } = useOverlay();
  const picking = useStore(ui, (state) => state.picking);
  const visible = useStore(ui, (state) => state.visible);
  const selection = useStore(ui, (state) => state.selection);
  const hover = useStore(ui, (state) => state.hover);
  const marquee = useStore(ui, (state) => state.marquee);
  const layer = useRef<HTMLDivElement>(null);
  const active = visible && picking !== null;

  useLayoutTicks(visible && (selection.length > 0 || hover !== null));

  useEffect(() => {
    if (!active || layer.current === null) return;
    calibrateFromDocument();
    const center = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    prewarm(
      [center, document.querySelector("[data-pka-src]")].filter((element) => element !== null),
    );
    return startPicking(host, layer.current, picking, {
      hover: (element) => ui.set({ hover: element }),
      select: (elements, how) => {
        remember(elements);
        ui.set({ selection: nextSelection(ui.get().selection, elements, how) });
      },
      marquee: (box, containment) =>
        ui.set({ marquee: box === null ? null : { box, containment } }),
      escape: () => {
        if (ui.get().selection.length > 0) ui.set({ selection: [] });
        else ui.set({ picking: null });
      },
      enter: () => ui.set({ picking: null, panel: COMPOSE }),
    });
  }, [active, picking, host, ui]);

  if (!visible) return null;
  return (
    <>
      <div
        ref={layer}
        data-testid="pka-pick-layer"
        aria-hidden="true"
        className={cn("fixed inset-0", active ? "pointer-events-auto cursor-crosshair" : "hidden")}
      />
      {selection.map((element, index) => (
        <SelectionBox key={elementKey(element)} element={element} n={index + 1} />
      ))}
      {active && hover !== null && marquee === null && <HoverBox element={hover} />}
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
