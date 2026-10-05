import { z } from "zod";

import { AgentPresence } from "./agent.ts";
import { AnnotationDraft, ErrorGroup, Id, RelativePath, State, ThreadEntry } from "./schema.ts";

// Vite HMR custom events between the overlay (import.meta.hot.send) and the
// plugin (server.ws.on / client.send). Both ends parse every payload with the
// schema of its event and drop the message on failure.
//
// Creating an annotation:
//   overlay  pka:create   {requestId, draft, files[{path, bytes}]}
//   plugin   pka:create-failed  when it refuses up front (bad paths, video over the store cap)
//   plugin   pka:upload-ready  after staging files are ready
//   overlay  pka:file     one chunk, then wait for pka:file-written before sending another
//   plugin   pka:file-written  after the chunk reaches disk
//   overlay  pka:cancel-upload when a send fails before completion
//   plugin   pka:created  after every declared byte has arrived and the annotation is written
// The plugin stages chunks on disk under the store's .staging/<server>/<requestId>/ and
// moves the finished annotation directory into place in one rename, so readers
// never see a partial annotation and large files never sit in memory.
//
// Symbolicating the stacks a hunt attaches (occurrence, owner, and component stacks):
//   overlay  pka:symbolicate    {requestId, stacks}
//   plugin   pka:symbolicated   {requestId, stacks} in the same order
//
// Resuming after a reload:
//   overlay  pka:sync    {ids} the annotations this tab sent earlier
//   plugin   pka:synced  {annotations[{id, state, thread}]} for the ids that still exist
//
// Agent presence:
//   overlay  pka:presence  {} when the launcher mounts
//   plugin   pka:agent     {agent, cause} the most recently connected live pka-mcp client, or
//                          null: the reply to pka:presence while one is connected, and a
//                          broadcast whenever it changes
//
// Agent setup:
//   overlay  pka:setup       {requestId} when Connect agent is chosen
//   plugin   pka:setup-info  {requestId, root, store, command} pka-mcp's --root, the store,
//                            and the command that launches the installed pka-mcp, or null
//
// Updating the package:
//   plugin   pka:update          {current, latest} in reply to pka:presence while npm has a newer release
//   overlay  pka:install-update  {requestId, version} when Update is chosen
//   plugin   pka:update-result   {requestId, outcome} "restart" just before the dev server restarts and
//                                the page reloads, "restart-manually" when only a process restart loads
//                                the plugin, or "failed" with a message
export const CHANNEL = {
  create: "pka:create",
  file: "pka:file",
  uploadReady: "pka:upload-ready",
  fileWritten: "pka:file-written",
  cancelUpload: "pka:cancel-upload",
  errors: "pka:errors",
  created: "pka:created",
  createFailed: "pka:create-failed",
  state: "pka:state",
  thread: "pka:thread",
  errorsAck: "pka:errors-ack",
  sync: "pka:sync",
  synced: "pka:synced",
  symbolicate: "pka:symbolicate",
  symbolicated: "pka:symbolicated",
  presence: "pka:presence",
  agent: "pka:agent",
  setup: "pka:setup",
  setupInfo: "pka:setup-info",
  update: "pka:update",
  installUpdate: "pka:install-update",
  updateResult: "pka:update-result",
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

export const CancelUploadMessage = z.strictObject({ requestId: Id });

// New or changed groups only; the plugin merges them by fingerprint into
// live/errors.json. `stack` is the raw browser stack; the plugin symbolicates it.
export const ErrorsMessage = z.strictObject({
  groups: z.array(ErrorGroup).min(1).max(50),
});

export const SyncMessage = z.strictObject({
  ids: z.array(Id).max(200),
});

export const MAX_SYMBOLICATE_STACKS = 150;

// Core caps a stack at 16,000 characters plus a short "…[+N chars]" marker.
export const SymbolicateMessage = z.strictObject({
  requestId: Id,
  stacks: z.array(z.string().max(16_100)).max(MAX_SYMBOLICATE_STACKS),
});

export const PresenceMessage = z.strictObject({});

export const SetupMessage = z.strictObject({ requestId: Id });

const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

export const InstallUpdateMessage = z.strictObject({ requestId: Id, version: Version });

// plugin -> overlay

export const UploadReadyMessage = z.strictObject({ requestId: Id });

export const FileWrittenMessage = z.strictObject({
  requestId: Id,
  path: RelativePath,
  offset: z.number().int().nonnegative(),
});

export const CreatedMessage = z.strictObject({
  requestId: Id,
  id: Id,
  // The annotation's directory, relative to the workspace root when the store is inside it.
  dir: z.string().min(1).max(4096),
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

export const SymbolicatedMessage = z.strictObject({
  requestId: Id,
  stacks: z.array(z.string()),
});

export const SyncedMessage = z.strictObject({
  annotations: z.array(
    z.strictObject({
      id: Id,
      state: State,
      thread: z.array(ThreadEntry),
    }),
  ),
});

export const SetupInfoMessage = z.strictObject({
  requestId: Id,
  root: z.string().min(1),
  store: z.string().min(1),
  command: z.array(z.string().min(1)).min(1).nullable(),
});

export const AgentMessage = z.strictObject({
  agent: AgentPresence.pick({ name: true, version: true, connectedAt: true }).nullable(),
  // "presence" answers a page that just mounted; "change" is a session connecting or leaving.
  cause: z.enum(["presence", "change"]),
});

export const UpdateMessage = z.strictObject({ current: Version, latest: Version });

export const UpdateResultMessage = z.discriminatedUnion("outcome", [
  z.strictObject({ requestId: Id, outcome: z.enum(["restart", "restart-manually"]) }),
  z.strictObject({ requestId: Id, outcome: z.literal("failed"), message: z.string() }),
]);

export type CreateMessage = z.infer<typeof CreateMessage>;
export type FileChunkMessage = z.infer<typeof FileChunkMessage>;
export type UploadReadyMessage = z.infer<typeof UploadReadyMessage>;
export type FileWrittenMessage = z.infer<typeof FileWrittenMessage>;
export type CancelUploadMessage = z.infer<typeof CancelUploadMessage>;
export type ErrorsMessage = z.infer<typeof ErrorsMessage>;
export type CreatedMessage = z.infer<typeof CreatedMessage>;
export type CreateFailedMessage = z.infer<typeof CreateFailedMessage>;
export type StateMessage = z.infer<typeof StateMessage>;
export type ThreadMessage = z.infer<typeof ThreadMessage>;
export type ErrorsAckMessage = z.infer<typeof ErrorsAckMessage>;
export type SyncMessage = z.infer<typeof SyncMessage>;
export type SyncedMessage = z.infer<typeof SyncedMessage>;
export type SymbolicateMessage = z.infer<typeof SymbolicateMessage>;
export type SymbolicatedMessage = z.infer<typeof SymbolicatedMessage>;
export type PresenceMessage = z.infer<typeof PresenceMessage>;
export type AgentMessage = z.infer<typeof AgentMessage>;
export type SetupMessage = z.infer<typeof SetupMessage>;
export type SetupInfoMessage = z.infer<typeof SetupInfoMessage>;
export type UpdateMessage = z.infer<typeof UpdateMessage>;
export type InstallUpdateMessage = z.infer<typeof InstallUpdateMessage>;
export type UpdateResultMessage = z.infer<typeof UpdateResultMessage>;

export interface ChannelEvents {
  [CHANNEL.create]: CreateMessage;
  [CHANNEL.file]: FileChunkMessage;
  [CHANNEL.uploadReady]: UploadReadyMessage;
  [CHANNEL.fileWritten]: FileWrittenMessage;
  [CHANNEL.cancelUpload]: CancelUploadMessage;
  [CHANNEL.errors]: ErrorsMessage;
  [CHANNEL.created]: CreatedMessage;
  [CHANNEL.createFailed]: CreateFailedMessage;
  [CHANNEL.state]: StateMessage;
  [CHANNEL.thread]: ThreadMessage;
  [CHANNEL.errorsAck]: ErrorsAckMessage;
  [CHANNEL.sync]: SyncMessage;
  [CHANNEL.synced]: SyncedMessage;
  [CHANNEL.symbolicate]: SymbolicateMessage;
  [CHANNEL.symbolicated]: SymbolicatedMessage;
  [CHANNEL.presence]: PresenceMessage;
  [CHANNEL.agent]: AgentMessage;
  [CHANNEL.setup]: SetupMessage;
  [CHANNEL.setupInfo]: SetupInfoMessage;
  [CHANNEL.update]: UpdateMessage;
  [CHANNEL.installUpdate]: InstallUpdateMessage;
  [CHANNEL.updateResult]: UpdateResultMessage;
}
