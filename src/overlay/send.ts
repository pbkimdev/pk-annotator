import { snapdom, type CaptureResult } from "@zumer/snapdom";
import type { ViteHotContext } from "vite/types/hot.d.ts";
import { z } from "zod";

import { describe, preferredLocator, type Description } from "../select/describe.ts";
import { locate } from "../select/source.ts";
import {
  CHANNEL,
  CreateFailedMessage,
  CreatedMessage,
  CreateMessage,
  FileChunkMessage,
  MAX_CHUNK_BYTES,
} from "../shared/channel.ts";
import { RECORDING, RecordingManifestDraft } from "../shared/recording.ts";
import type { Attachment, Box, Viewport } from "../shared/schema.ts";
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

// Host UI can remove a picked element before Send (a dialog that closes when the composer
// takes focus), so each element is also described when it is picked.
const pickedDescriptions = new WeakMap<Element, Description>();

export function remember(elements: readonly Element[]): void {
  for (const element of elements) pickedDescriptions.set(element, describe(element));
}

function currentDescription(element: Element, n: number): Description {
  if (element.isConnected) return describe(element);
  const remembered = pickedDescriptions.get(element);
  if (remembered === undefined)
    throw new Error(`Element ${n} left the page before it was described`);
  return remembered;
}

/** Describes and locates each selected element; `n` follows selection order. */
export async function locateElements(elements: readonly Element[]): Promise<LocatedElement[]> {
  return Promise.all(
    elements.map(async (element, index) => {
      const description = currentDescription(element, index + 1);
      const location = await locate(element);
      const located: LocatedElement = {
        n: index + 1,
        owners: location.owners,
        selector: description.selector,
        html: description.html,
        box: description.box,
        locator: preferredLocator(description),
      };
      if (location.source !== undefined) located.source = location.source;
      if (location.usedAt !== undefined) located.usedAt = location.usedAt;
      if (description.text !== undefined) located.text = description.text;
      return located;
    }),
  );
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("Canvas could not encode webp")) : resolve(blob)),
      "image/webp",
      0.9,
    );
  });
}

async function crop(page: HTMLCanvasElement, box: Box): Promise<Blob | undefined> {
  const scale = page.width / window.innerWidth;
  const left = Math.max(0, box.x - CROP_PADDING);
  const top = Math.max(0, box.y - CROP_PADDING);
  const right = Math.min(window.innerWidth, box.x + box.w + CROP_PADDING);
  const bottom = Math.min(window.innerHeight, box.y + box.h + CROP_PADDING);
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
 * Sends one annotation: pka:create with the draft and declared files, then pka:file
 * chunks in offset order, then waits for pka:created or pka:create-failed.
 */
export async function sendAnnotation(
  hot: ViteHotContext,
  prompt: string,
  elements: readonly Element[],
  composerAttachments: readonly ComposerAttachment[],
  onPhase: (phase: SendPhase) => void,
): Promise<{ id: string; createdAt: string }> {
  if (elements.length > MAX_ELEMENTS) {
    throw new Error(`Select at most ${MAX_ELEMENTS} elements; ${elements.length} are selected`);
  }
  onPhase({ phase: "locating" });
  const located = await locateElements(elements);
  const viewport = currentViewport();
  onPhase({ phase: "capturing" });
  // Elements no longer on the page keep their description but get no crop.
  const { page, crops } = await capture(
    located.filter((ref) => elements[ref.n - 1]?.isConnected === true),
  );

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
    },
    files: files.map((file) => ({ path: file.path, bytes: file.data.size })),
  });

  let reply: { id: string } | { failure: string } | undefined;
  let settle = () => {};
  const replied = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const stops = [
    listen(hot, CHANNEL.created, CreatedMessage, (message) => {
      if (message.requestId !== requestId) return;
      reply = { id: message.id };
      settle();
    }),
    listen(hot, CHANNEL.createFailed, CreateFailedMessage, (message) => {
      if (message.requestId !== requestId) return;
      reply = { failure: message.message };
      settle();
    }),
  ];
  let timer = 0;
  try {
    send(hot, CHANNEL.create, create);
    const total = files.reduce((sum, file) => sum + file.data.size, 0);
    let sent = 0;
    onPhase({ phase: "uploading", sent, total });
    upload: for (const file of files) {
      for (let offset = 0; offset === 0 || offset < file.data.size; offset += MAX_CHUNK_BYTES) {
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
        sent += chunk.size;
        onPhase({ phase: "uploading", sent, total });
        if (file.data.size === 0) break;
      }
    }

    onPhase({ phase: "waiting" });
    const timedOut = new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, REPLY_TIMEOUT_MS);
    });
    await Promise.race([replied, timedOut]);
  } finally {
    window.clearTimeout(timer);
    for (const stop of stops) stop();
  }
  if (reply === undefined) {
    throw new Error("No reply from the dev server within 30 s. Is annotator() in the Vite config?");
  }
  if ("failure" in reply) throw new Error(reply.failure);
  return { id: reply.id, createdAt: new Date().toISOString() };
}
