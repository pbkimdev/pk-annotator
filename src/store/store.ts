import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
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
import path from "node:path";

import { z } from "zod";

import {
  Claim,
  ID_PATTERN,
  State,
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
  const checked = [sources.claudeProjectDir, sources.cwd].filter((dir) => dir !== undefined);
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
  value: State | LiveErrorsSnapshot,
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
 * wins and a loser never reads a half-written claim.
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
    await link(temporary, files.claim);
    return { won: true, claim };
  } catch (thrown) {
    if (!isErrno(thrown, "EEXIST")) throw thrown;
    return { won: false, claim: await readJson(store, files.claim, Claim) };
  } finally {
    await unlink(temporary);
  }
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

/** Writes a complete annotation directory in a staging directory and renames it into place. */
export async function writeAnnotationDir(
  store: string,
  id: string,
  files: NewFile[],
): Promise<string> {
  const dir = annotationFiles(store, id).dir;
  const staging = resolveInside(store, `${STAGING_PREFIX}${id}`);
  await mkdir(staging);
  try {
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
