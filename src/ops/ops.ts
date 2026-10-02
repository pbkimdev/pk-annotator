import { watch } from "node:fs";

import { z } from "zod";

import {
  Annotation,
  Id,
  LiveErrorsSnapshot,
  State,
  Status,
  ThreadEntry,
  Timestamp,
  type AnnotationDraft,
  type ErrorGroup,
  type StatusEvent,
} from "../shared/schema.ts";
import {
  MissingAnnotationError,
  PkaError,
  appendJsonLine,
  createClaim,
  isErrno,
  listIds,
  liveErrorsFile,
  newId,
  prune as pruneStore,
  readClaim,
  readJson,
  readJsonLines,
  removeClaim,
  requireAnnotation,
  touchAnnotation,
  writeAnnotationDir,
  writeJsonAtomic,
  type StagedFiles,
} from "../store/store.ts";
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
const MAX_ERROR_GROUPS = 200;

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

export async function list(store: string, input: ListInput): Promise<ListResult> {
  const items: ListResult["items"] = [];
  let nextCursor: string | undefined;
  for (const id of await listIds(store)) {
    if (input.cursor !== undefined && id <= input.cursor) continue;
    const record = await loadListed(store, id);
    if (record === undefined) continue;
    if (input.status !== "all" && record.state.status !== input.status) continue;
    if (items.length === input.limit) {
      nextCursor = items.at(-1)?.id;
      break;
    }
    items.push(input.detail === "full" ? annotationView(record, "full") : listItem(record));
  }
  return { items, nextCursor };
}

export async function get(store: string, input: GetInput): Promise<GetResult> {
  return { annotation: annotationView(await loadAnnotation(store, input.id), input.detail) };
}

async function oldestPendingUnclaimed(
  store: string,
  skip: ReadonlySet<string>,
): Promise<AnnotationRecord | undefined> {
  for (const id of await listIds(store)) {
    if (skip.has(id)) continue;
    const record = await loadListed(store, id);
    if (record?.state.status === "pending" && record.claim === undefined) return record;
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
 * Returns the oldest pending, unclaimed annotation at once if there is one.
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

    const watcher = watch(store, { persistent: true }, () => void scan());
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
          const record = await oldestPendingUnclaimed(store, options.skip);
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
  return new PkaError(
    `Annotation ${id} is ${status}; reply before set_status ${status}, or ask the human to reopen it from the overlay.`,
  );
}

export async function setStatus(
  store: string,
  input: SetStatusInput,
  by: string,
): Promise<SetStatusResult> {
  const files = await requireAnnotation(store, input.id);
  const state = await readJson(store, files.state, State);
  const at = new Date().toISOString();
  let claimedBy: string | undefined;
  if (isClosed(state.status)) {
    if (state.status === input.status) {
      return { id: input.id, status: state.status, changed: false };
    }
    throw closedError(input.id, state.status);
  }
  if (input.status === "acknowledged") {
    const claim = await createClaim(store, input.id, { by, at });
    claimedBy = claim.claim.by;
    if (!claim.won) {
      if (claim.claim.by !== by) {
        throw new PkaError(
          `Annotation ${input.id} was claimed by ${claim.claim.by} at ${claim.claim.at}. Pick another pending annotation.`,
        );
      }
      // Same claimant: finish an acknowledge whose state write did not happen.
      if (state.status !== "pending") {
        return { id: input.id, status: state.status, changed: false, claimedBy };
      }
    }
  }
  const event: StatusEvent = { status: input.status, at, by };
  if (input.note !== undefined) event.note = input.note;
  await writeJsonAtomic(store, files.state, {
    status: input.status,
    history: [...state.history, event],
  });
  return { id: input.id, status: input.status, changed: true, claimedBy };
}

export async function reply(
  store: string,
  input: ReplyInput,
  from: ThreadEntry["from"],
): Promise<ReplyResult> {
  const files = await requireAnnotation(store, input.id);
  const state = await readJson(store, files.state, State);
  const closed = isClosed(state.status);
  if (closed && from === "agent") throw closedError(input.id, state.status);
  const entry: ThreadEntry = { at: new Date().toISOString(), from, text: input.text };
  await appendJsonLine(store, files.thread, entry);
  if (closed) {
    // The old claim belongs to the agent that closed it; the next agent must be able to take it.
    await removeClaim(store, input.id);
    await writeJsonAtomic(store, files.state, {
      status: "pending",
      history: [
        ...state.history,
        { status: "pending", at: entry.at, by: "human", note: "reopened by reply" },
      ],
    });
    await touchAnnotation(store, input.id);
  }
  return { id: input.id, entry };
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

export interface PruneResult {
  removed: string[];
}

export async function prune(store: string): Promise<PruneResult> {
  return { removed: await pruneStore(store, Date.now()) };
}
