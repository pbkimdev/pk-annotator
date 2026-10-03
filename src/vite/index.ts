import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  normalizePath,
  searchForWorkspaceRoot,
  type InferCustomEventPayload,
  type NormalizedHotChannelClient,
  type Plugin,
  type ViteDevServer,
} from "vite";
import { z } from "zod";

import { checkCaptureFiles, create, loadAnnotation, upsertErrorGroups } from "../ops/ops.ts";
import { agentsDir, liveAgents } from "../ops/presence.ts";
import {
  CHANNEL,
  CreateMessage,
  ErrorsMessage,
  FileChunkMessage,
  PresenceMessage,
  SetupMessage,
  SymbolicateMessage,
  SyncMessage,
  type AgentMessage,
  type ErrorsAckMessage,
  type SetupInfoMessage,
  type SymbolicatedMessage,
  type SyncedMessage,
} from "../shared/channel.ts";
import {
  RecordingErrors,
  RecordingManifestDraft,
  type RecordingManifest,
} from "../shared/recording.ts";
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
  storeRoot: z.string().min(1).optional(),
});
export type AnnotatorOptions = z.input<typeof AnnotatorOptions>;

/**
 * The overlay reads `bodies` from this global. Vite's client sets every
 * `define` key on globalThis in dev, so it reaches a pre-bundled overlay too.
 */
export const BODIES_GLOBAL = "__PKA_BODIES__";

const STAGING_DIR = ".staging";
const MB = 1024 * 1024;
const MAX_RECORDING_JSON_BYTES = 4 * MB;
const execFileAsync = promisify(execFile);

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

async function rewrite(file: string, text: string): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

/** HEAD of the workspace when the annotation is stored, so the SHA matches the code it was taken against. */
async function headSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd,
      timeout: 5000,
    });
    return stdout.trim();
  } catch (cause) {
    const stderr = cause instanceof Error && "stderr" in cause ? String(cause.stderr) : "";
    // No Git, no repository, or no commit yet: there is no SHA to record.
    if (isErrno(cause, "ENOENT") || /not a git repository|Needed a single revision/.test(stderr)) {
      return null;
    }
    throw new Error(`git rev-parse HEAD failed in ${cwd}: ${describeError(cause)}`, { cause });
  }
}

/**
 * The command that launches pka-mcp: the workspace's bin, which survives version bumps, else
 * this package's own build, beside the built plugin or, for this repository's fixture, which
 * loads the plugin from src/vite, in dist. Null when none exists.
 */
async function mcpCommand(workspaceRoot: string): Promise<string[] | null> {
  const bin = path.join(workspaceRoot, "node_modules/.bin/pka-mcp");
  const builds = ["./pka-mcp.mjs", "../../dist/pka-mcp.mjs"].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  );
  for (const [file, command] of [
    [bin, [normalizePath(bin)]],
    ...builds.map((build) => [build, ["node", normalizePath(build)]] as const),
  ] as const) {
    const found = await stat(file).catch((cause: unknown) => {
      if (isErrno(cause, "ENOENT")) return undefined;
      throw cause;
    });
    if (found !== undefined) return [...command];
  }
  return null;
}

/** Opens the store, serves the overlay's channel events, and pushes store changes. Returns the closer. */
async function serve(
  server: ViteDevServer,
  maxStoreBytes: number,
  storeRoot: string | undefined,
): Promise<() => Promise<void>> {
  const workspaceRoot = normalizePath(searchForWorkspaceRoot(server.config.root));
  let projectRoot = workspaceRoot;
  if (storeRoot !== undefined) {
    projectRoot = normalizePath(path.resolve(server.config.root, storeRoot));
    const info = await stat(projectRoot).catch((cause: unknown) => {
      if (isErrno(cause, "ENOENT")) return undefined;
      throw cause;
    });
    if (!info?.isDirectory()) {
      throw new PkaError(`storeRoot ${projectRoot} is not an existing directory`);
    }
  }
  const store = await createStore(projectRoot);
  // Where a pasted agent finds an annotation: relative to the workspace when it can be.
  const fromWorkspace = path.relative(await realpath(workspaceRoot), store);
  const storeDisplay =
    fromWorkspace.startsWith("..") || path.isAbsolute(fromWorkspace)
      ? normalizePath(store)
      : normalizePath(fromWorkspace);
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

  /** Replaces the page's raw stack and top frame with source positions. */
  async function symbolicateGroup(group: ErrorGroup): Promise<ErrorGroup> {
    const { topFrame: _pageTopFrame, ...rest } = group;
    const result = await symbolicate(environment, workspaceRoot, group.stack);
    return result.topFrame === undefined
      ? { ...rest, stack: result.stack }
      : { ...rest, stack: result.stack, topFrame: result.topFrame };
  }

  async function readStagedJson<S extends z.ZodType>(
    upload: Upload,
    relative: string,
    schema: S,
  ): Promise<z.infer<S>> {
    const bytes = upload.files.get(relative)?.bytes ?? 0;
    if (bytes > MAX_RECORDING_JSON_BYTES) {
      throw new PkaError(`${relative} is ${Math.round(bytes / MB)} MB; the limit is 4 MB`);
    }
    const text = await readFile(resolveInside(upload.dir, relative), "utf8");
    let value;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new PkaError(`${relative} is not JSON: ${describeError(cause)}`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new PkaError(
        `${relative} does not match its schema: ${issue === undefined ? "invalid" : `${issue.path.join(".")}: ${issue.message}`}`,
      );
    }
    return parsed.data;
  }

  /** Stamps the git SHA into a recording's manifest and symbolicates its error groups. */
  async function completeRecording(upload: Upload, directory: string): Promise<void> {
    const manifestPath = path.posix.join(directory, "manifest.json");
    const errorsPath = path.posix.join(directory, "errors.json");
    const draft = await readStagedJson(upload, manifestPath, RecordingManifestDraft);
    const manifest: RecordingManifest = { ...draft, gitSha: await headSha(workspaceRoot) };
    await rewrite(
      resolveInside(upload.dir, manifestPath),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    if (!upload.files.has(errorsPath)) return;
    const errors = await readStagedJson(upload, errorsPath, RecordingErrors);
    const groups = await Promise.all(errors.groups.map(symbolicateGroup));
    await rewrite(
      resolveInside(upload.dir, errorsPath),
      `${JSON.stringify({ groups }, null, 2)}\n`,
    );
  }

  async function finish(upload: Upload): Promise<void> {
    const recordingDirectories = new Set(
      upload.draft.attachments
        .filter((attachment) => attachment.kind === "recording")
        .map((attachment) => path.posix.dirname(attachment.path)),
    );
    for (const directory of recordingDirectories) await completeRecording(upload, directory);
    const { id } = await create(store, upload.draft, {
      dir: upload.dir,
      paths: [...upload.files.keys()],
    });
    upload.done = true;
    uploads.delete(upload.requestId);
    seen.set(id, { history: 1, thread: 0 });
    upload.client.send(CHANNEL.created, {
      requestId: upload.requestId,
      id,
      dir: path.posix.join(storeDisplay, id),
    });
  }

  async function prepare(upload: Upload, declaredBytes: number): Promise<void> {
    if (
      [...upload.files.keys()].some((file) => file.endsWith(".webm") || file.endsWith(".gif")) ||
      upload.draft.attachments.some((attachment) => attachment.kind === "video")
    ) {
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
    const groups = await Promise.all(message.groups.map(symbolicateGroup));
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

  listen(CHANNEL.symbolicate, SymbolicateMessage, async (message, client) => {
    const stacks = await Promise.all(
      message.stacks.map(
        async (stack) => (await symbolicate(environment, workspaceRoot, stack)).stack,
      ),
    );
    const reply: SymbolicatedMessage = { requestId: message.requestId, stacks };
    client.send(CHANNEL.symbolicated, reply);
  });

  listen(CHANNEL.setup, SetupMessage, async (message, client) => {
    const reply: SetupInfoMessage = {
      requestId: message.requestId,
      root: projectRoot,
      store: normalizePath(store),
      command: await mcpCommand(workspaceRoot),
    };
    client.send(CHANNEL.setupInfo, reply);
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

  // The active agent is the most recently connected pka-mcp session whose process lives.
  let agentPushed = "";
  let agentQueue = Promise.resolve();
  let agentScheduled = false;

  async function readAgent(): Promise<AgentMessage["agent"]> {
    const { agents, invalid } = await liveAgents(store);
    for (const { file, reason } of invalid) warn(`ignored agent presence ${file}: ${reason}`);
    const latest = agents[0];
    return latest === undefined
      ? null
      : { name: latest.name, version: latest.version, connectedAt: latest.connectedAt };
  }

  /** Broadcasts the active agent when it differs from the last broadcast. */
  function pushAgent(agent: AgentMessage["agent"]): void {
    const text = JSON.stringify(agent);
    if (text === agentPushed || closed) return;
    agentPushed = text;
    const message: AgentMessage = { agent, cause: "change" };
    hot.send(CHANNEL.agent, message);
  }

  function refreshAgent(): void {
    agentScheduled = false;
    agentQueue = agentQueue
      .then(async () => pushAgent(await readAgent()))
      .catch((cause: unknown) => error(`reading agent presence failed: ${describeError(cause)}`));
  }

  // A page with no agent connected gets no answer, so it never loads the agent theme.
  // Reads share the watcher's queue, so an older read never broadcasts after a newer one.
  listen(CHANNEL.presence, PresenceMessage, async (_message, client) => {
    const answered = agentQueue.then(async () => {
      const agent = await readAgent();
      pushAgent(agent);
      if (agent !== null) {
        const message: AgentMessage = { agent, cause: "presence" };
        client.send(CHANNEL.agent, message);
      }
    });
    agentQueue = answered.catch(() => undefined);
    await answered;
  });

  function schedule(id: string): void {
    changed.add(id);
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(flush);
  }

  function unwatch(id: string): void {
    annotationWatchers.get(id)?.close();
    annotationWatchers.delete(id);
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
      seen.delete(id);
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
    seen.set(id, { history: record.state.history.length, thread: record.thread.length });
    if (record.state.status === "resolved" || record.state.status === "dismissed") {
      unwatch(id);
      return;
    }
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

  await mkdir(agentsDir(store), { recursive: true });
  const agentWatcher = watch(agentsDir(store), () => {
    if (agentScheduled) return;
    agentScheduled = true;
    setImmediate(refreshAgent);
  });
  agentWatcher.on("error", (cause) => error(`agent watcher failed: ${describeError(cause)}`));
  agentPushed = JSON.stringify(await readAgent());

  return async () => {
    closed = true;
    storeWatcher.close();
    agentWatcher.close();
    for (const watcher of annotationWatchers.values()) watcher.close();
    annotationWatchers.clear();
    for (const [event, listener] of listeners) hot.off(event, listener);
    for (const upload of uploads.values()) upload.done = true;
    uploads.clear();
    await rm(serverStaging, { recursive: true, force: true });
  };
}

function channelPlugin(
  maxStoreBytes: number,
  bodies: string[],
  storeRoot: string | undefined,
): Plugin {
  let close: (() => Promise<void>) | undefined;
  return {
    name: "pk-annotator:channel",
    apply: "serve",
    config() {
      return { define: { [BODIES_GLOBAL]: JSON.stringify(bodies) } };
    },
    async configureServer(server) {
      close = await serve(server, maxStoreBytes, storeRoot);
    },
    // Vite calls buildEnd once, for the client environment, when the dev server closes.
    async buildEnd() {
      const closing = close;
      close = undefined;
      await closing?.();
    },
  };
}

/** Dev-server plugins: source attributes, the overlay channel, symbolication, and the store watcher. Nothing runs in builds or under Vitest. */
export function annotator(options: AnnotatorOptions = {}): Plugin[] {
  const parsed = AnnotatorOptions.parse(options);
  // Vitest also serves through Vite; source attributes would change rendered HTML in tests.
  if (process.env.VITEST) return [];
  return [
    sourcePlugin(),
    channelPlugin(
      parsed.maxStoreBytes ?? DEFAULT_SIZE_CAP_BYTES,
      parsed.bodies ?? [],
      parsed.storeRoot,
    ),
  ];
}
