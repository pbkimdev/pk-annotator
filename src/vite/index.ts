import { randomBytes } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  normalizePath,
  searchForWorkspaceRoot,
  type InferCustomEventPayload,
  type NormalizedHotChannelClient,
  type Plugin,
  type ViteDevServer,
} from "vite";
import { z } from "zod";

import { checkCaptureFiles, create, loadAnnotation, reply, upsertErrorGroups } from "../ops/ops.ts";
import {
  CHANNEL,
  CreateMessage,
  ErrorsMessage,
  FileChunkMessage,
  ReplyMessage,
  SyncMessage,
  type ErrorsAckMessage,
  type SyncedMessage,
} from "../shared/channel.ts";
import { ID_PATTERN, type AnnotationDraft, type ErrorGroup } from "../shared/schema.ts";
import {
  DEFAULT_SIZE_CAP_BYTES,
  MissingAnnotationError,
  PkaError,
  checkStoreSize,
  createStore,
  isErrno,
  listIds,
  resolveInside,
} from "../store/store.ts";
import { sourcePlugin } from "./source.ts";
import { symbolicate } from "./symbolicate.ts";

const AnnotatorOptions = z.strictObject({
  bodies: z.array(z.string().startsWith("/")).optional(),
  maxStoreBytes: z.number().int().positive().optional(),
});
export type AnnotatorOptions = z.input<typeof AnnotatorOptions>;

/**
 * The overlay reads `bodies` from this global. Vite's client sets every
 * `define` key on globalThis in dev, so it reaches a pre-bundled overlay too.
 */
export const BODIES_GLOBAL = "__PKA_BODIES__";

const STAGING_DIR = ".staging";
const MB = 1024 * 1024;

interface UploadFile {
  bytes: number;
  received: number;
}

interface Upload {
  requestId: string;
  client: NormalizedHotChannelClient;
  dir: string;
  draft: AnnotationDraft;
  files: Map<string, UploadFile>;
  remaining: number;
  done: boolean;
  queue: Promise<void>;
}

type ChannelListener = (
  data: InferCustomEventPayload<string>,
  client: NormalizedHotChannelClient,
) => void;

interface Seen {
  history: number;
  thread: number;
}

/** A staging directory named <pid>-<hex> belongs to a running process unless that pid is gone. */
function ownerAlive(name: string): boolean {
  const pid = Number(name.split("-", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !isErrno(cause, "ESRCH");
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function writeChunk(file: string, offset: number, data: Buffer): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const { bytesWritten } = await handle.write(data, 0, data.length, offset);
    if (bytesWritten !== data.length) {
      throw new Error(`Short write to ${file}: ${bytesWritten} of ${data.length} bytes`);
    }
  } finally {
    await handle.close();
  }
}

async function createEmpty(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  await handle.close();
}

/** Opens the store, serves the overlay's channel events, and pushes store changes. Returns the closer. */
async function serve(server: ViteDevServer, maxStoreBytes: number): Promise<() => Promise<void>> {
  const workspaceRoot = normalizePath(searchForWorkspaceRoot(server.config.root));
  const store = await createStore(workspaceRoot);
  const stagingRoot = resolveInside(store, STAGING_DIR);
  // Several dev servers in one workspace share the store, so each stages under its own directory.
  const serverStaging = resolveInside(
    stagingRoot,
    `${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  const environment = server.environments.client;
  const { hot } = environment;
  const { logger } = server.config;
  const uploads = new Map<string, Upload>();
  const seen = new Map<string, Seen>();
  const listeners: Array<[string, ChannelListener]> = [];
  let errorsQueue = Promise.resolve();
  let pushQueue = Promise.resolve();
  const changed = new Set<string>();
  let flushScheduled = false;
  let closed = false;
  /** Pending and acknowledged annotations only; resolved and dismissed ones are not watched. */
  const annotationWatchers = new Map<string, FSWatcher>();

  const warn = (line: string): void => logger.warn(`pk-annotator: ${line}`, { timestamp: true });
  const error = (line: string): void => logger.error(`pk-annotator: ${line}`, { timestamp: true });

  /** Removes this server's abandoned requests and the staging directories of exited processes. */
  async function removeStaleStaging(): Promise<void> {
    for (const name of await readdir(serverStaging)) {
      if (!uploads.has(name)) {
        await rm(resolveInside(serverStaging, name), { recursive: true, force: true });
      }
    }
    for (const name of await readdir(stagingRoot)) {
      if (!ownerAlive(name)) {
        await rm(resolveInside(stagingRoot, name), { recursive: true, force: true });
      }
    }
  }

  async function abort(upload: Upload, cause: unknown): Promise<void> {
    upload.done = true;
    uploads.delete(upload.requestId);
    await rm(upload.dir, { recursive: true, force: true });
    if (!(cause instanceof PkaError))
      error(`storing annotation ${upload.requestId} failed: ${describeError(cause)}`);
    upload.client.send(CHANNEL.createFailed, {
      requestId: upload.requestId,
      message: describeError(cause),
    });
  }

  function enqueue(upload: Upload, step: () => Promise<void>): void {
    upload.queue = upload.queue
      .then(async () => {
        if (upload.done) return;
        try {
          await step();
        } catch (thrown) {
          await abort(upload, thrown);
        }
      })
      .catch((cause: unknown) =>
        error(`cleaning up ${upload.requestId} failed: ${describeError(cause)}`),
      );
  }

  async function finish(upload: Upload): Promise<void> {
    const { id } = await create(store, upload.draft, {
      dir: upload.dir,
      paths: [...upload.files.keys()],
    });
    upload.done = true;
    uploads.delete(upload.requestId);
    seen.set(id, { history: 1, thread: 0 });
    upload.client.send(CHANNEL.created, { requestId: upload.requestId, id });
  }

  async function prepare(upload: Upload, declaredBytes: number): Promise<void> {
    if (upload.draft.attachments.some((attachment) => attachment.kind === "video")) {
      const size = await checkStoreSize(store, maxStoreBytes);
      if (size.bytes + declaredBytes > maxStoreBytes) {
        throw new PkaError(
          `The annotation store holds ${Math.round(size.bytes / MB)} MB; this ${Math.round(declaredBytes / MB)} MB ` +
            `recording would pass the ${Math.round(maxStoreBytes / MB)} MB cap. Run pka prune or remove old annotations, ` +
            "or send it without video.",
        );
      }
    }
    await removeStaleStaging();
    await mkdir(upload.dir);
    for (const file of upload.files.keys()) await createEmpty(resolveInside(upload.dir, file));
  }

  function listen<S extends z.ZodType>(
    event: string,
    schema: S,
    handle: (message: z.infer<S>, client: NormalizedHotChannelClient) => Promise<void>,
  ): void {
    const listener: ChannelListener = (data, client) => {
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        warn(
          `dropped ${event}: ${issue === undefined ? "invalid" : `${issue.path.join(".") || "payload"}: ${issue.message}`}` +
            (parsed.error.issues.length > 1 ? ` (+${parsed.error.issues.length - 1} more)` : ""),
        );
        return;
      }
      handle(parsed.data, client).catch((cause: unknown) =>
        error(`${event} failed: ${describeError(cause)}`),
      );
    };
    hot.on(event, listener);
    listeners.push([event, listener]);
  }

  listen(CHANNEL.create, CreateMessage, async (message, client) => {
    const { requestId } = message;
    const refuse = (reason: string): void =>
      client.send(CHANNEL.createFailed, { requestId, message: reason });
    if (uploads.has(requestId)) {
      refuse(`Request ${requestId} is already in progress`);
      return;
    }
    try {
      checkCaptureFiles(
        message.draft,
        message.files.map((file) => file.path),
      );
    } catch (thrown) {
      if (!(thrown instanceof PkaError)) throw thrown;
      refuse(thrown.message);
      return;
    }
    const declaredBytes = message.files.reduce((total, file) => total + file.bytes, 0);
    const upload: Upload = {
      requestId,
      client,
      dir: resolveInside(serverStaging, requestId),
      draft: message.draft,
      files: new Map(message.files.map((file) => [file.path, { bytes: file.bytes, received: 0 }])),
      remaining: declaredBytes,
      done: false,
      queue: Promise.resolve(),
    };
    uploads.set(requestId, upload);
    enqueue(upload, () => prepare(upload, declaredBytes));
    if (declaredBytes === 0) enqueue(upload, () => finish(upload));
  });

  listen(CHANNEL.file, FileChunkMessage, async (message, client) => {
    const upload = uploads.get(message.requestId);
    if (upload === undefined || upload.client !== client) {
      warn(`dropped ${CHANNEL.file}: no upload ${message.requestId} in progress for this page`);
      return;
    }
    const file = upload.files.get(message.path);
    const data = Buffer.from(message.data, "base64");
    if (
      file === undefined ||
      message.offset !== file.received ||
      file.received + data.length > file.bytes
    ) {
      const reason = new PkaError(
        file === undefined
          ? `Chunk for ${message.path}, which the request did not declare`
          : `Chunk for ${message.path} at offset ${message.offset} does not continue the ${file.received} of ${file.bytes} bytes received`,
      );
      enqueue(upload, () => Promise.reject(reason));
      return;
    }
    file.received += data.length;
    upload.remaining -= data.length;
    const target = resolveInside(upload.dir, message.path);
    enqueue(upload, () => writeChunk(target, message.offset, data));
    if (upload.remaining === 0) enqueue(upload, () => finish(upload));
  });

  listen(CHANNEL.errors, ErrorsMessage, async (message, client) => {
    const groups = await Promise.all(
      message.groups.map(async (group): Promise<ErrorGroup> => {
        const { topFrame: _pageTopFrame, ...rest } = group;
        const result = await symbolicate(environment, workspaceRoot, group.stack);
        return result.topFrame === undefined
          ? { ...rest, stack: result.stack }
          : { ...rest, stack: result.stack, topFrame: result.topFrame };
      }),
    );
    const write = errorsQueue.then(() => upsertErrorGroups(store, groups));
    errorsQueue = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
    const ack: ErrorsAckMessage = {
      groups: groups.map((group) =>
        group.topFrame === undefined
          ? { fingerprint: group.fingerprint, stack: group.stack }
          : { fingerprint: group.fingerprint, stack: group.stack, topFrame: group.topFrame },
      ),
    };
    client.send(CHANNEL.errorsAck, ack);
  });

  listen(CHANNEL.reply, ReplyMessage, async (message) => {
    await reply(store, message, "human");
  });

  listen(CHANNEL.sync, SyncMessage, async (message, client) => {
    const synced: SyncedMessage = { annotations: [] };
    for (const id of message.ids) {
      try {
        const record = await loadAnnotation(store, id);
        synced.annotations.push({ id, state: record.state, thread: record.thread });
      } catch (thrown) {
        if (!(thrown instanceof MissingAnnotationError)) throw thrown;
      }
    }
    client.send(CHANNEL.synced, synced);
  });

  const onDisconnect: ChannelListener = (_data, client) => {
    for (const upload of uploads.values()) {
      if (upload.client === client) {
        enqueue(upload, () =>
          Promise.reject(new PkaError("The page disconnected before the upload finished")),
        );
      }
    }
  };
  hot.on("vite:client:disconnect", onDisconnect);
  listeners.push(["vite:client:disconnect", onDisconnect]);

  function schedule(id: string): void {
    changed.add(id);
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(flush);
  }

  function unwatch(id: string): void {
    annotationWatchers.get(id)?.close();
    annotationWatchers.delete(id);
    seen.delete(id);
  }

  /**
   * Brings one annotation's watch and broadcasts up to date. An annotation
   * seen for the first time sets the baseline without broadcasting.
   */
  async function sync(id: string): Promise<void> {
    let record;
    try {
      record = await loadAnnotation(store, id);
    } catch (thrown) {
      if (!(thrown instanceof MissingAnnotationError)) throw thrown;
      unwatch(id);
      return;
    }
    if (closed) return;
    const known = seen.get(id);
    if (known !== undefined) {
      if (record.state.history.length !== known.history) {
        hot.send(CHANNEL.state, { id, state: record.state });
      }
      for (const entry of record.thread.slice(known.thread)) {
        hot.send(CHANNEL.thread, { id, entry });
      }
    }
    if (record.state.status === "resolved" || record.state.status === "dismissed") {
      unwatch(id);
      return;
    }
    seen.set(id, { history: record.state.history.length, thread: record.thread.length });
    if (annotationWatchers.has(id)) return;
    const watcher = watch(record.dir, (_event, filename) => {
      if (filename === "state.json" || filename === "thread.jsonl") schedule(id);
    });
    watcher.on("error", (cause) => {
      error(`watching annotation ${id} failed: ${describeError(cause)}`);
      unwatch(id);
    });
    annotationWatchers.set(id, watcher);
    // A change between the read above and the watch would otherwise go unseen.
    schedule(id);
  }

  function flush(): void {
    flushScheduled = false;
    const ids = [...changed];
    changed.clear();
    pushQueue = pushQueue.then(async () => {
      for (const id of ids) {
        await sync(id).catch((cause: unknown) =>
          error(`reading annotation ${id} failed: ${describeError(cause)}`),
        );
      }
    });
  }

  await mkdir(stagingRoot, { recursive: true });
  if ((await lstat(stagingRoot)).isSymbolicLink()) {
    throw new PkaError(`Refusing symlink in the annotation store: ${stagingRoot}`);
  }
  await mkdir(serverStaging);
  await removeStaleStaging();

  // New and removed annotation directories appear in the store root; .staging and live are not ids.
  const storeWatcher = watch(store, (_event, filename) => {
    if (filename !== null && ID_PATTERN.test(filename)) schedule(filename);
  });
  storeWatcher.on("error", (cause) => error(`store watcher failed: ${describeError(cause)}`));
  for (const id of await listIds(store)) schedule(id);

  return async () => {
    closed = true;
    storeWatcher.close();
    for (const watcher of annotationWatchers.values()) watcher.close();
    annotationWatchers.clear();
    for (const [event, listener] of listeners) hot.off(event, listener);
    for (const upload of uploads.values()) upload.done = true;
    uploads.clear();
    await rm(serverStaging, { recursive: true, force: true });
  };
}

function channelPlugin(maxStoreBytes: number, bodies: string[]): Plugin {
  let close: (() => Promise<void>) | undefined;
  return {
    name: "pk-annotator:channel",
    apply: "serve",
    config() {
      return { define: { [BODIES_GLOBAL]: JSON.stringify(bodies) } };
    },
    async configureServer(server) {
      close = await serve(server, maxStoreBytes);
    },
    // Vite calls buildEnd once, for the client environment, when the dev server closes.
    async buildEnd() {
      const closing = close;
      close = undefined;
      await closing?.();
    },
  };
}

/** Dev-server plugins: source attributes, the overlay channel, symbolication, and the store watcher. Nothing runs in builds. */
export function annotator(options: AnnotatorOptions = {}): Plugin[] {
  const parsed = AnnotatorOptions.parse(options);
  return [
    sourcePlugin(),
    channelPlugin(parsed.maxStoreBytes ?? DEFAULT_SIZE_CAP_BYTES, parsed.bodies ?? []),
  ];
}
