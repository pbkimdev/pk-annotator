import { watch } from "node:fs";
import { rm } from "node:fs/promises";

import { z } from "zod";

import {
  Annotation,
  Attachment,
  ID_PATTERN,
  Id,
  LiveErrorsSnapshot,
  State,
  Status,
  ThreadEntry,
  Timestamp,
  type AnnotationDraft,
  type AttachmentKind,
  type Claim,
  type ClaimProcess,
  type ErrorGroup,
  type StatusEvent,
} from "../shared/schema.ts";
import {
  MissingAnnotationError,
  PkaError,
  annotationFiles,
  appendJsonLine,
  createClaim,
  isErrno,
  listIds,
  liveErrorsFile,
  newId,
  placeNewFiles,
  prune as pruneStore,
  readClaim,
  readJson,
  readJsonLines,
  requireAnnotation,
  withAnnotationLock,
  writeAnnotationDir,
  writeClaim,
  writeJsonAtomic,
  type StagedFiles,
} from "../store/store.ts";
import { claimantExited } from "./presence.ts";
import {
  AnnotationView,
  Detail,
  ErrorGroupView,
  ListItem,
  annotationView,
  errorGroupView,
  listItem,
  type AnnotationRecord,
} from "./views.ts";

export const PROGRESS_INTERVAL_MS = 15_000;
/** A claim this old on a still-pending annotation lost its claimant between the claim and the state write. */
const ORPHANED_CLAIM_MS = 60_000;
const MAX_ERROR_GROUPS = 200;
/** Annotations read at once by a scan; libuv runs four file system calls in parallel by default. */
const SCAN_BATCH = 16;

const detailField = Detail.default("concise").describe(
  "concise (default) keeps the response small; full adds HTML, boxes, nearby text, summaries, history, and the thread",
);
const limitField = z.number().int().min(1).max(100).default(20);

export const ListInput = z.strictObject({
  status: z
    .enum([...Status.options, "all"])
    .default("pending")
    .describe("Filter by status; pending by default"),
  limit: limitField,
  cursor: Id.optional().describe("nextCursor from the previous page"),
  detail: detailField,
});
export type ListInput = z.output<typeof ListInput>;

export const GetInput = z.strictObject({ id: Id, detail: detailField });
export type GetInput = z.output<typeof GetInput>;

export const SetStatusInput = z.strictObject({
  id: Id,
  status: z.enum(["acknowledged", "resolved", "dismissed"]),
  note: z.string().min(1).max(2000).optional().describe("What was done, or why it was dismissed"),
});
export type SetStatusInput = z.output<typeof SetStatusInput>;

export const ReplyInput = z.strictObject({ id: Id, text: z.string().min(1).max(10_000) });
export type ReplyInput = z.output<typeof ReplyInput>;

export const ErrorsInput = z.strictObject({
  since: Timestamp.optional().describe("Only groups seen at or after this ISO time"),
  limit: limitField,
  detail: detailField,
});
export type ErrorsInput = z.output<typeof ErrorsInput>;

export const ListResult = z.strictObject({
  items: z.array(z.union([ListItem, AnnotationView])),
  nextCursor: Id.optional(),
});
export type ListResult = z.infer<typeof ListResult>;

export const GetResult = z.strictObject({ annotation: AnnotationView });
export type GetResult = z.infer<typeof GetResult>;

export const WaitResult = z.strictObject({
  timedOut: z.boolean(),
  annotation: AnnotationView.optional(),
});
export type WaitResult = z.infer<typeof WaitResult>;

export const SetStatusResult = z.strictObject({
  id: Id,
  status: Status,
  changed: z.boolean(),
  claimedBy: z.string().optional(),
});
export type SetStatusResult = z.infer<typeof SetStatusResult>;

export const ReplyResult = z.strictObject({ id: Id, entry: ThreadEntry });
export type ReplyResult = z.infer<typeof ReplyResult>;

export const ErrorsResult = z.strictObject({
  updatedAt: Timestamp.nullable().describe("null when the dev server has not recorded errors yet"),
  total: z.number().describe("Open groups that matched before the limit"),
  groups: z.array(ErrorGroupView),
});
export type ErrorsResult = z.infer<typeof ErrorsResult>;

/** Reads one annotation with its state, claim, and thread. The Vite plugin uses it to push changes. */
export async function loadAnnotation(store: string, id: string): Promise<AnnotationRecord> {
  const files = await requireAnnotation(store, id);
  const [annotation, state, claim, thread] = await Promise.all([
    readJson(store, files.annotation, Annotation),
    readJson(store, files.state, State),
    readClaim(store, id),
    readJsonLines(store, files.thread, ThreadEntry),
  ]);
  if (annotation.id !== id) {
    throw new PkaError(`${files.annotation} has id ${annotation.id}, expected ${id}`);
  }
  return { dir: files.dir, annotation, state, claim, thread };
}

/** Like loadAnnotation, but an annotation removed between listing and reading (prune, rm) is absent. */
async function loadListed(store: string, id: string): Promise<AnnotationRecord | undefined> {
  try {
    return await loadAnnotation(store, id);
  } catch (thrown) {
    if (thrown instanceof MissingAnnotationError || isErrno(thrown, "ENOENT")) return undefined;
    throw thrown;
  }
}

/** An annotation removed after listing (prune, rm) has no state. */
async function readListedState(store: string, id: string): Promise<State | undefined> {
  try {
    return await readJson(store, annotationFiles(store, id).state, State);
  } catch (thrown) {
    if (isErrno(thrown, "ENOENT")) return undefined;
    throw thrown;
  }
}

/**
 * Returns up to `want` of `ids` that `matches` accepts, in order. Ids are checked in
 * batches, so a store of resolved annotations costs one small state read per id.
 */
async function firstMatching(
  ids: readonly string[],
  want: number,
  matches: (id: string) => Promise<boolean>,
): Promise<string[]> {
  const found: string[] = [];
  for (let start = 0; start < ids.length && found.length < want; start += SCAN_BATCH) {
    const batch = ids.slice(start, start + SCAN_BATCH);
    const accepted = await Promise.all(batch.map(matches));
    found.push(...batch.filter((_, index) => accepted[index]));
  }
  return found.slice(0, want);
}

export async function list(store: string, input: ListInput): Promise<ListResult> {
  const ids = (await listIds(store)).filter(
    (id) => input.cursor === undefined || id > input.cursor,
  );
  const { status } = input;
  const matched =
    status === "all"
      ? ids.slice(0, input.limit + 1)
      : await firstMatching(
          ids,
          input.limit + 1,
          async (id) => (await readListedState(store, id))?.status === status,
        );
  const page = matched.slice(0, input.limit);
  const items: ListResult["items"] = [];
  for (let start = 0; start < page.length; start += SCAN_BATCH) {
    const records = await Promise.all(
      page.slice(start, start + SCAN_BATCH).map((id) => loadListed(store, id)),
    );
    for (const record of records) {
      // Removed or changed between the state read and this one.
      if (record === undefined || (status !== "all" && record.state.status !== status)) continue;
      items.push(input.detail === "full" ? annotationView(record, "full") : listItem(record));
    }
  }
  return { items, nextCursor: matched.length > input.limit ? page.at(-1) : undefined };
}

export async function get(store: string, input: GetInput): Promise<GetResult> {
  return { annotation: annotationView(await loadAnnotation(store, input.id), input.detail) };
}

/**
 * An open annotation's claim is orphaned when its claimant's process has exited, or, when
 * that cannot be told, when it is old and the annotation is still pending.
 */
function isOrphaned(state: State, claim: Claim, now: number): boolean {
  if (isClosed(state.status)) return false;
  if (claimantExited(claim)) return true;
  return state.status === "pending" && now - Date.parse(claim.at) > ORPHANED_CLAIM_MS;
}

function isOffered(state: State, claim: Claim | undefined): boolean {
  if (claim === undefined) return state.status === "pending";
  return isOrphaned(state, claim, Date.now());
}

async function oldestOffered(
  store: string,
  skip: ReadonlySet<string>,
): Promise<AnnotationRecord | undefined> {
  const ids = (await listIds(store)).filter((id) => !skip.has(id));
  const offered = async (id: string): Promise<boolean> => {
    const state = await readListedState(store, id);
    // Closed annotations are skipped before their claim is read.
    return (
      state !== undefined && !isClosed(state.status) && isOffered(state, await readClaim(store, id))
    );
  };
  for (let start = 0; start < ids.length; start += SCAN_BATCH) {
    for (const id of await firstMatching(
      ids.slice(start, start + SCAN_BATCH),
      SCAN_BATCH,
      offered,
    )) {
      // Claimed or changed between the scan and this read.
      const record = await loadListed(store, id);
      if (record !== undefined && isOffered(record.state, record.claim)) return record;
    }
  }
  return undefined;
}

export interface WaitOptions {
  /** Undefined waits until an annotation appears or the signal aborts. */
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
  /** Called every 15 seconds while waiting, with the elapsed milliseconds. */
  onProgress: ((elapsedMs: number) => void) | undefined;
  /** Ids already delivered to this caller. */
  skip: ReadonlySet<string>;
}

/**
 * Returns the oldest offered annotation (pending and unclaimed, or open with an orphaned
 * claim) at once if there is one.
 * Otherwise holds one fs.watch on the store until one appears, the timeout
 * elapses, or the signal aborts. The watcher and timers are released on every
 * outcome.
 */
export function wait(store: string, options: WaitOptions): Promise<WaitResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    let scanning = false;
    let rescan = false;

    // Staging directories and live/ change without offering an annotation; only an id's
    // directory appearing can.
    const watcher = watch(store, { persistent: true }, (_event, name) => {
      if (name === null || ID_PATTERN.test(name)) void scan();
    });
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => settle({ timedOut: true }, undefined), options.timeoutMs);
    const { onProgress } = options;
    const progress =
      onProgress === undefined
        ? undefined
        : setInterval(() => onProgress(Date.now() - started), PROGRESS_INTERVAL_MS);
    const onAbort = (): void => settle(undefined, signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    watcher.on("error", (cause) => settle(undefined, cause));

    function settle(result: WaitResult | undefined, cause: unknown): void {
      if (settled) return;
      settled = true;
      watcher.close();
      clearTimeout(timeout);
      clearInterval(progress);
      signal?.removeEventListener("abort", onAbort);
      if (result === undefined) reject(cause);
      else resolve(result);
    }

    async function scan(): Promise<void> {
      if (scanning) {
        rescan = true;
        return;
      }
      scanning = true;
      try {
        do {
          rescan = false;
          const record = await oldestOffered(store, options.skip);
          if (settled) return;
          if (record !== undefined) {
            settle({ timedOut: false, annotation: annotationView(record, "concise") }, undefined);
            return;
          }
        } while (rescan && !settled);
      } catch (cause) {
        settle(undefined, cause);
      } finally {
        scanning = false;
      }
    }

    // The watcher exists before the first scan, so an annotation written in between still wakes it.
    void scan();
  });
}

function isClosed(status: Status): status is "resolved" | "dismissed" {
  return status === "resolved" || status === "dismissed";
}

function closedError(id: string, status: Status): PkaError {
  return new PkaError(`Annotation ${id} is ${status}; reply before set_status ${status}.`);
}

function claimedError(id: string, claim: Claim): PkaError {
  return new PkaError(
    claimantExited(claim)
      ? `Annotation ${id} was claimed by ${claim.by} at ${claim.at}, whose session has exited. Call set_status acknowledged to take it over, then retry.`
      : `Annotation ${id} was claimed by ${claim.by} at ${claim.at}. Pick another pending annotation.`,
  );
}

// Agent writes on an acknowledged annotation belong to the session that claimed it.
function requireClaimant(id: string, claim: Claim | undefined, by: string): void {
  if (claim !== undefined && claim.by !== by) throw claimedError(id, claim);
}

/**
 * `owner` identifies a long-lived claimant's process, so its claim can be taken over once it
 * exits. The decision and the write happen under the annotation lock, so a competing change
 * from another process is either seen here or sees this one.
 */
export async function setStatus(
  store: string,
  input: SetStatusInput,
  by: string,
  owner?: ClaimProcess,
): Promise<SetStatusResult> {
  return withAnnotationLock(store, input.id, async (files) => {
    const state = await readJson(store, files.state, State);
    if (isClosed(state.status)) {
      if (state.status === input.status) {
        return { id: input.id, status: state.status, changed: false };
      }
      throw closedError(input.id, state.status);
    }
    let claim = await readClaim(store, input.id);
    const at = new Date().toISOString();
    if (input.status === "acknowledged") {
      const mine: Claim = owner === undefined ? { by, at } : { by, at, process: owner };
      let tookOver = false;
      if (claim === undefined) {
        if (state.status !== "pending") {
          throw new PkaError(
            `Annotation ${input.id} is ${state.status}. Pick another pending annotation.`,
          );
        }
        claim = (await createClaim(store, input.id, mine)).claim;
      } else if (claim.by !== by && isOrphaned(state, claim, Date.parse(at))) {
        await writeClaim(store, input.id, mine);
        claim = mine;
        tookOver = true;
      }
      requireClaimant(input.id, claim, by);
      // Same claimant: finish an acknowledge whose state write did not happen.
      if (state.status !== "pending" && !tookOver) {
        return { id: input.id, status: state.status, changed: false, claimedBy: by };
      }
    } else {
      requireClaimant(input.id, claim, by);
    }
    const event: StatusEvent = { status: input.status, at, by };
    if (input.note !== undefined) event.note = input.note;
    await writeJsonAtomic(store, files.state, {
      status: input.status,
      history: [...state.history, event],
    });
    return {
      id: input.id,
      status: input.status,
      changed: true,
      claimedBy: input.status === "acknowledged" ? by : undefined,
    };
  });
}

export async function reply(store: string, input: ReplyInput, by: string): Promise<ReplyResult> {
  return withAnnotationLock(store, input.id, async (files) => {
    const state = await readJson(store, files.state, State);
    if (isClosed(state.status)) throw closedError(input.id, state.status);
    requireClaimant(input.id, await readClaim(store, input.id), by);
    const entry: ThreadEntry = { at: new Date().toISOString(), from: "agent", text: input.text };
    await appendJsonLine(store, files.thread, entry);
    return { id: input.id, entry };
  });
}

async function readErrors(store: string): Promise<LiveErrorsSnapshot | undefined> {
  try {
    return await readJson(store, liveErrorsFile(store), LiveErrorsSnapshot);
  } catch (thrown) {
    if (isErrno(thrown, "ENOENT")) return undefined;
    throw thrown;
  }
}

export async function errors(store: string, input: ErrorsInput): Promise<ErrorsResult> {
  const snapshot = await readErrors(store);
  if (snapshot === undefined) return { updatedAt: null, total: 0, groups: [] };
  const since = input.since === undefined ? undefined : Date.parse(input.since);
  const open = snapshot.groups
    .filter(
      (group) =>
        group.status === "open" && (since === undefined || Date.parse(group.lastSeen) >= since),
    )
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
  return {
    updatedAt: snapshot.updatedAt,
    total: open.length,
    groups: open.slice(0, input.limit).map((group) => errorGroupView(group, input.detail)),
  };
}

/** Merges new or changed groups into live/errors.json by fingerprint. Used by the Vite plugin. */
export async function upsertErrorGroups(
  store: string,
  groups: ErrorGroup[],
): Promise<LiveErrorsSnapshot> {
  const merged = new Map(
    ((await readErrors(store))?.groups ?? []).map((group) => [group.fingerprint, group]),
  );
  for (const group of groups) merged.set(group.fingerprint, group);
  const snapshot: LiveErrorsSnapshot = {
    updatedAt: new Date().toISOString(),
    groups: [...merged.values()]
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
      .slice(0, MAX_ERROR_GROUPS),
  };
  await writeJsonAtomic(store, liveErrorsFile(store), snapshot);
  return snapshot;
}

/**
 * Checks the capture files an annotation declares: each under capture/, listed
 * once, and every attachment and crop path among them.
 */
export function checkCaptureFiles(draft: AnnotationDraft, paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const file of paths) {
    if (!file.startsWith("capture/")) {
      throw new PkaError(`Capture file ${file} must be under capture/`);
    }
    if (seen.has(file)) throw new PkaError(`Capture file ${file} is listed twice`);
    seen.add(file);
  }
  const referenced = [
    ...draft.attachments.map((attachment) => attachment.path),
    ...draft.elements.flatMap((element) => (element.crop === undefined ? [] : [element.crop])),
  ];
  const missing = referenced.filter((reference) => !seen.has(reference));
  if (missing.length > 0) {
    throw new PkaError(`Annotation references files that were not sent: ${missing.join(", ")}`);
  }
}

/**
 * Writes a new pending annotation. Capture files are staged on disk by the
 * Vite plugin and move into place with the annotation in one directory rename.
 */
export async function create(
  store: string,
  draft: AnnotationDraft,
  staged?: StagedFiles,
): Promise<{ id: string }> {
  checkCaptureFiles(draft, staged?.paths ?? []);
  const now = new Date();
  const id = newId(now.getTime());
  const annotation = Annotation.parse({ id, createdAt: now.toISOString(), ...draft });
  const state: State = {
    status: "pending",
    history: [{ status: "pending", at: now.toISOString() }],
  };
  await writeAnnotationDir(
    store,
    id,
    [
      { path: "annotation.json", data: `${JSON.stringify(annotation, null, 2)}\n` },
      { path: "state.json", data: `${JSON.stringify(state, null, 2)}\n` },
    ],
    staged,
  );
  return { id };
}

export interface AttachFile {
  kind: AttachmentKind;
  /** Relative to the annotation directory; must be under capture/ and new. */
  path: string;
  summary: string;
  data: Uint8Array;
}

/**
 * Adds files to an existing annotation's capture/ directory and lists them in
 * annotation.json. An agent write: resolved and dismissed annotations refuse
 * it. Existing files are never overwritten; on any failure no new file stays
 * behind and annotation.json is unchanged.
 */
export async function attach(
  store: string,
  id: string,
  files: AttachFile[],
  by: string,
): Promise<{ id: string; attachments: Attachment[] }> {
  const added = files.map((file) => {
    const parsed = Attachment.safeParse({
      kind: file.kind,
      path: file.path,
      summary: file.summary,
    });
    if (!parsed.success) {
      throw new PkaError(`Invalid attachment ${file.path}:\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  });
  return withAnnotationLock(store, id, async (paths) => {
    const state = await readJson(store, paths.state, State);
    if (isClosed(state.status)) throw closedError(id, state.status);
    requireClaimant(id, await readClaim(store, id), by);
    const annotation = await readJson(store, paths.annotation, Annotation);
    checkCaptureFiles(
      { ...annotation, elements: [], attachments: added },
      added.map((attachment) => attachment.path),
    );
    const listed = new Set(annotation.attachments.map((attachment) => attachment.path));
    const relisted = added.filter((attachment) => listed.has(attachment.path));
    if (relisted.length > 0) {
      throw new PkaError(
        `Annotation ${id} already lists ${relisted.map((a) => a.path).join(", ")}`,
      );
    }
    const placed = await placeNewFiles(
      store,
      paths.dir,
      files.map((file) => ({ path: file.path, data: file.data })),
    );
    const next: Annotation = { ...annotation, attachments: [...annotation.attachments, ...added] };
    try {
      await writeJsonAtomic(store, paths.annotation, next);
    } catch (thrown) {
      await Promise.all(placed.map((file) => rm(file, { force: true })));
      throw thrown;
    }
    return { id, attachments: next.attachments };
  });
}

export interface PruneResult {
  removed: string[];
}

export async function prune(store: string): Promise<PruneResult> {
  return { removed: await pruneStore(store, Date.now()) };
}
