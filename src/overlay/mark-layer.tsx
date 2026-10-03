import { useText } from "./language.ts";
import { snapdom } from "@zumer/snapdom";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import type { Point } from "../select/marquee.ts";
import type { Box } from "../shared/schema.ts";
import { NOTE, useOverlay, type UiState } from "./context.tsx";
import { HOST_TAG } from "./launcher.ts";
import { addAttachment, attachments, type ComposerAttachment } from "./registry.ts";
import { captureCanvas, pageScale } from "./send.ts";
import { useStore } from "./store.ts";
import { Button } from "./ui/button.tsx";

type Gesture = NonNullable<UiState["gesture"]>;
type Stroke = {
  kind: "rectangle" | "ellipse" | "freehand";
  points: readonly Point[];
  color: string;
};

function bounds(points: readonly Point[]): Box {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

async function screenshot(region: Box | null, stroke?: Stroke): Promise<ComposerAttachment> {
  if (attachments.get().length >= 50)
    throw new Error("Save or send this mark before adding more captures.");
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const result = await snapdom(document.documentElement, {
    clip: "viewport",
    exclude: [HOST_TAG],
    excludeMode: "remove",
    reconcile: true,
  });
  const page = await captureCanvas(result);
  const scale = pageScale(page);
  const context = page.getContext("2d");
  if (context === null) throw new Error("No canvas context for screenshot");
  if (stroke !== undefined) {
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
      context.ellipse(
        box.x + box.w / 2,
        box.y + box.h / 2,
        box.w / 2,
        box.h / 2,
        0,
        0,
        Math.PI * 2,
      );
    else {
      for (const [index, point] of stroke.points.entries()) {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      }
    }
    context.stroke();
    context.restore();
  }
  let canvas = page;
  if (region !== null) {
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
  const data = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("Screenshot encoding failed")) : resolve(blob)),
      "image/webp",
      0.9,
    ),
  );
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const path = `capture/images/${id}.webp`;
  const label =
    stroke === undefined
      ? region === null
        ? "Screenshot"
        : "Cropped screenshot"
      : `${stroke.kind} annotation`;
  const metadata = new Blob([JSON.stringify({ viewport, region, stroke }, null, 2)], {
    type: "application/json",
  });
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

export function ScreenshotPanel() {
  const t = useText();
  const { ui } = useOverlay();
  const capture = useRef<Promise<ComposerAttachment> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    ui.set({ busy: true });
    capture.current ??= screenshot(null);
    void capture.current.then(
      (attachment) => {
        if (!active) return;
        addAttachment(attachment);
        ui.set({ busy: false, panel: NOTE });
      },
      (cause: Error) => {
        if (!active) return;
        setError(cause.message);
        ui.set({ busy: false });
      },
    );
    return () => {
      active = false;
    };
  }, [ui]);
  return error === null ? (
    <p className="p-3 text-sm" role="status">
      {t("Capturing screenshot…")}
    </p>
  ) : (
    <p className="p-3 text-sm text-destructive" role="alert">
      {error}
    </p>
  );
}

export function MarkLayer() {
  const t = useText();
  const { ui, host } = useOverlay();
  const gesture = useStore(ui, (state) => state.gesture);
  const visible = useStore(ui, (state) => state.visible);
  const busy = useStore(ui, (state) => state.busy);
  const [points, setPoints] = useState<readonly Point[]>([]);
  const [error, setError] = useState<string | null>(null);
  const start = useRef<{ mode: Gesture; points: Point[] } | null>(null);
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (gesture === null) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || ui.get().busy) return;
      event.preventDefault();
      start.current = null;
      setPoints([]);
      ui.set({ gesture: null });
    };
    window.addEventListener("keydown", key, { capture: true });
    return () => window.removeEventListener("keydown", key, { capture: true });
  }, [gesture, ui]);

  if (!visible || gesture === null) return null;
  const box = points.length > 0 ? bounds(points) : null;
  const point = (event: PointerEvent<HTMLDivElement>): Point => ({
    x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
    y: Math.max(0, Math.min(window.innerHeight, event.clientY)),
  });
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || ui.get().busy) return;
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
  const finish = async (event: PointerEvent<HTMLDivElement>) => {
    const current = start.current;
    if (current === null) return;
    start.current = null;
    current.points.push(point(event));
    const area = bounds(current.points);
    setPoints([]);
    if (current.mode === "freehand" ? Math.max(area.w, area.h) < 3 : area.w < 3 || area.h < 3) {
      setError("Drag an area at least 3 pixels wide and tall.");
      return;
    }
    if (current.mode === "record-area") {
      ui.set({ recordRegion: area, gesture: null, panel: "record" });
      return;
    }
    ui.set({ busy: true });
    try {
      const stroke =
        current.mode === "screenshot"
          ? undefined
          : {
              kind: current.mode,
              points: current.points,
              color: getComputedStyle(host).getPropertyValue("--pka-pick").trim(),
            };
      const attachment = await screenshot(current.mode === "screenshot" ? area : null, stroke);
      addAttachment(attachment);
      ui.set({ gesture: null, panel: NOTE });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      ui.set({ busy: false });
    }
  };
  return (
    <>
      <div
        ref={layer}
        data-testid="pka-mark-layer"
        className="fixed inset-0 touch-none cursor-crosshair"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={(event) => void finish(event)}
        onPointerCancel={() => {
          start.current = null;
          setPoints([]);
        }}
      />
      <svg className="pointer-events-none fixed inset-0 size-full overflow-visible text-pick">
        {box !== null &&
          (gesture === "freehand" ? (
            <polyline
              points={points.map((item) => `${item.x},${item.y}`).join(" ")}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          ) : gesture === "ellipse" ? (
            <ellipse
              cx={box.x + box.w / 2}
              cy={box.y + box.h / 2}
              rx={box.w / 2}
              ry={box.h / 2}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
            />
          ) : (
            <rect
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              fill="currentColor"
              fillOpacity="0.08"
              stroke="currentColor"
              strokeWidth="2"
            />
          ))}
      </svg>
      <div className="fixed top-4 left-1/2 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg bg-popover px-3 py-2 text-xs shadow-lg ring-1 ring-border">
        <span role={error === null ? "status" : "alert"}>
          {error ??
            (busy
              ? "Capturing…"
              : gesture === "freehand"
                ? "Draw on the page"
                : "Drag on the page")}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            start.current = null;
            setPoints([]);
            ui.set({ gesture: null });
          }}
        >
          {t("Cancel")}
        </Button>
      </div>
    </>
  );
}
