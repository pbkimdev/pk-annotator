import { snapdom } from "@zumer/snapdom";

import { MAX_BODY_TOTAL_BYTES, redactUrl, utf8Length } from "../../core/network.ts";
import { RECORDING, framePath } from "../../shared/recording.ts";
import type { Viewport } from "../../shared/schema.ts";
import type { RequestEntry, TimelineEntry } from "../../shared/timeline.ts";
import { getCapture } from "../capture.ts";
import { HOST_TAG } from "../launcher.ts";
import { addAttachment } from "../registry.ts";
import { currentViewport } from "../send.ts";
import { createStore } from "../store.ts";
import { buildRecording, type RecordedFrame, type RecordedVideo } from "./files.ts";

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

/** The composer attachment id; a new recording replaces the previous chip. */
export const RECORDING_ATTACHMENT = "recording";
const MAX_ENTRIES = 5000;
const MAX_FRAMES = 200;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const VIDEO_SLICE_MS = 1000;
const FIELDS =
  'input:not([type="hidden"],[type="checkbox"],[type="radio"],[type="button"],[type="submit"],[type="reset"],[type="image"],[type="range"],[type="color"],[type="file"]),textarea,select,[contenteditable]:not([contenteditable="false"])';
const MASK = "•••••";

export type VideoStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "on" }
  | { state: "failed"; reason: string };

export type RecorderState = {
  phase: "idle" | "recording" | "stopping";
  /** Date.now() when the running recording started. */
  startedAt: number;
  withVideo: boolean;
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

type Video = {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  bytes: number;
  mimeType: string;
  startedAt: string;
  truncated: boolean;
  stopped: Promise<void>;
  restoreBody: () => void;
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
  video: { kind: "none"; reason: string } | { kind: "starting" } | { kind: "on"; video: Video };
};

function describe(cause: unknown): string {
  if (cause instanceof DOMException) return `${cause.name}: ${cause.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Why opt-in video cannot work in this page, or undefined when it can. */
export function videoUnavailable(): string | undefined {
  if (!window.isSecureContext) return "Video needs https or localhost";
  if (!("mediaDevices" in navigator) || !("getDisplayMedia" in navigator.mediaDevices)) {
    return "This browser cannot capture the tab (no getDisplayMedia)";
  }
  if (globalThis.RestrictionTarget === undefined) {
    return "This browser lacks Element Capture, which keeps the overlay out of the video";
  }
  if (!("MediaRecorder" in globalThis) || !MediaRecorder.isTypeSupported("video/webm")) {
    return "This browser cannot record WebM";
  }
  return undefined;
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
async function keyframe(): Promise<Blob> {
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
  return toWebp(await result.toCanvas());
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
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

// Request entries are live until stop; the copy freezes them, with the bodies kept at settle.
function frozenEntries(current: Session): TimelineEntry[] {
  return structuredClone(current.entries).map((entry) => {
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
    video: { state: "off" },
    last: null,
    error: null,
  });
  let session: Session | undefined;

  function setVideo(video: VideoStatus): void {
    state.set({ video });
  }

  async function drainFrames(current: Session): Promise<void> {
    while (current.pendingFrame !== undefined) {
      await nextPaint();
      const entry = current.pendingFrame;
      current.pendingFrame = undefined;
      if (entry === undefined) continue;
      try {
        const data = await keyframe();
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
      current.requests.set(entry, current.entries.length < MAX_ENTRIES);
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

  // Runs inside the Start click: getDisplayMedia needs the user activation.
  async function startVideo(current: Session): Promise<void> {
    const unavailable = videoUnavailable();
    if (unavailable !== undefined) {
      current.video = { kind: "none", reason: unavailable };
      setVideo({ state: "failed", reason: unavailable });
      return;
    }
    current.video = { kind: "starting" };
    setVideo({ state: "starting" });
    const fail = (reason: string): void => {
      current.video = { kind: "none", reason };
      if (session === current) setVideo({ state: "failed", reason });
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: false,
        preferCurrentTab: true,
      });
    } catch (cause) {
      fail(`Tab capture was refused (${describe(cause)})`);
      return;
    }
    if (session !== current) {
      stopTracks(stream);
      fail("The recording stopped before tab capture started");
      return;
    }
    const [track] = stream.getVideoTracks();
    const restoreBody = prepareBody();
    try {
      if (track === undefined) throw new Error("the capture has no video track");
      if (track.getSettings().displaySurface !== "browser" || track.restrictTo === undefined) {
        throw new Error("share this tab; Element Capture cannot restrict a window or screen");
      }
      const target = await globalThis.RestrictionTarget?.fromElement(document.body);
      if (target === undefined) throw new Error("RestrictionTarget disappeared");
      await track.restrictTo(target);
    } catch (cause) {
      restoreBody();
      stopTracks(stream);
      fail(`Element Capture failed: ${describe(cause)}`);
      return;
    }
    if (session !== current) {
      restoreBody();
      stopTracks(stream);
      fail("The recording stopped before tab capture started");
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const video: Video = {
      stream,
      recorder,
      chunks: [],
      bytes: 0,
      mimeType,
      startedAt: new Date().toISOString(),
      truncated: false,
      stopped: new Promise((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
      }),
      restoreBody,
    };
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) return;
      video.chunks.push(event.data);
      video.bytes += event.data.size;
      if (video.bytes >= MAX_VIDEO_BYTES && recorder.state === "recording") {
        video.truncated = true;
        recorder.stop();
      }
    });
    track.addEventListener("ended", () => {
      if (recorder.state !== "inactive") recorder.stop();
      if (session === current) setVideo({ state: "failed", reason: "Tab sharing was stopped" });
    });
    current.video = { kind: "on", video };
    recorder.start(VIDEO_SLICE_MS);
    setVideo({ state: "on" });
  }

  async function finishVideo(current: Session): Promise<RecordedVideo> {
    if (current.video.kind === "none") {
      return { data: undefined, meta: { path: null, reason: current.video.reason } };
    }
    if (current.video.kind === "starting") {
      return {
        data: undefined,
        meta: { path: null, reason: "The recording stopped before tab capture started" },
      };
    }
    const { video } = current.video;
    if (video.recorder.state !== "inactive") video.recorder.stop();
    await video.stopped;
    stopTracks(video.stream);
    video.restoreBody();
    return {
      data: new Blob(video.chunks, { type: "video/webm" }),
      meta: {
        path: RECORDING.video,
        mimeType: video.mimeType,
        bytes: video.bytes,
        startedAt: video.startedAt,
        endedAt: new Date().toISOString(),
        restrictedTo: "body",
        truncated: video.truncated,
      },
    };
  }

  function start(): void {
    if (session !== undefined) throw new Error("A recording is already running");
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
      video: { kind: "none", reason: "Not chosen" },
    };
    session = current;
    current.untap = capture.tap((entry) => onEntry(current, entry));
    state.set({
      phase: "recording",
      startedAt: current.startedAt.getTime(),
      video: { state: "off" },
      error: null,
    });
    if (state.get().withVideo) void startVideo(current);
  }

  async function stop(): Promise<void> {
    const current = session;
    if (current === undefined) return;
    session = undefined;
    current.untap();
    state.set({ phase: "stopping" });
    try {
      const video = await finishVideo(current);
      await current.framing;
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
        video,
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
    /** Counts of the running recording, read by the panel on its clock tick. */
    counts(): Counts | undefined {
      return session === undefined ? undefined : { ...session.counts };
    },
    dispose() {
      const current = session;
      session = undefined;
      if (current === undefined) return;
      current.untap();
      if (current.video.kind === "on") {
        const { video } = current.video;
        if (video.recorder.state !== "inactive") video.recorder.stop();
        stopTracks(video.stream);
        video.restoreBody();
      }
    },
  };
}

export type Recorder = ReturnType<typeof createRecorder>;
