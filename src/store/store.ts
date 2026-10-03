import { randomBytes } from "node:crypto";
import { constants, readFileSync, readlinkSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import type { AgentPresence } from "../shared/agent.ts";
import {
  Claim,
  ClaimProcess,
  ID_PATTERN,
  State,
  type Annotation,
  type LiveErrorsSnapshot,
  type ThreadEntry,
} from "../shared/schema.ts";

export const STORE_SUBDIR = path.join("_interim", "annotations");
export const DEFAULT_SIZE_CAP_BYTES = 500 * 1024 * 1024;
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STAGING_PREFIX = ".creating-";
const STAGING_AGE_MS = 24 * 60 * 60 * 1000;

const CREATE_EXCLUSIVE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** An error whose message is meant for the person or agent that called the operation. */
export class PkaError extends Error {
  override name = "PkaError";
}

/** The annotation directory does not exist, for example because prune removed it. */
export class MissingAnnotationError extends PkaError {
  override name = "MissingAnnotationError";
}

export function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

export interface RootSources {
  /** `--root` or `PKA_ROOT`: a project root that must contain the store. */
  explicit: string | undefined;
  claudeProjectDir: string | undefined;
  cwd: string;
}

async function storeUnder(root: string): Promise<string | undefined> {
  const dir = path.resolve(root, STORE_SUBDIR);
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new PkaError(`${dir} exists but is not a directory`);
  } catch (thrown) {
    if (isErrno(thrown, "ENOENT")) return undefined;
    throw thrown;
  }
  return realpath(dir);
}

/**
 * Finds the annotation store without creating anything: the explicit root,
 * then CLAUDE_PROJECT_DIR, then the nearest ancestor of cwd that has one.
 */
export async function findStore(sources: RootSources): Promise<string> {
  if (sources.explicit !== undefined) {
    const store = await storeUnder(sources.explicit);
    if (store === undefined) {
      throw new PkaError(
        `No annotation store at ${path.resolve(sources.explicit, STORE_SUBDIR)}. ` +
          "Start the app's Vite dev server with the pk-annotator plugin once to create it, or pass a different --root.",
      );
    }
    return store;
  }
  if (sources.claudeProjectDir !== undefined) {
    const store = await storeUnder(sources.claudeProjectDir);
    if (store !== undefined) return store;
  }
  for (let dir = path.resolve(sources.cwd); ; dir = path.dirname(dir)) {
    const store = await storeUnder(dir);
    if (store !== undefined) return store;
    if (path.dirname(dir) === dir) break;
  }
  const checked = [
    ...new Set(
      [sources.claudeProjectDir, sources.cwd]
        .filter((dir) => dir !== undefined)
        .map((dir) => path.resolve(dir)),
    ),
  ];
  throw new PkaError(
    `No ${STORE_SUBDIR} found in ${checked.join(" or ")} or any parent directory. ` +
      "Start the app's Vite dev server with the pk-annotator plugin once to create it, or pass --root <project> (or PKA_ROOT).",
  );
}

/** Creates the store under a project root. Only the Vite plugin calls this. */
export async function createStore(projectRoot: string): Promise<string> {
  const dir = path.resolve(projectRoot, STORE_SUBDIR);
  await mkdir(path.join(dir, "live"), { recursive: true });
  return realpath(dir);
}

/** A sortable id: base-36 milliseconds, then random hex. */
export function newId(now: number): string {
  return `${now.toString(36).padStart(9, "0")}-${randomBytes(4).toString("hex")}`;
}

export function checkId(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new PkaError(
      `Invalid annotation id ${JSON.stringify(id)}: ids match ^[a-z0-9-]{8,40}$. List annotations to get a valid id.`,
    );
  }
  return id;
}

export function resolveInside(base: string, ...segments: string[]): string {
  const target = path.resolve(base, ...segments);
  const relative = path.relative(base, target);
  if (relative === "" || relative.split(path.sep)[0] === ".." || path.isAbsolute(relative)) {
    throw new PkaError(`Path ${segments.join("/")} resolves outside ${base}`);
  }
  return target;
}

/** Refuses a symlink anywhere between the store and the target. Missing components end the walk. */
async function refuseSymlinks(store: string, target: string): Promise<void> {
  let current = store;
  for (const segment of path.relative(store, target).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new PkaError(`Refusing symlink in the annotation store: ${current}`);
      }
    } catch (thrown) {
      if (isErrno(thrown, "ENOENT")) return;
      throw thrown;
    }
  }
}

export interface AnnotationFiles {
  dir: string;
  annotation: string;
  state: string;
  claim: string;
  thread: string;
}

export function annotationFiles(store: string, id: string): AnnotationFiles {
  const dir = resolveInside(store, checkId(id));
  return {
    dir,
    annotation: resolveInside(dir, "annotation.json"),
    state: resolveInside(dir, "state.json"),
    claim: resolveInside(dir, "claim.json"),
    thread: resolveInside(dir, "thread.jsonl"),
  };
}

export function liveErrorsFile(store: string): string {
  return resolveInside(store, "live", "errors.json");
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to another user.
    return !isErrno(cause, "ESRCH");
  }
}

/** Field 22 of /proc/<pid>/stat, clock ticks after boot. The command name before it may hold spaces and parentheses. */
function linuxStartTime(pid: number | "self"): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const field = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (field === undefined || !/^\d+$/.test(field)) {
    throw new Error(`Unexpected /proc/${pid}/stat: ${stat}`);
  }
  return field;
}

let ownNamespace: string | undefined;

/**
 * Names this process's PID namespace on its host. Every Linux host gives its initial
 * namespace the same inode, so the boot id tells hosts (and boots) apart.
 */
function pidNamespace(): string {
  ownNamespace ??=
    process.platform === "linux"
      ? `linux:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${readlinkSync("/proc/self/ns/pid")}`
      : `${process.platform}:${hostname()}`;
  return ownNamespace;
}

let ownProcess: ClaimProcess | undefined;

/** This process, as recorded in a claim or lock so another process can tell when it has exited. */
export function thisProcess(): ClaimProcess {
  if (ownProcess === undefined) {
    ownProcess = { pid: process.pid, namespace: pidNamespace() };
    if (process.platform === "linux") ownProcess.startTime = linuxStartTime("self");
  }
  return ownProcess;
}

/**
 * True only when this process can tell that `owner` has exited: it names a process in this
 * PID namespace, and that pid is gone or now belongs to a process started later. A process
 * from another namespace is never judged.
 */
export function processExited(owner: ClaimProcess): boolean {
  if (owner.namespace !== pidNamespace()) return false;
  if (owner.startTime !== undefined) {
    try {
      return linuxStartTime(owner.pid) !== owner.startTime;
    } catch (cause) {
      // hidepid hides other users' processes from /proc; kill() still tells.
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].some((code) => isErrno(cause, code))) throw cause;
    }
  }
  return !processAlive(owner.pid);
}

/** Throws a PkaError naming the next step when the annotation directory is absent. */
export async function requireAnnotation(store: string, id: string): Promise<AnnotationFiles> {
  const files = annotationFiles(store, id);
  try {
    const info = await lstat(files.dir);
    if (info.isSymbolicLink())
      throw new PkaError(`Refusing symlink in the annotation store: ${files.dir}`);
    if (!info.isDirectory()) throw new PkaError(`${files.dir} is not a directory`);
  } catch (thrown) {
    if (isErrno(thrown, "ENOENT")) {
      throw new MissingAnnotationError(
        `No annotation ${id}. List annotations to see the ids that exist.`,
      );
    }
    throw thrown;
  }
  return files;
}

async function readText(store: string, file: string): Promise<string> {
  await refuseSymlinks(store, file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseWith<S extends z.ZodType>(schema: S, text: string, where: string): z.infer<S> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (thrown) {
    throw new PkaError(`Invalid JSON in ${where}`, { cause: thrown });
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new PkaError(`Invalid data in ${where}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export async function readJson<S extends z.ZodType>(
  store: string,
  file: string,
  schema: S,
): Promise<z.infer<S>> {
  return parseWith(schema, await readText(store, file), file);
}

/** Reads a JSON-lines file; an absent file has no entries. */
export async function readJsonLines<S extends z.ZodType>(
  store: string,
  file: string,
  schema: S,
): Promise<Array<z.infer<S>>> {
  let text: string;
  try {
    text = await readText(store, file);
  } catch (thrown) {
    if (isErrno(thrown, "ENOENT")) return [];
    throw thrown;
  }
  return text
    .split("\n")
    .flatMap((line, index) =>
      line.trim() === "" ? [] : [parseWith(schema, line, `${file}:${index + 1}`)],
    );
}

async function writeExclusive(file: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(file, CREATE_EXCLUSIVE, 0o644);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

function temporaryName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

/** Writes through a temporary file and a rename, so readers see the old or the new content. */
export async function writeJsonAtomic(
  store: string,
  file: string,
  value: State | LiveErrorsSnapshot | Annotation | AgentPresence,
): Promise<void> {
  await refuseSymlinks(store, path.dirname(file));
  const temporary = temporaryName(file);
  try {
    await writeExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  } catch (thrown) {
    await rm(temporary, { force: true });
    throw thrown;
  }
}

export async function appendJsonLine(
  store: string,
  file: string,
  value: ThreadEntry,
): Promise<void> {
  await refuseSymlinks(store, file);
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
  } finally {
    await handle.close();
  }
}

/**
 * Claims an annotation. The claim is written to a temporary file opened with
 * O_EXCL | O_NOFOLLOW and then hard-linked into place, so exactly one caller
 * wins and a loser never reads a half-written claim. A claim that disappears
 * before the loser reads it was removed by replaceClaim, so the link is retried.
 */
export async function createClaim(
  store: string,
  id: string,
  claim: Claim,
): Promise<{ won: boolean; claim: Claim }> {
  const files = await requireAnnotation(store, id);
  const temporary = temporaryName(files.claim);
  await writeExclusive(temporary, `${JSON.stringify(claim)}\n`);
  try {
    for (;;) {
      try {
        await link(temporary, files.claim);
        return { won: true, claim };
      } catch (thrown) {
        if (!isErrno(thrown, "EEXIST")) throw thrown;
      }
      try {
        return { won: false, claim: await readJson(store, files.claim, Claim) };
      } catch (thrown) {
        if (!isErrno(thrown, "ENOENT")) throw thrown;
      }
    }
  } finally {
    await unlink(temporary);
  }
}

/** Replaces claim.json with `claim` in one rename, so it never goes missing. Hold the annotation lock. */
export async function writeClaim(store: string, id: string, claim: Claim): Promise<void> {
  const files = await requireAnnotation(store, id);
  await refuseSymlinks(store, files.claim);
  const temporary = temporaryName(files.claim);
  try {
    await writeExclusive(temporary, `${JSON.stringify(claim)}\n`);
    await rename(temporary, files.claim);
  } catch (thrown) {
    await rm(temporary, { force: true });
    throw thrown;
  }
}

/** How long a caller waits for a lock whose owner is still running before it reports it. */
const LOCK_WAIT_MS = 10_000;

const LockOwner = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{16}$/),
  process: ClaimProcess,
});
type LockOwner = z.infer<typeof LockOwner>;

async function readLockOwner(store: string, lock: string): Promise<LockOwner | undefined> {
  try {
    return await readJson(store, lock, LockOwner);
  } catch (thrown) {
    if (isErrno(thrown, "ENOENT")) return undefined;
    throw thrown;
  }
}

/**
 * Takes the lock file `lock` and returns its token. The owner record is complete before the
 * link makes it visible. A lock whose owner has exited is broken; a lock whose owner runs, or
 * cannot be judged from this PID namespace, is waited for until `deadline` and then reported,
 * never removed.
 */
async function acquireLock(store: string, lock: string, deadline: number): Promise<string> {
  const token = randomBytes(8).toString("hex");
  const temporary = temporaryName(lock);
  await writeExclusive(temporary, `${JSON.stringify({ token, process: thisProcess() })}\n`);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await link(temporary, lock);
        return token;
      } catch (thrown) {
        if (!isErrno(thrown, "EEXIST")) throw thrown;
      }
      const owner = await readLockOwner(store, lock);
      if (owner === undefined) continue;
      if (processExited(owner.process)) {
        await breakLock(store, lock, owner, deadline);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new PkaError(
          `${lock} is held by process ${owner.process.pid} (${owner.process.namespace}); retry later. ` +
            "A process in another PID namespace cannot be checked from here: remove the file only after that process has exited.",
        );
      }
      await sleep(Math.min(100, 2 ** attempt) * (0.5 + Math.random()));
    }
  } finally {
    await unlink(temporary);
  }
}

/**
 * Removes `lock` if it still names the exited owner `dead`. Breakers of one owner take turns
 * through a lock of their own, so while one rereads and removes `lock`, no other caller can
 * remove it: a breaker that read `dead` long ago finds the newer lock and leaves it.
 */
async function breakLock(
  store: string,
  lock: string,
  dead: LockOwner,
  deadline: number,
): Promise<void> {
  await withLock(store, `${lock}.${dead.token}.break`, deadline, async () => {
    if ((await readLockOwner(store, lock))?.token === dead.token) await unlink(lock);
  });
}

async function withLock<T>(
  store: string,
  lock: string,
  deadline: number,
  act: () => Promise<T>,
): Promise<T> {
  const token = await acquireLock(store, lock, deadline);
  let result: T;
  try {
    result = await act();
  } catch (thrown) {
    await releaseLock(store, lock, token);
    throw thrown;
  }
  await releaseLock(store, lock, token);
  return result;
}

async function releaseLock(store: string, lock: string, token: string): Promise<void> {
  const owner = await readLockOwner(store, lock);
  // Absent when prune removed a closed annotation's directory meanwhile.
  if (owner === undefined) return;
  if (owner.token !== token) {
    throw new Error(`${lock} was replaced by process ${owner.process.pid} while held`);
  }
  await rm(lock, { force: true });
}

/**
 * Runs `act` while this caller alone holds the annotation's state.lock, so status, claim,
 * reply, and attachment writes from separate processes never interleave. Read the state that
 * `act` decides on inside it. A crashed holder's lock is removed only once its process is
 * known to have exited.
 */
export async function withAnnotationLock<T>(
  store: string,
  id: string,
  act: (files: AnnotationFiles) => Promise<T>,
): Promise<T> {
  const files = await requireAnnotation(store, id);
  return withLock(store, resolveInside(files.dir, "state.lock"), Date.now() + LOCK_WAIT_MS, () =>
    act(files),
  );
}

/** Removes the claim so an agent can take the annotation again. */
export async function removeClaim(store: string, id: string): Promise<void> {
  const files = await requireAnnotation(store, id);
  await rm(files.claim, { force: true });
}

export async function readClaim(store: string, id: string): Promise<Claim | undefined> {
  const files = annotationFiles(store, id);
  try {
    return await readJson(store, files.claim, Claim);
  } catch (thrown) {
    if (isErrno(thrown, "ENOENT")) return undefined;
    throw thrown;
  }
}

/** Annotation ids in the store, oldest first. Symlinks and other names are skipped. */
export async function listIds(store: string): Promise<string[]> {
  const entries = await readdir(store, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export interface NewFile {
  /** Relative to the annotation directory. */
  path: string;
  data: string | Uint8Array;
}

/** Capture files the caller already wrote into a staging directory inside the store. */
export interface StagedFiles {
  dir: string;
  /** Relative to `dir`. */
  paths: string[];
}

/**
 * Writes a complete annotation directory in a staging directory and renames it
 * into place. With `staged`, that directory already holds the listed capture
 * files and becomes the annotation directory; otherwise a new one is made.
 */
export async function writeAnnotationDir(
  store: string,
  id: string,
  files: NewFile[],
  staged?: StagedFiles,
): Promise<string> {
  const dir = annotationFiles(store, id).dir;
  const staging = resolveInside(store, staged?.dir ?? `${STAGING_PREFIX}${id}`);
  try {
    if (staged === undefined) {
      await mkdir(staging);
    } else {
      for (const relative of staged.paths) {
        const file = resolveInside(staging, relative);
        await refuseSymlinks(store, file);
        if (!(await lstat(file)).isFile()) {
          throw new PkaError(`Staged capture file ${relative} is not a regular file`);
        }
      }
    }
    for (const file of files) {
      const target = resolveInside(staging, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeExclusive(target, file.data);
    }
    await rename(staging, dir);
  } catch (thrown) {
    await rm(staging, { recursive: true, force: true });
    throw thrown;
  }
  return dir;
}

/**
 * Adds files to an existing annotation directory without overwriting any:
 * each is written to a temporary file and hard-linked into place. If one
 * fails, the files already placed are removed. Returns the placed paths.
 */
export async function placeNewFiles(
  store: string,
  dir: string,
  files: NewFile[],
): Promise<string[]> {
  const placed: string[] = [];
  try {
    for (const file of files) {
      const target = resolveInside(dir, file.path);
      await refuseSymlinks(store, path.dirname(target));
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = temporaryName(target);
      try {
        await writeExclusive(temporary, file.data);
        await link(temporary, target);
      } catch (thrown) {
        if (isErrno(thrown, "EEXIST")) throw new PkaError(`${file.path} already exists in ${dir}`);
        throw thrown;
      } finally {
        await rm(temporary, { force: true });
      }
      placed.push(target);
    }
  } catch (thrown) {
    await Promise.all(placed.map((target) => rm(target, { force: true })));
    throw thrown;
  }
  return placed;
}

/**
 * Removes resolved and dismissed annotations whose last status change is
 * older than seven days, and staging directories left by a crashed writer.
 */
export async function prune(store: string, now: number): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)) {
      const staging = resolveInside(store, entry.name);
      if (now - (await lstat(staging)).mtimeMs > STAGING_AGE_MS) {
        await rm(staging, { recursive: true, force: true });
        removed.push(entry.name);
      }
      continue;
    }
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
    const files = annotationFiles(store, entry.name);
    const state = await readJson(store, files.state, State);
    const last = state.history.at(-1);
    if (last === undefined) throw new PkaError(`${files.state} has an empty history`);
    if (
      (state.status === "resolved" || state.status === "dismissed") &&
      now - Date.parse(last.at) > PRUNE_AGE_MS
    ) {
      await rm(files.dir, { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

export interface StoreSize {
  bytes: number;
  capBytes: number;
  overCap: boolean;
}

/** Total size of regular files in the store; the plugin refuses new video when it is over the cap. */
export async function checkStoreSize(
  store: string,
  capBytes = DEFAULT_SIZE_CAP_BYTES,
): Promise<StoreSize> {
  let bytes = 0;
  for (const entry of await readdir(store, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) bytes += (await lstat(path.join(entry.parentPath, entry.name))).size;
  }
  return { bytes, capBytes, overCap: bytes > capBytes };
}
