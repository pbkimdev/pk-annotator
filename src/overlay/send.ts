import type { CaptureResult } from "@zumer/snapdom";
import type { ViteHotContext } from "vite/types/hot.d.ts";
import { z } from "zod";

import { describe, preferredLocator, type Description } from "../select/describe.ts";
import { findQuote } from "../select/quote.ts";
import { locate } from "../select/source.ts";
import {
  CHANNEL,
  CreateFailedMessage,
  CreatedMessage,
  CreateMessage,
  FileChunkMessage,
  FileWrittenMessage,
  MAX_CHUNK_BYTES,
  UploadReadyMessage,
} from "../shared/channel.ts";
import { RECORDING, RecordingManifestDraft } from "../shared/recording.ts";
import type { Attachment, Box, MarkPage, Quote, Viewport } from "../shared/schema.ts";
import { listen, send } from "./channel-client.ts";
import { HOST_TAG } from "./launcher.ts";
import type { LocatedElement } from "./markdown.ts";
import { SUMMARY_PATH, type AttachmentFile, type ComposerAttachment } from "./registry.ts";

export const MAX_ELEMENTS = 100;
const REPLY_TIMEOUT_MS = 30_000;
const CROP_PADDING = 8;

export type SendPhase =
  | { phase: "locating" }
  | { phase: "capturing" }
  | { phase: "uploading"; sent: number; total: number }
  | { phase: "waiting" };

export function currentViewport(): Viewport {
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

/**
 * What a pick recorded: the page it was made on, and its description, because host UI can
 * remove a picked element before Send (a dialog that closes when the composer takes focus).
 * A saved mark keeps its own copies, because a shared layout's element can be picked again
 * on another route.
 */
export type Picked = { url: string; route: string; description: Description; quote?: Quote };
// The picks of the current selection.
const picked = new WeakMap<Element, Picked>();

export function remember(elements: readonly Element[]): void {
  for (const element of elements)
    picked.set(element, {
      url: location.href,
      route: location.pathname,
      description: describe(element),
    });
}

/** A text selection's pick: its element, described with the selection's box. */
export function rememberQuote(element: Element, quote: Quote, range: Range): void {
  const description = describe(element);
  picked.set(element, {
    url: location.href,
    route: location.pathname,
    description: { ...description, box: boxOf(range) },
    quote,
  });
}

function boxOf(range: Range): Box {
  const rect = range.getBoundingClientRect();
  const round = (value: number) => Math.round(value * 10) / 10;
  return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) };
}

/** Makes a saved mark's picks the current selection's again, for editing it. */
export function restore(elements: readonly Element[], picks: readonly Picked[]): void {
  for (const [index, element] of elements.entries()) {
    const pick = picks[index];
    if (pick === undefined) throw new Error(`Element ${index + 1} of the mark has no pick`);
    picked.set(element, pick);
  }
}

export function pickOf(element: Element): Picked {
  const entry = picked.get(element);
  if (entry === undefined) throw new Error(`<${element.localName}> was selected without a pick`);
  return entry;
}

/**
 * The element to show and capture for a pick: null off the route it was picked on, else the
 * element itself, or, after the route rendered it again, the element its selector now finds.
 */
export function anchor(element: Element, pick: Picked): Element | null {
  if (pick.route !== location.pathname) return null;
  if (element.isConnected) return element;
  return document.querySelector(pick.description.selector.css);
}

/** Describes and locates each element with its pick; `n` follows their order. */
export async function locateElements(
  elements: readonly Element[],
  picks: readonly Picked[],
): Promise<LocatedElement[]> {
  return Promise.all(
    elements.map(async (element, index) => {
      const pick = picks[index];
      if (pick === undefined) throw new Error(`Element ${index + 1} has no pick`);
      const { url, description: remembered } = pick;
      const live = anchor(element, pick);
      let description = live === null ? remembered : describe(live);
      // A quote the page no longer shows keeps the box of its selection.
      if (pick.quote !== undefined && live !== null) {
        const range = findQuote(live, pick.quote);
        description = { ...description, box: range === null ? remembered.box : boxOf(range) };
      }
      const location = await locate(live ?? element);
      const located: LocatedElement = {
        n: index + 1,
        url,
        owners: location.owners,
        selector: description.selector,
        html: description.html,
        box: description.box,
        locator: preferredLocator(description),
      };
      if (location.source !== undefined) located.source = location.source;
      if (location.usedAt !== undefined) located.usedAt = location.usedAt;
      if (description.text !== undefined) located.text = description.text;
      if (pick.quote !== undefined) located.quote = pick.quote;
      return located;
    }),
  );
}

export function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("Canvas could not encode webp")) : resolve(blob)),
      "image/webp",
      0.9,
    );
  });
}

/**
 * Canvas pixels per CSS pixel of a snapdom viewport capture. snapdom clips the viewport to
 * the root's client box, which excludes a classic scrollbar that innerWidth includes.
 */
export function pageScale(page: HTMLCanvasElement): number {
  return page.width / document.documentElement.clientWidth;
}

async function crop(page: HTMLCanvasElement, box: Box): Promise<Blob | undefined> {
  const scale = pageScale(page);
  const left = Math.max(0, box.x - CROP_PADDING);
  const top = Math.max(0, box.y - CROP_PADDING);
  const right = Math.min(document.documentElement.clientWidth, box.x + box.w + CROP_PADDING);
  const bottom = Math.min(document.documentElement.clientHeight, box.y + box.h + CROP_PADDING);
  if (right - left < 1 || bottom - top < 1) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((right - left) * scale);
  canvas.height = Math.round((bottom - top) * scale);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("No 2D canvas context for the element crop");
  context.drawImage(
    page,
    left * scale,
    top * scale,
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return toBlob(canvas);
}

const DecodeFailure = z.object({ name: z.literal("EncodingError") });

/**
 * Rasterizes a snapdom capture. snapdom draws the page as an SVG foreignObject image, and
 * Chromium paints such an image into an exportable canvas only from a data: URL (from a
 * blob: URL it taints the canvas), so a page CSP must allow `img-src data:`.
 */
export async function captureCanvas(result: CaptureResult): Promise<HTMLCanvasElement> {
  try {
    return await result.toCanvas();
  } catch (cause) {
    // snapdom decodes in its own frame, so the DOMException comes from another realm and
    // fails instanceof.
    if (DecodeFailure.safeParse(cause).success) {
      throw new Error(
        "The screenshot did not decode; if the page sets a Content-Security-Policy, its img-src must allow data:",
        { cause },
      );
    }
    throw cause;
  }
}

/** One snapdom capture of the viewport (without the overlay) and a webp crop per element. */
async function capture(elements: LocatedElement[]): Promise<{
  page: Blob;
  crops: Map<number, Blob>;
}> {
  const { snapdom } = await import("@zumer/snapdom");
  const result = await snapdom(document.documentElement, {
    clip: "viewport",
    exclude: [HOST_TAG],
    excludeMode: "remove",
    // Pixel-exact text wrapping; without it inline text can re-wrap in the capture.
    reconcile: true,
  });
  const page = await captureCanvas(result);
  const crops = new Map<number, Blob>();
  for (const element of elements) {
    const blob = await crop(page, element.box);
    if (blob !== undefined) crops.set(element.n, blob);
  }
  return { page: await toBlob(page), crops };
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

export async function collectAttachments(
  items: readonly ComposerAttachment[],
): Promise<{ files: AttachmentFile[]; attachments: Attachment[] }> {
  const files: AttachmentFile[] = [];
  const attachments: Attachment[] = [];
  const overview: string[] = [];
  for (const [index, item] of items.entries()) {
    const collected = await item.collect();
    const prefix = `capture/attachments/${index + 1}/`;
    const relocate = (path: string) => prefix + path;
    const references = new Map(collected.files.map((file) => [file.path, relocate(file.path)]));
    for (const file of collected.files) {
      let data = file.data;
      if (item.kind === "recording" && file.path === RECORDING.manifest) {
        const manifest = RecordingManifestDraft.parse(JSON.parse(await data.text()));
        for (const frame of manifest.frames.items) frame.path = relocate(frame.path);
        if (manifest.video.path !== null) manifest.video.path = relocate(manifest.video.path);
        if (manifest.gif !== undefined) manifest.gif.path = relocate(manifest.gif.path);
        data = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
      } else if (file.path.endsWith(".md")) {
        let text = await data.text();
        text = text.replace(/capture\/[A-Za-z0-9_./-]+/g, (path) => references.get(path) ?? path);
        data = new Blob([text], { type: "text/markdown" });
      }
      files.push({ path: relocate(file.path), data });
    }
    const path = relocate(collected.path);
    const summary = `${item.label}: ${collected.summary}`;
    attachments.push({ kind: item.kind, path, summary });
    overview.push(`- ${summary} (${path})`);
  }
  if (overview.length > 0)
    files.push({
      path: SUMMARY_PATH,
      data: new Blob([overview.join("\n") + "\n"], { type: "text/markdown" }),
    });
  return { files, attachments };
}

/**
 * Sends the next chunk only after the plugin has written the previous one to disk.
 */
export async function sendAnnotation(
  hot: ViteHotContext,
  prompt: string,
  elements: readonly Element[],
  picks: readonly Picked[],
  composerAttachments: readonly ComposerAttachment[],
  marks: readonly MarkPage[],
  onPhase: (phase: SendPhase) => void,
): Promise<{ id: string; dir: string; createdAt: string }> {
  if (elements.length > MAX_ELEMENTS) {
    throw new Error(`Select at most ${MAX_ELEMENTS} elements; ${elements.length} are selected`);
  }
  onPhase({ phase: "locating" });
  const located = await locateElements(elements, picks);
  const viewport = currentViewport();
  onPhase({ phase: "capturing" });
  // Elements off their route or no longer on the page, and quotes the page no longer shows,
  // keep their description but get no crop.
  const live = elements.map((element, index) => {
    const pick = picks[index];
    const target = pick === undefined ? null : anchor(element, pick);
    if (target === null || pick?.quote === undefined) return target;
    return findQuote(target, pick.quote) === null ? null : target;
  });
  const { page, crops } = await capture(located.filter((_ref, index) => live[index] !== null));

  const files: AttachmentFile[] = [{ path: "capture/frames/page.webp", data: page }];
  const attachments: Attachment[] = [
    { kind: "frame", path: "capture/frames/page.webp", summary: "Viewport screenshot when sent" },
  ];
  const refs = located.map(({ locator: _locator, ...ref }) => {
    const blob = crops.get(ref.n);
    if (blob === undefined) return ref;
    const path = `capture/frames/sel-${ref.n}.webp`;
    files.push({ path, data: blob });
    return { ...ref, crop: path };
  });
  const collected = await collectAttachments(composerAttachments);
  files.push(...collected.files);
  attachments.push(...collected.attachments);

  // getRandomValues, unlike randomUUID, also works on plain-http LAN dev origins.
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const create = CreateMessage.parse({
    requestId,
    draft: {
      url: location.href,
      route: location.pathname,
      viewport,
      prompt,
      elements: refs,
      attachments,
      ...(marks.length > 0 && { marks }),
    },
    files: files.map((file) => ({ path: file.path, bytes: file.data.size })),
  });

  let reply: { id: string; dir: string } | { failure: string } | undefined;
  let ready = false;
  let written: { path: string; offset: number } | undefined;
  let wake = () => {};
  async function waitFor(expected: () => boolean): Promise<void> {
    if (expected() || reply !== undefined) return;
    let timer = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        wake = () => {
          if (expected() || reply !== undefined) resolve();
        };
        timer = window.setTimeout(
          () =>
            reject(
              new Error(
                "No upload acknowledgement from the dev server within 30 s. Reload the page and retry.",
              ),
            ),
          REPLY_TIMEOUT_MS,
        );
      });
    } finally {
      window.clearTimeout(timer);
      wake = () => {};
    }
  }
  const stops = [
    listen(hot, CHANNEL.created, CreatedMessage, (message) => {
      if (message.requestId !== requestId) return;
      reply = { id: message.id, dir: message.dir };
      wake();
    }),
    listen(hot, CHANNEL.createFailed, CreateFailedMessage, (message) => {
      if (message.requestId !== requestId) return;
      reply = { failure: message.message };
      wake();
    }),
    listen(hot, CHANNEL.uploadReady, UploadReadyMessage, (message) => {
      if (message.requestId !== requestId) return;
      ready = true;
      wake();
    }),
    listen(hot, CHANNEL.fileWritten, FileWrittenMessage, (message) => {
      if (message.requestId !== requestId) return;
      written = { path: message.path, offset: message.offset };
      wake();
    }),
  ];
  try {
    send(hot, CHANNEL.create, create);
    await waitFor(() => ready);
    const total = files.reduce((sum, file) => sum + file.data.size, 0);
    let sent = 0;
    onPhase({ phase: "uploading", sent, total });
    upload: for (const file of files) {
      for (let offset = 0; offset < file.data.size; offset += MAX_CHUNK_BYTES) {
        // The plugin refused the annotation; the remaining chunks would be dropped.
        if (reply !== undefined) break upload;
        const chunk = file.data.slice(offset, offset + MAX_CHUNK_BYTES);
        const message = FileChunkMessage.parse({
          requestId,
          path: file.path,
          offset,
          data: await base64(chunk),
        });
        send(hot, CHANNEL.file, message);
        await waitFor(() => written?.path === file.path && written.offset === offset + chunk.size);
        sent += chunk.size;
        onPhase({ phase: "uploading", sent, total });
      }
    }

    onPhase({ phase: "waiting" });
    await waitFor(() => reply !== undefined);
  } finally {
    for (const stop of stops) stop();
    if (reply === undefined) send(hot, CHANNEL.cancelUpload, { requestId });
  }
  if (reply === undefined) {
    throw new Error("No reply from the dev server within 30 s. Is annotator() in the Vite config?");
  }
  if ("failure" in reply) throw new Error(reply.failure);
  return { id: reply.id, dir: reply.dir, createdAt: new Date().toISOString() };
}
