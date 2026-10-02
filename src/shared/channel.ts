import { z } from "zod";

import { AnnotationDraft, ErrorGroup, Id, RelativePath, State, ThreadEntry } from "./schema.ts";

// Vite HMR custom events between the overlay (import.meta.hot.send) and the
// plugin (server.ws.on / client.send). Both ends parse every payload with the
// schema of its event and drop the message on failure.
//
// Creating an annotation:
//   overlay  pka:create   {requestId, draft, files[{path, bytes}]}
//   plugin   pka:create-failed  when it refuses up front (bad paths, video over the store cap)
//   overlay  pka:file     one or more chunks per declared file, in offset order
//   plugin   pka:created  after every declared byte has arrived and the annotation is written
// The plugin keeps the files in memory until the last chunk and then writes the
// annotation directory in one rename, so readers never see a partial annotation.
export const CHANNEL = {
  create: "pka:create",
  file: "pka:file",
  errors: "pka:errors",
  reply: "pka:reply",
  created: "pka:created",
  createFailed: "pka:create-failed",
  state: "pka:state",
  thread: "pka:thread",
  errorsAck: "pka:errors-ack",
} as const;

export const MAX_CHUNK_BYTES = 512 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;

// overlay -> plugin

export const CreateMessage = z.strictObject({
  requestId: Id,
  draft: AnnotationDraft,
  files: z
    .array(
      z.strictObject({
        path: RelativePath,
        bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
      }),
    )
    .max(500),
});

export const FileChunkMessage = z.strictObject({
  requestId: Id,
  path: RelativePath,
  offset: z.number().int().nonnegative(),
  data: z.base64().max(Math.ceil(MAX_CHUNK_BYTES / 3) * 4),
});

// New or changed groups only; the plugin merges them by fingerprint into
// live/errors.json. `stack` is the raw browser stack; the plugin symbolicates it.
export const ErrorsMessage = z.strictObject({
  groups: z.array(ErrorGroup).min(1).max(50),
});

export const ReplyMessage = z.strictObject({
  id: Id,
  text: z.string().min(1).max(10_000),
});

// plugin -> overlay

export const CreatedMessage = z.strictObject({
  requestId: Id,
  id: Id,
});

export const CreateFailedMessage = z.strictObject({
  requestId: Id,
  message: z.string(),
});

export const StateMessage = z.strictObject({
  id: Id,
  state: State,
});

export const ThreadMessage = z.strictObject({
  id: Id,
  entry: ThreadEntry,
});

export const ErrorsAckMessage = z.strictObject({
  groups: z.array(
    z.strictObject({
      fingerprint: z.string().min(1).max(200),
      stack: z.string(),
      topFrame: z.string().optional(),
    }),
  ),
});

export type CreateMessage = z.infer<typeof CreateMessage>;
export type FileChunkMessage = z.infer<typeof FileChunkMessage>;
export type ErrorsMessage = z.infer<typeof ErrorsMessage>;
export type ReplyMessage = z.infer<typeof ReplyMessage>;
export type CreatedMessage = z.infer<typeof CreatedMessage>;
export type CreateFailedMessage = z.infer<typeof CreateFailedMessage>;
export type StateMessage = z.infer<typeof StateMessage>;
export type ThreadMessage = z.infer<typeof ThreadMessage>;
export type ErrorsAckMessage = z.infer<typeof ErrorsAckMessage>;

export interface ChannelEvents {
  [CHANNEL.create]: CreateMessage;
  [CHANNEL.file]: FileChunkMessage;
  [CHANNEL.errors]: ErrorsMessage;
  [CHANNEL.reply]: ReplyMessage;
  [CHANNEL.created]: CreatedMessage;
  [CHANNEL.createFailed]: CreateFailedMessage;
  [CHANNEL.state]: StateMessage;
  [CHANNEL.thread]: ThreadMessage;
  [CHANNEL.errorsAck]: ErrorsAckMessage;
}
