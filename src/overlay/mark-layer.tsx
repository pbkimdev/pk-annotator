import { CheckIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from "react";

import type { Point } from "../select/marquee.ts";
import type { Box } from "../shared/schema.ts";
import { getCapture } from "./capture.ts";
import {
  MAX_DRAFT_BYTES,
  MAX_MARKS,
  useOverlay,
  type SavedMark,
  type UiState,
} from "./context.tsx";
import { useText } from "./language.ts";
import { HOST_TAG } from "./launcher.ts";
import { startRecording } from "./panels/record.tsx";
import { addAttachment, attachments, type ComposerAttachment } from "./registry.ts";
import { captureCanvas, currentViewport, pageScale, toBlob } from "./send.ts";
import { createStore, useStore } from "./store.ts";
import { Button } from "./ui/button.tsx";

type Gesture = NonNullable<UiState["gesture"]>;
type Stroke = {
  kind: "rectangle" | "ellipse" | "freehand";
  points: readonly Point[];
  color: string;
};
/** A drawing in document coordinates; it stays on its route until its attachment is gone. */
type Drawing = Stroke & { id: string; route: string };
/** A viewport capture waiting in the crop dialog; `start` is the dragged area or the viewport. */
type Shot = { page: HTMLCanvasElement; viewport: Box; start: Box };

const MIN_DRAG = 3;
const MIN_CROP = 8;
const MAX_CAPTURES = 50;
const drawings = createStore<{ items: readonly Drawing[] }>({ items: [] });

function bounds(points: readonly Point[]): Box {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function viewportBox(): Box {
  const root = document.documentElement;
  return { x: 0, y: 0, w: root.clientWidth, h: root.clientHeight };
}

async function capturePage(): Promise<HTMLCanvasElement> {
  const { snapdom } = await import("@zumer/snapdom");
  const result = await snapdom(document.documentElement, {
    clip: "viewport",
    exclude: [HOST_TAG],
    excludeMode: "remove",
    reconcile: true,
  });
  return captureCanvas(result);
}

/** Draws `stroke`, in viewport CSS pixels, onto a snapdom viewport capture. */
function flatten(page: HTMLCanvasElement, stroke: Stroke): void {
  const scale = pageScale(page);
  const context = page.getContext("2d");
  if (context === null) throw new Error("No canvas context for screenshot");
  context.save();
  // snapdom's toCanvas leaves scale(devicePixelRatio) on this context, so a relative
  // scale() would place the stroke at devicePixelRatio² times its points.
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.strokeStyle = stroke.color;
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.lineCap = "round";
  const box = bounds(stroke.points);
  context.beginPath();
  if (stroke.kind === "rectangle") context.rect(box.x, box.y, box.w, box.h);
  else if (stroke.kind === "ellipse")
    context.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
  else
    for (const [index, point] of stroke.points.entries()) {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    }
  context.stroke();
  context.restore();
}

async function frame(
  id: string,
  page: HTMLCanvasElement,
  region: Box | null,
  label: string,
  stroke?: Stroke,
): Promise<ComposerAttachment> {
  let canvas = page;
  if (region !== null) {
    const scale = pageScale(page);
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(region.w * scale));
    canvas.height = Math.max(1, Math.round(region.h * scale));
    const crop = canvas.getContext("2d");
    if (crop === null) throw new Error("No canvas context for screenshot crop");
    crop.drawImage(
      page,
      region.x * scale,
      region.y * scale,
      region.w * scale,
      region.h * scale,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }
  const data = await toBlob(canvas);
  const path = `capture/images/${id}.webp`;
  const metadata = new Blob(
    [JSON.stringify({ viewport: currentViewport(), region, stroke }, null, 2)],
    { type: "application/json" },
  );
  return {
    id,
    kind: "frame",
    label,
    collect: async () => ({
      path,
      summary: label,
      files: [
        { path, data },
        { path: `capture/images/${id}.json`, data: metadata },
      ],
    }),
  };
}

function StrokeOutline({ stroke, area = false }: { stroke: Stroke; area?: boolean }) {
  const box = bounds(stroke.points);
  if (stroke.kind === "freehand")
    return (
      <polyline
        points={stroke.points.map((item) => `${item.x},${item.y}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  if (stroke.kind === "ellipse")
    return (
      <ellipse
        cx={box.x + box.w / 2}
        cy={box.y + box.h / 2}
        rx={box.w / 2}
        ry={box.h / 2}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      />
    );
  return (
    <rect
      x={box.x}
      y={box.y}
      width={box.w}
      height={box.h}
      fill={area ? "currentColor" : "none"}
      fillOpacity="0.08"
      stroke="currentColor"
      strokeWidth={area ? 2 : 3}
    />
  );
}

/** Drawings of the current route, moved with the document's scroll. */
function PlacedDrawings({ items }: { items: readonly Drawing[] }) {
  const route = useSyncExternalStore(getCapture().subscribe, () => location.pathname);
  const group = useRef<SVGGElement>(null);
  useLayoutEffect(() => {
    const place = () =>
      group.current?.setAttribute("transform", `translate(${-scrollX} ${-scrollY})`);
    place();
    window.addEventListener("scroll", place, { passive: true });
    return () => window.removeEventListener("scroll", place);
  }, []);
  return (
    <svg className="pointer-events-none fixed inset-0 size-full overflow-visible text-pick">
      <g ref={group}>
        {items
          .filter((drawing) => drawing.route === route)
          .map((drawing) => (
            <g key={drawing.id} data-testid="pka-drawing" style={{ color: drawing.color }}>
              <StrokeOutline stroke={drawing} />
            </g>
          ))}
      </g>
    </svg>
  );
}

type Edge = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: { edge: Edge; left: string; top: string; cursor: string }[] = [
  { edge: "nw", left: "0%", top: "0%", cursor: "nwse-resize" },
  { edge: "n", left: "50%", top: "0%", cursor: "ns-resize" },
  { edge: "ne", left: "100%", top: "0%", cursor: "nesw-resize" },
  { edge: "e", left: "100%", top: "50%", cursor: "ew-resize" },
  { edge: "se", left: "100%", top: "100%", cursor: "nwse-resize" },
  { edge: "s", left: "50%", top: "100%", cursor: "ns-resize" },
  { edge: "sw", left: "0%", top: "100%", cursor: "nesw-resize" },
  { edge: "w", left: "0%", top: "50%", cursor: "ew-resize" },
];

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function resize(box: Box, edge: Edge, dx: number, dy: number, limit: Box): Box {
  if (edge === "move")
    return {
      x: clamp(box.x + dx, 0, limit.w - box.w),
      y: clamp(box.y + dy, 0, limit.h - box.h),
      w: box.w,
      h: box.h,
    };
  let left = box.x;
  let top = box.y;
  let right = box.x + box.w;
  let bottom = box.y + box.h;
  if (edge.includes("w")) left = clamp(left + dx, 0, right - MIN_CROP);
  if (edge.includes("e")) right = clamp(right + dx, left + MIN_CROP, limit.w);
  if (edge.includes("n")) top = clamp(top + dy, 0, bottom - MIN_CROP);
  if (edge.includes("s")) bottom = clamp(bottom + dy, top + MIN_CROP, limit.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The captured viewport with a crop box; Enter or ✓ keeps the box, Escape discards. */
function CropDialog({ shot, close }: { shot: Shot; close(): void }) {
  const t = useText();
  const { ui } = useOverlay();
  const busy = useStore(ui, (state) => state.busy);
  const [box, setBox] = useState(shot.start);
  const [error, setError] = useState<string | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const drag = useRef<{ edge: Edge; x: number; y: number; box: Box } | null>(null);
  const { viewport } = shot;
  const factor = Math.min(
    1,
    (window.innerWidth * 0.9 - 24) / viewport.w,
    (window.innerHeight * 0.85 - 72) / viewport.h,
  );

  const confirm = async () => {
    if (ui.get().busy) return;
    ui.set({ busy: true });
    try {
      const whole = box.x === 0 && box.y === 0 && box.w === viewport.w && box.h === viewport.h;
      const region = whole ? null : box;
      addAttachment(
        await frame(
          randomId(),
          shot.page,
          region,
          region === null ? "Screenshot" : "Cropped screenshot",
        ),
      );
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      ui.set({ busy: false });
    }
  };
  const latest = useRef({ confirm, close });
  latest.current = { confirm, close };

  useEffect(() => {
    const canvas = shot.page;
    canvas.style.cssText = "display:block;width:100%;height:100%";
    holder.current?.prepend(canvas);
    return () => canvas.remove();
  }, [shot]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (ui.get().busy) return;
      if (event.key === "Enter") void latest.current.confirm();
      else latest.current.close();
    };
    window.addEventListener("keydown", key, { capture: true });
    return () => window.removeEventListener("keydown", key, { capture: true });
  }, [ui]);

  const grab = (edge: Edge) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { edge, x: event.clientX, y: event.clientY, box };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    const dx = (event.clientX - current.x) / factor;
    const dy = (event.clientY - current.y) / factor;
    setBox(resize(current.box, current.edge, dx, dy, viewport));
  };
  return (
    <div className="fixed inset-0 grid place-items-center bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Crop")}
        data-testid="pka-crop"
        className="flex flex-col gap-2 rounded-[20px] bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
      >
        <div
          className="relative touch-none select-none"
          style={{ width: viewport.w * factor, height: viewport.h * factor }}
          onPointerMove={move}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {/* The shade clips to the image; the handles sit above it, unclipped at its edges. */}
          <div ref={holder} className="absolute inset-0 overflow-hidden rounded-md">
            <div
              className="absolute"
              style={{
                left: box.x * factor,
                top: box.y * factor,
                width: box.w * factor,
                height: box.h * factor,
                boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.45)",
              }}
            />
          </div>
          <div
            onPointerDown={grab("move")}
            data-testid="pka-crop-box"
            className="absolute cursor-move outline-2 outline-pick"
            style={{
              left: box.x * factor,
              top: box.y * factor,
              width: box.w * factor,
              height: box.h * factor,
            }}
          >
            {HANDLES.map((handle) => (
              <span
                key={handle.edge}
                onPointerDown={grab(handle.edge)}
                className="absolute size-3 -translate-1/2 rounded-full bg-background ring-2 ring-pick"
                style={{ left: handle.left, top: handle.top, cursor: handle.cursor }}
              />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground tabular-nums">
            {Math.round(box.w)} × {Math.round(box.h)}
          </span>
          {error !== null && (
            <span role="alert" className="min-w-0 flex-1 truncate text-destructive">
              {error}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto rounded-full text-muted-foreground"
            aria-label={t("Cancel")}
            disabled={busy}
            onClick={close}
          >
            <XIcon strokeWidth={1.75} />
          </Button>
          <Button
            size="icon-sm"
            className="rounded-full"
            aria-label={t("Confirm")}
            data-testid="pka-crop-confirm"
            disabled={busy}
            onClick={() => void confirm()}
          >
            <CheckIcon strokeWidth={2} />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Drawing and area gestures, the crop dialog, and drawings kept on the page. */
export function MarkLayer() {
  const t = useText();
  const { ui, host } = useOverlay();
  const gesture = useStore(ui, (state) => state.gesture);
  const visible = useStore(ui, (state) => state.visible);
  const busy = useStore(ui, (state) => state.busy);
  const placed = useStore(drawings, (state) => state.items);
  const [points, setPoints] = useState<readonly Point[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const start = useRef<{ mode: Gesture; points: Point[] } | null>(null);

  // A drawing lives as long as its attachment, in the current mark or a saved one. Pruning
  // waits a microtask so a mark moving between the two in one task keeps its drawing.
  useEffect(() => {
    const prune = () => {
      const { items } = drawings.get();
      if (items.length === 0) return;
      const live = new Set(
        [...attachments.get(), ...ui.get().marks.flatMap((mark) => mark.attachments)].map(
          (attachment) => attachment.id,
        ),
      );
      if (items.every((drawing) => live.has(drawing.id))) return;
      drawings.set({ items: items.filter((drawing) => live.has(drawing.id)) });
    };
    const later = () => {
      if (drawings.get().items.length > 0) queueMicrotask(prune);
    };
    prune();
    const stops = [attachments.subscribe(later), ui.subscribe(later)];
    return () => {
      for (const stop of stops) stop();
    };
  }, [ui]);

  const cancel = () => {
    start.current = null;
    setPoints([]);
    setError(null);
    ui.set({ gesture: null });
  };

  /** Completes a gesture; `area` is null for the whole viewport. */
  const complete = async (mode: Gesture, area: Box | null, path: readonly Point[]) => {
    if (mode === "record-area") {
      try {
        startRecording(ui, area);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
    ui.set({ busy: true });
    try {
      if (mode === "screenshot" && attachments.get().length >= MAX_CAPTURES)
        throw new Error("Save or send this mark before adding more captures.");
      const page = await capturePage();
      if (mode === "screenshot") {
        setShot({ page, viewport: viewportBox(), start: area ?? viewportBox() });
        ui.set({ gesture: null });
        return;
      }
      const stroke: Stroke = {
        kind: mode,
        points: path,
        color: getComputedStyle(host).getPropertyValue("--pka-pick").trim(),
      };
      flatten(page, stroke);
      const id = randomId();
      const attachment = await frame(id, page, null, `${mode} annotation`, stroke);
      const collected = await attachment.collect();
      const bytes = collected.files.reduce((total, file) => total + file.data.size, 0);
      const { marks } = ui.get();
      if (marks.length >= MAX_MARKS)
        throw new Error(`Send or remove marks before saving more than ${MAX_MARKS}.`);
      if (bytes + marks.reduce((total, mark) => total + mark.bytes, 0) > MAX_DRAFT_BYTES)
        throw new Error("Saved captures would exceed 256 MB. Send or remove saved marks first.");
      const placedPoints = path.map((point) => ({ x: point.x + scrollX, y: point.y + scrollY }));
      drawings.set({
        items: [
          ...drawings.get().items,
          { ...stroke, points: placedPoints, id, route: location.pathname },
        ],
      });
      // A drawing is a screenshot mark: it joins the Send stack without opening an editor.
      // Its prompt is the capture's badge token, as the editor would write it.
      const mark: SavedMark = {
        id: randomId(),
        url: location.href,
        route: location.pathname,
        prompt: `[[attachment:${id}]]`,
        elements: [],
        picks: [],
        attachments: [{ ...attachment, collect: async () => collected }],
        bytes,
      };
      ui.set({ gesture: null, marks: [...marks, mark] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      ui.set({ busy: false });
    }
  };

  useEffect(() => {
    if (gesture === null) return;
    const key = (event: KeyboardEvent) => {
      if (ui.get().busy) return;
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      } else if (
        event.key === "Enter" &&
        start.current === null &&
        (gesture === "screenshot" || gesture === "record-area")
      ) {
        event.preventDefault();
        event.stopPropagation();
        void complete(gesture, null, []);
      }
    };
    window.addEventListener("keydown", key, { capture: true });
    return () => window.removeEventListener("keydown", key, { capture: true });
  }, [gesture, ui, complete, cancel]);

  if (!visible) return null;
  const point = (event: PointerEvent<HTMLDivElement>): Point => ({
    x: clamp(event.clientX, 0, document.documentElement.clientWidth),
    y: clamp(event.clientY, 0, document.documentElement.clientHeight),
  });
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || ui.get().busy || gesture === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { mode: gesture, points: [point(event)] };
    setError(null);
    setPoints(start.current.points);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = start.current;
    if (current === null) return;
    const next = point(event);
    if (current.mode === "freehand") {
      if (current.points.length >= 2048)
        current.points = current.points.filter((_, index) => index % 2 === 0);
      current.points.push(next);
    } else current.points = [current.points[0]!, next];
    setPoints([...current.points]);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = start.current;
    if (current === null) return;
    start.current = null;
    current.points.push(point(event));
    const area = bounds(current.points);
    setPoints([]);
    const small =
      current.mode === "freehand"
        ? Math.max(area.w, area.h) < MIN_DRAG
        : area.w < MIN_DRAG || area.h < MIN_DRAG;
    // A click without a drag takes the whole viewport.
    if (small && (current.mode === "screenshot" || current.mode === "record-area")) {
      void complete(current.mode, null, []);
      return;
    }
    if (small) {
      setError("Drag at least 3 pixels.");
      return;
    }
    void complete(current.mode, area, current.points);
  };
  const preview: Stroke | null =
    points.length === 0 || gesture === null
      ? null
      : {
          kind: gesture === "screenshot" || gesture === "record-area" ? "rectangle" : gesture,
          points,
          color: "currentColor",
        };
  return (
    <>
      {placed.length > 0 && <PlacedDrawings items={placed} />}
      {gesture !== null && (
        <>
          <div
            data-testid="pka-mark-layer"
            className="fixed inset-0 touch-none cursor-crosshair"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={() => {
              start.current = null;
              setPoints([]);
            }}
          />
          <svg className="pointer-events-none fixed inset-0 size-full overflow-visible text-pick">
            {preview !== null && (
              <StrokeOutline
                stroke={preview}
                area={gesture === "screenshot" || gesture === "record-area"}
              />
            )}
          </svg>
          <div className="fixed top-4 left-1/2 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg bg-popover px-3 py-2 text-xs shadow-lg ring-1 ring-border">
            <span role={error === null ? "status" : "alert"}>
              {error ??
                t(
                  busy
                    ? "Capturing…"
                    : gesture === "freehand"
                      ? "Draw on the page"
                      : gesture === "screenshot" || gesture === "record-area"
                        ? "Drag an area · Click or ↵ for full"
                        : "Drag on the page",
                )}
            </span>
            <Button size="xs" variant="ghost" disabled={busy} onClick={cancel}>
              {t("Cancel")}
            </Button>
          </div>
        </>
      )}
      {shot !== null && <CropDialog shot={shot} close={() => setShot(null)} />}
    </>
  );
}
