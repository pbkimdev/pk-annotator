import { MAX_BODY_TOTAL_BYTES, redactUrl, utf8Length } from "../../core/network.ts";
import { framePath } from "../../shared/recording.ts";
import type { Box, Viewport } from "../../shared/schema.ts";
import type { RequestEntry, TimelineEntry } from "../../shared/timeline.ts";
import { getCapture } from "../capture.ts";
import { HOST_TAG } from "../launcher.ts";
import { addAttachment } from "../registry.ts";
import { captureCanvas, currentViewport, pageScale } from "../send.ts";
import { createStore } from "../store.ts";
import { buildRecording, type RecordedFrame } from "./files.ts";

/** The composer attachment id; a new recording replaces the previous chip. */
export { videoUnavailable } from "./media.ts";
import { startMedia, type VideoStatus } from "./media.ts";

export const RECORDING_ATTACHMENT = "recording";
const MAX_ENTRIES = 5000;
const MAX_FRAMES = 200;
export const MAX_VIDEO_MS = 5 * 60 * 1000;
const FIELDS =
  'input:not([type="hidden"],[type="checkbox"],[type="radio"],[type="button"],[type="submit"],[type="reset"],[type="image"],[type="range"],[type="color"],[type="file"]),textarea,select,[contenteditable]:not([contenteditable="false"])';
const MASK = "•••••";

export type RecorderState = {
  phase: "idle" | "recording" | "stopping";
  /** Date.now() when the running recording started. */
  startedAt: number;
  withVideo: boolean;
  withGif: boolean;
  video: VideoStatus;
  /** The attachment summary of the last finished recording. */
  last: string | null;
  error: string | null;
};

export type Counts = {
  steps: number;
  errors: number;
  requests: number;
  frames: number;
  dropped: number;
};

type Bodies = Pick<RequestEntry, "requestBody" | "responseBody">;

type Session = {
  startedAt: Date;
  url: string;
  viewport: Viewport;
  entries: TimelineEntry[];
  dropped: number;
  /** Requests seen by the tap, and whether they were kept or dropped over the entry cap. */
  requests: WeakMap<RequestEntry, boolean>;
  /** Bodies copied when each kept request settled, by seq; null when over the body budget. */
  bodies: Map<number, Bodies | null>;
  bodyBytes: number;
  bodiesDropped: number;
  counts: Counts;
  errorFingerprints: Set<string>;
  frames: RecordedFrame[];
  framesDropped: number;
  framesFailed: number;
  /** The newest entry waiting for a keyframe; entries before it share that keyframe. */
  pendingFrame: TimelineEntry | undefined;
  framing: Promise<void> | undefined;
  untap: () => void;
  media: ReturnType<typeof startMedia> | null;
  limit: number | undefined;
  region: Box | null;
};

function describe(cause: unknown): string {
  if (cause instanceof DOMException) return `${cause.name}: ${cause.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function toWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("Canvas could not encode webp")) : resolve(blob)),
      "image/webp",
      0.8,
    );
  });
}

// Replaces every field value in snapdom's detached clone, so the mask follows the layout
// snapdom renders rather than the live layout.
function maskFields(clone: Element): void {
  for (const field of clone.querySelectorAll(FIELDS)) {
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      field.value = MASK;
      field.setAttribute("value", MASK);
      if (field instanceof HTMLTextAreaElement) field.textContent = MASK;
    } else if (field instanceof HTMLSelectElement) {
      for (const option of field.options) option.textContent = MASK;
    } else {
      const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
      while (walker.nextNode() !== null) {
        walker.currentNode.nodeValue = (walker.currentNode.nodeValue ?? "").replace(/\S/g, "•");
      }
    }
  }
}

/** The viewport without the overlay and with every field value masked. */
async function keyframe(region: Box | null): Promise<Blob> {
  const { snapdom } = await import("@zumer/snapdom");
  const result = await snapdom(document.documentElement, {
    clip: "viewport",
    exclude: [HOST_TAG],
    excludeMode: "remove",
    dpr: 1,
    plugins: [
      {
        name: "pka-mask-fields",
        afterClone(context) {
          if (context.clone === null || context.clone === undefined) {
            throw new Error("snapdom produced no clone to mask");
          }
          maskFields(context.clone);
        },
      },
    ],
  });
  const page = await captureCanvas(result);
  if (region === null) return toWebp(page);
  const canvas = document.createElement("canvas");
  const scale = pageScale(page);
  canvas.width = Math.max(1, Math.round(region.w * scale));
  canvas.height = Math.max(1, Math.round(region.h * scale));
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("No canvas context for keyframe crop");
  context.drawImage(
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
  return toWebp(canvas);
}

// Request entries are live until stop; the copy freezes them, with the bodies kept at settle.
// A request that began before the recording arrives when it settles, after later entries,
// so the copy is sorted back into seq order.
function frozenEntries(current: Session): TimelineEntry[] {
  return structuredClone(current.entries)
    .toSorted((left, right) => left.seq - right.seq)
    .map((entry) => {
      if (entry.kind !== "request" || !current.bodies.has(entry.seq)) return entry;
      const { requestBody: _request, responseBody: _response, ...rest } = entry;
      return { ...rest, ...current.bodies.get(entry.seq) };
    });
}

export function createRecorder() {
  const state = createStore<RecorderState>({
    phase: "idle",
    startedAt: 0,
    withVideo: false,
    withGif: false,
    video: { state: "off" },
    last: null,
    error: null,
  });
  let session: Session | undefined;
  let generation = 0;

  async function drainFrames(current: Session): Promise<void> {
    while (current.pendingFrame !== undefined) {
      await nextPaint();
      const entry = current.pendingFrame;
      current.pendingFrame = undefined;
      if (entry === undefined) continue;
      try {
        const data = await keyframe(current.region);
        const path = framePath(current.frames.length + 1);
        current.frames.push({ path, seq: entry.seq, at: entry.at, data });
        current.counts.frames = current.frames.length;
      } catch (cause) {
        current.framesFailed += 1;
        state.set({ error: `A keyframe failed: ${describe(cause)}` });
      }
    }
  }

  function requestFrame(current: Session, entry: TimelineEntry): void {
    if (current.pendingFrame !== undefined) {
      current.pendingFrame = entry;
      return;
    }
    const taken = current.frames.length + current.framesFailed + (current.framing ? 1 : 0);
    if (taken >= MAX_FRAMES) {
      current.framesDropped += 1;
      return;
    }
    current.pendingFrame = entry;
    current.framing ??= drainFrames(current).finally(() => {
      current.framing = undefined;
    });
  }

  // The capture may later drop a settled request's bodies to keep its own cap, so the
  // recording copies them now, within a budget of its own.
  function keepBodies(current: Session, entry: RequestEntry): void {
    const bytes = utf8Length(entry.requestBody ?? "") + utf8Length(entry.responseBody ?? "");
    if (bytes === 0) return;
    if (current.bodyBytes + bytes > MAX_BODY_TOTAL_BYTES) {
      current.bodies.set(entry.seq, null);
      current.bodiesDropped += 1;
      return;
    }
    current.bodyBytes += bytes;
    const bodies: Bodies = {};
    if (entry.requestBody !== undefined) bodies.requestBody = entry.requestBody;
    if (entry.responseBody !== undefined) bodies.responseBody = entry.responseBody;
    current.bodies.set(entry.seq, bodies);
  }

  function onEntry(current: Session, entry: TimelineEntry): void {
    // snapdom warns once per page during the first keyframe; that is the overlay, not the page.
    if (entry.kind === "console" && String(entry.args[0]).startsWith("[snapdom]")) return;
    if (entry.kind === "request") {
      const kept = current.requests.get(entry);
      if (kept !== undefined) {
        if (kept) keepBodies(current, entry);
        return;
      }
      const keep = current.entries.length < MAX_ENTRIES;
      current.requests.set(entry, keep);
      // First seen as it settles: it began before the recording started.
      if (keep && entry.state !== "pending" && entry.state !== "open") keepBodies(current, entry);
    }
    if (current.entries.length >= MAX_ENTRIES) {
      current.dropped += 1;
      current.counts.dropped = current.dropped;
      return;
    }
    current.entries.push(entry);
    const { counts } = current;
    if (entry.kind === "action" || entry.kind === "navigation") {
      counts.steps += 1;
      requestFrame(current, entry);
    } else if (entry.kind === "error") {
      counts.errors += 1;
      // One keyframe per error group, so an error loop cannot keep snapdom busy.
      if (!current.errorFingerprints.has(entry.fingerprint)) {
        current.errorFingerprints.add(entry.fingerprint);
        requestFrame(current, entry);
      }
    } else if (entry.kind === "request") {
      counts.requests += 1;
    }
  }

  function start(region: Box | null = null): void {
    if (state.get().phase !== "idle") throw new Error("A recording is already running or stopping");
    generation += 1;
    const capture = getCapture();
    const current: Session = {
      startedAt: new Date(),
      url: redactUrl(location.href),
      viewport: currentViewport(),
      entries: [],
      dropped: 0,
      requests: new WeakMap(),
      bodies: new Map(),
      bodyBytes: 0,
      bodiesDropped: 0,
      counts: { steps: 0, errors: 0, requests: 0, frames: 0, dropped: 0 },
      errorFingerprints: new Set(),
      frames: [],
      framesDropped: 0,
      framesFailed: 0,
      pendingFrame: undefined,
      framing: undefined,
      untap: () => {},
      media: null,
      limit: undefined,
      region,
    };
    session = current;
    current.untap = capture.tap((entry) => onEntry(current, entry));
    state.set({
      phase: "recording",
      startedAt: current.startedAt.getTime(),
      video: { state: "off" },
      error: null,
    });
    const { withVideo, withGif } = state.get();
    if (withVideo || withGif)
      current.media = startMedia(withVideo, withGif, region, (video) => {
        if (session === current) state.set({ video });
      });
    if (withVideo)
      current.limit = window.setTimeout(() => {
        if (session === current) void stop();
      }, MAX_VIDEO_MS);
  }

  async function stop(): Promise<void> {
    const current = session;
    if (current === undefined) return;
    const stoppedGeneration = generation;
    session = undefined;
    window.clearTimeout(current.limit);
    current.untap();
    state.set({ phase: "stopping" });
    try {
      const media =
        current.media === null
          ? { video: { data: undefined, meta: { path: null, reason: "Not chosen" } } }
          : await current.media.stop();
      await current.framing;
      if (generation !== stoppedGeneration) return;
      const capture = getCapture();
      // snapshot() also settles resource timings on the live request entries.
      const { groups } = capture.snapshot();
      const endedAt = new Date();
      const built = buildRecording({
        url: current.url,
        endUrl: redactUrl(location.href),
        viewport: current.viewport,
        startedAt: current.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        entries: frozenEntries(current),
        entryLimit: MAX_ENTRIES,
        entriesDropped: current.dropped,
        frames: current.frames,
        frameLimit: MAX_FRAMES,
        framesDropped: current.framesDropped,
        framesFailed: current.framesFailed,
        bodyLimit: MAX_BODY_TOTAL_BYTES,
        bodiesDropped: current.bodiesDropped,
        ...media,
        region: current.region,
        groups,
        bodies: globalThis.__PKA_BODIES__ ?? [],
      });
      const elapsed = Math.round((endedAt.getTime() - current.startedAt.getTime()) / 1000);
      addAttachment({
        id: RECORDING_ATTACHMENT,
        kind: "recording",
        label: `Recording ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`,
        collect: async () => built,
      });
      state.set({ phase: "idle", last: built.summary });
    } catch (cause) {
      state.set({ phase: "idle", error: `The recording could not be saved: ${describe(cause)}` });
    }
  }

  return {
    state,
    start,
    stop,
    setWithVideo(withVideo: boolean) {
      state.set({ withVideo });
    },
    setWithGif(withGif: boolean) {
      state.set({ withGif });
    },
    /** Counts of the running recording, read by the panel on its clock tick. */
    counts(): Counts | undefined {
      return session === undefined ? undefined : { ...session.counts };
    },
    dispose() {
      generation += 1;
      state.set({ phase: "idle" });
      const current = session;
      session = undefined;
      if (current === undefined) return;
      window.clearTimeout(current.limit);
      current.untap();
      current.pendingFrame = undefined;
      current.media?.dispose();
    },
  };
}

export type Recorder = ReturnType<typeof createRecorder>;
