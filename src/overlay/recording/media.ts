import { RECORDING } from "../../shared/recording.ts";
import type { Box } from "../../shared/schema.ts";
import type { RecordedVideo } from "./files.ts";

export type VideoStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "on" }
  | { state: "failed"; reason: string };
export type RecordedGif = {
  data: Blob;
  meta: {
    path: string;
    width: number;
    height: number;
    frames: number;
    durationMs: number;
    truncated: boolean;
  };
};
export type MediaResult = { video: RecordedVideo; gif?: RecordedGif };

const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const MAX_GIF_BYTES = 32 * 1024 * 1024;
const MAX_GIF_FRAMES = 120;
const GIF_DELAY = 170;

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function videoUnavailable(): string | undefined {
  if (!window.isSecureContext) return "Tab capture needs https or localhost";
  if (!("mediaDevices" in navigator) || !("getDisplayMedia" in navigator.mediaDevices))
    return "This browser cannot capture the tab";
  if (globalThis.RestrictionTarget === undefined)
    return "This browser lacks Element Capture, which excludes the overlay";
  if (!("MediaRecorder" in globalThis) || !MediaRecorder.isTypeSupported("video/webm"))
    return "This browser cannot record WebM";
  return undefined;
}

type Running = {
  source: MediaStream;
  output: MediaStream;
  player: HTMLVideoElement;
  recorder: MediaRecorder | null;
  stopped: Promise<void>;
  chunks: Blob[];
  bytes: number;
  frame: number;
  mimeType: string;
  startedAt: string;
  truncated: boolean;
  failed: string | null;
  gif: {
    encoder: ReturnType<typeof import("gifenc").GIFEncoder>;
    frames: number;
    durationMs: number;
    width: number;
    height: number;
    truncated: boolean;
  } | null;
  restoreBody(): void;
};

function drawRegion(
  player: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  region: Box,
): void {
  const body = document.body.getBoundingClientRect();
  const x = Math.max(0, body.left);
  const y = Math.max(0, body.top);
  const w = Math.min(window.innerWidth, body.right) - x;
  const h = Math.min(window.innerHeight, body.bottom) - y;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const left = Math.max(x, region.x);
  const top = Math.max(y, region.y);
  const right = Math.min(x + w, region.x + region.w);
  const bottom = Math.min(y + h, region.y + region.h);
  if (right <= left || bottom <= top || w <= 0 || h <= 0) return;
  context.drawImage(
    player,
    ((left - x) * player.videoWidth) / w,
    ((top - y) * player.videoHeight) / h,
    ((right - left) * player.videoWidth) / w,
    ((bottom - top) * player.videoHeight) / h,
    ((left - region.x) * canvas.width) / region.w,
    ((top - region.y) * canvas.height) / region.h,
    ((right - left) * canvas.width) / region.w,
    ((bottom - top) * canvas.height) / region.h,
  );
}

function captureCanvas(width: number, height: number, readFrequently: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d", { willReadFrequently: readFrequently });
  if (context === null) throw new Error("No canvas context for recording");
  return { canvas, context };
}

export function startMedia(
  withVideo: boolean,
  withGif: boolean,
  region: Box | null,
  onStatus: (value: VideoStatus) => void,
) {
  let running: Running | null = null;
  let cancelled = false;
  let reason = "Tab capture had not started when the recording stopped";
  const fail = (cause: unknown) => {
    reason = describe(cause);
    if (!cancelled) onStatus({ state: "failed", reason });
  };
  const release = (media: Running) => {
    media.player.cancelVideoFrameCallback(media.frame);
    media.player.pause();
    media.player.srcObject = null;
    if (media.recorder !== null && media.recorder.state !== "inactive") media.recorder.stop();
    stopTracks(media.output);
    stopTracks(media.source);
    media.restoreBody();
  };
  const unavailable = videoUnavailable();
  if (unavailable !== undefined) fail(new Error(unavailable));
  else {
    onStatus({ state: "starting" });
    const requested = navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: false,
      preferCurrentTab: true,
    });
    void requested.then(async (source) => {
      if (cancelled) {
        stopTracks(source);
        return;
      }
      const restoreBody = prepareBody();
      const player = document.createElement("video");
      let output: MediaStream | undefined;
      try {
        const [track] = source.getVideoTracks();
        if (track?.restrictTo === undefined)
          throw new Error("Share this tab; Element Capture is unavailable on the selected surface");
        const target = await globalThis.RestrictionTarget?.fromElement(document.body);
        if (target === undefined) throw new Error("Element Capture target is unavailable");
        await track.restrictTo(target);
        const codec = withGif ? await import("gifenc") : null;
        player.muted = true;
        player.playsInline = true;
        player.srcObject = source;
        await player.play();
        if (cancelled) {
          player.pause();
          player.srcObject = null;
          stopTracks(source);
          restoreBody();
          return;
        }
        const area = region ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
        const scale = Math.min(1, 1920 / Math.max(area.w, area.h));
        const { canvas, context } = captureCanvas(area.w * scale, area.h * scale, false);
        output = canvas.captureStream(0);
        const [outputTrack] = output.getVideoTracks();
        if (!(outputTrack instanceof CanvasCaptureMediaStreamTrack))
          throw new Error("Canvas capture has no video track");
        const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm";
        const recorder = withVideo ? new MediaRecorder(output, { mimeType }) : null;
        const gifScale = Math.min(1, 480 / Math.max(area.w, area.h));
        const { canvas: small, context: smallContext } = captureCanvas(
          area.w * gifScale,
          area.h * gifScale,
          true,
        );
        const media: Running = {
          source,
          output,
          player,
          recorder,
          stopped:
            recorder === null
              ? Promise.resolve()
              : new Promise((resolve) =>
                  recorder.addEventListener("stop", () => resolve(), { once: true }),
                ),
          chunks: [],
          bytes: 0,
          frame: 0,
          mimeType,
          startedAt: new Date().toISOString(),
          truncated: false,
          failed: null,
          gif:
            codec === null
              ? null
              : {
                  encoder: codec.GIFEncoder(),
                  frames: 0,
                  durationMs: 0,
                  width: small.width,
                  height: small.height,
                  truncated: false,
                },
          restoreBody,
        };
        recorder?.addEventListener("dataavailable", (event) => {
          if (media.bytes + event.data.size > MAX_VIDEO_BYTES) {
            media.truncated = true;
            if (recorder.state !== "inactive") recorder.stop();
          } else {
            media.chunks.push(event.data);
            media.bytes += event.data.size;
          }
        });
        recorder?.addEventListener("error", () => {
          media.failed = "Browser video encoding failed";
          fail(new Error(media.failed));
        });
        track.addEventListener(
          "ended",
          () => {
            media.truncated = true;
            if (media.gif !== null) media.gif.truncated = true;
            release(media);
            fail(new Error("Tab sharing was stopped"));
          },
          { once: true },
        );
        let lastGif = -Infinity;
        const draw = (now: number) => {
          try {
            drawRegion(player, canvas, context, area);
            outputTrack.requestFrame();
            const gif = media.gif;
            if (codec !== null && gif !== null && now - lastGif >= GIF_DELAY) {
              if (
                gif.frames >= MAX_GIF_FRAMES ||
                gif.encoder.bytesView().byteLength + small.width * small.height * 2 + 2048 >=
                  MAX_GIF_BYTES
              )
                gif.truncated = true;
              else {
                smallContext.drawImage(canvas, 0, 0, small.width, small.height);
                const pixels = smallContext.getImageData(0, 0, small.width, small.height).data;
                const palette = codec.quantize(pixels, 256);
                const delay = Number.isFinite(lastGif)
                  ? Math.round((now - lastGif) / 10) * 10
                  : GIF_DELAY;
                gif.encoder.writeFrame(
                  codec.applyPalette(pixels, palette),
                  small.width,
                  small.height,
                  { palette, delay, repeat: 0 },
                );
                gif.frames += 1;
                gif.durationMs += delay;
                lastGif = now;
              }
            }
            media.frame = player.requestVideoFrameCallback(draw);
          } catch (cause) {
            media.failed = describe(cause);
            release(media);
            fail(cause);
          }
        };
        running = media;
        recorder?.start(1000);
        draw(performance.now());
        onStatus({ state: "on" });
      } catch (cause) {
        if (output !== undefined) stopTracks(output);
        player.pause();
        player.srcObject = null;
        stopTracks(source);
        restoreBody();
        fail(cause);
      }
    }, fail);
  }
  return {
    async stop(): Promise<MediaResult> {
      cancelled = true;
      const media = running;
      if (media === null) return { video: { data: undefined, meta: { path: null, reason } } };
      media.player.cancelVideoFrameCallback(media.frame);
      if (media.recorder !== null && media.recorder.state !== "inactive") media.recorder.stop();
      await media.stopped;
      release(media);
      const video: RecordedVideo =
        media.recorder === null || media.failed !== null || media.bytes === 0
          ? { data: undefined, meta: { path: null, reason: media.failed ?? "Video not chosen" } }
          : {
              data: new Blob(media.chunks, { type: "video/webm" }),
              meta: {
                path: RECORDING.video,
                mimeType: media.mimeType,
                bytes: media.bytes,
                startedAt: media.startedAt,
                endedAt: new Date().toISOString(),
                restrictedTo: "body",
                truncated: media.truncated,
              },
            };
      if (media.gif === null || media.gif.frames === 0) return { video };
      media.gif.encoder.finish();
      const { width, height, frames, truncated, durationMs } = media.gif;
      return {
        video,
        gif: {
          data: new Blob([media.gif.encoder.bytes()], { type: "image/gif" }),
          meta: {
            path: RECORDING.gif,
            width,
            height,
            frames,
            durationMs,
            truncated,
          },
        },
      };
    },
    dispose() {
      cancelled = true;
      if (running !== null) release(running);
    },
  };
}

declare global {
  // Element Capture (Chrome 132+) and Chrome's self-capture options, not yet in TypeScript's DOM lib.
  interface RestrictionTarget {
    readonly __brand: "RestrictionTarget";
  }
  var RestrictionTarget: { fromElement(element: Element): Promise<RestrictionTarget> } | undefined;
  interface MediaStreamTrack {
    restrictTo?(target: RestrictionTarget | null): Promise<void>;
  }
  interface DisplayMediaStreamOptions {
    preferCurrentTab?: boolean;
  }
}

function transparent(color: string): boolean {
  return color === "transparent" || color === "rgba(0, 0, 0, 0)";
}

// Element Capture yields no frames unless body forms a stacking context, and it shows a
// transparent body as black. With a transparent root, body's own background moves to the
// canvas and body itself stays transparent. Giving each element the color already visible
// behind it keeps the background on body and changes nothing on screen.
function prepareBody(): () => void {
  const restores: (() => void)[] = [];
  const set = (element: HTMLElement, name: string, value: string): void => {
    const previous = element.style.getPropertyValue(name);
    const priority = element.style.getPropertyPriority(name);
    element.style.setProperty(name, value);
    restores.push(() => {
      if (previous === "") element.style.removeProperty(name);
      else element.style.setProperty(name, previous, priority);
    });
  };
  const { documentElement: html, body } = document;
  set(body, "isolation", "isolate");
  const htmlStyle = getComputedStyle(html);
  const bodyStyle = getComputedStyle(body);
  const bodyPlain = bodyStyle.backgroundImage === "none" && transparent(bodyStyle.backgroundColor);
  let behindBody = htmlStyle.backgroundColor;
  if (htmlStyle.backgroundImage === "none" && transparent(htmlStyle.backgroundColor)) {
    behindBody = bodyPlain ? "Canvas" : bodyStyle.backgroundColor;
    set(html, "background-color", behindBody);
  }
  if (bodyPlain && htmlStyle.backgroundImage === "none") {
    set(body, "background-color", behindBody);
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const restore of restores.reverse()) restore();
  };
}
