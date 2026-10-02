import { z } from "zod";

import { ErrorGroup, RelativePath, Timestamp, Viewport } from "./schema.ts";
import { RequestEntry } from "./timeline.ts";

// The files of one recording attachment, relative to the annotation directory. The
// overlay writes them; the Vite plugin stamps the git SHA into the manifest; `pka lab`
// replays the actions and navigations in timeline.jsonl.
export const RECORDING = {
  summary: "capture/summary.md",
  manifest: "capture/manifest.json",
  timeline: "capture/timeline.jsonl",
  network: "capture/network.jsonl",
  errors: "capture/errors.json",
  video: "capture/video.webm",
} as const;

export function framePath(n: number): string {
  return `capture/frames/${String(n).padStart(3, "0")}.webp`;
}

const Seq = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();

// A keyframe taken after the entry `seq`; entries since the previous keyframe share it.
export const RecordingFrame = z.strictObject({ path: RelativePath, seq: Seq, at: Timestamp });

export const RecordingVideo = z.union([
  z.strictObject({
    path: z.literal(RECORDING.video),
    mimeType: z.string(),
    bytes: Count,
    startedAt: Timestamp,
    endedAt: Timestamp,
    // Element Capture target; content outside it, including the overlay, is not in the video.
    restrictedTo: z.literal("body"),
    truncated: z.boolean(),
  }),
  z.strictObject({ path: z.null(), reason: z.string() }),
]);

// The manifest as the page writes it. The plugin adds gitSha when it stores the file.
export const RecordingManifestDraft = z.strictObject({
  url: z.string(),
  endUrl: z.string(),
  viewport: Viewport,
  startedAt: Timestamp,
  endedAt: Timestamp,
  seq: z.strictObject({ first: Seq, last: Seq }).nullable(),
  entries: z.strictObject({
    recorded: Count,
    limit: Count,
    // Entries after the limit are counted, not kept.
    dropped: Count,
  }),
  // Request and response bodies kept in network.jsonl, within a byte budget.
  bodies: z.strictObject({ limitBytes: Count, dropped: Count }),
  frames: z.strictObject({
    items: z.array(RecordingFrame),
    limit: Count,
    dropped: Count,
    failed: Count,
  }),
  video: RecordingVideo,
  redaction: z.strictObject({
    inputs: z.literal("values never recorded; masked in keyframes"),
    headers: z.literal("credential headers dropped"),
    urlParams: z.literal("credential-like values replaced with REDACTED"),
    // Same-origin path prefixes whose JSON and text bodies were kept, with credential keys redacted.
    bodies: z.array(z.string()),
    storage: z.literal("not read"),
    video: z.literal("not redacted; shows what the tab showed, typed values included"),
  }),
});

export const RecordingManifest = RecordingManifestDraft.extend({
  // HEAD of the dev server's workspace when the annotation was stored; null outside a Git repository.
  gitSha: z
    .string()
    .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
    .nullable(),
});

export const RecordingErrors = z.strictObject({ groups: z.array(ErrorGroup) });

const Header = z.strictObject({ name: z.string(), value: z.string() });

// One line of network.jsonl, shaped like a HAR entry. Sizes of -1 and status 0 mean unknown.
export const NetworkLine = RequestEntry.pick({
  seq: true,
  state: true,
  initiator: true,
  error: true,
  stream: true,
  serverFn: true,
  traceparent: true,
  serverTiming: true,
}).extend({
  startedDateTime: Timestamp,
  time: z.number().nonnegative().nullable(),
  request: z.strictObject({
    method: z.string(),
    url: z.string(),
    headers: z.array(Header),
    bodySize: z.number().int().min(-1),
    postData: z.strictObject({ mimeType: z.string(), text: z.string() }).optional(),
  }),
  response: z.strictObject({
    status: Count,
    headers: z.array(Header),
    content: z.strictObject({
      size: z.number().int().min(-1),
      mimeType: z.string(),
      text: z.string().optional(),
    }),
    transferSize: z.number().int().min(-1),
  }),
});

export type RecordingFrame = z.infer<typeof RecordingFrame>;
export type RecordingVideo = z.infer<typeof RecordingVideo>;
export type RecordingManifestDraft = z.infer<typeof RecordingManifestDraft>;
export type RecordingManifest = z.infer<typeof RecordingManifest>;
export type RecordingErrors = z.infer<typeof RecordingErrors>;
export type NetworkLine = z.infer<typeof NetworkLine>;
