import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { isErrno } from "../store/store.ts";

const execFileAsync = promisify(execFile);
const REGISTRY_LATEST = "https://registry.npmjs.org/pk-annotator/latest";
const CHECK_TTL_MS = 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
// A registry range in the consumer's manifest; workspace:, link:, file:, catalog:, and Git
// specs are not managed by version, so they get no update offer.
const REGISTRY_SPEC = /^([~^]?)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
] as const;

type Manager = "pnpm" | "npm" | "yarn" | "bun";
export type Install = { dir: string; manager: Manager; dev: boolean; exact: boolean };

const Manifest = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  packageManager: z.string().optional(),
});
const Published = z.object({ version: z.string().regex(SEMVER) });

/** This module's own package.json; a self-reference resolves through its real path. */
const OWN_MANIFEST = createRequire(import.meta.url).resolve("pk-annotator/package.json");
// Read once: after a reinstall into the same path, Node keeps running this module's old code.
const RUNNING = Published.parse(JSON.parse(readFileSync(OWN_MANIFEST, "utf8"))).version;

function parseVersion(version: string) {
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`Not a semantic version: ${version}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] };
}

/** Whether `candidate` is a later release than `current`; a prerelease never outranks its release. */
export function isNewer(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  for (const [index, part] of next.core.entries()) {
    const other = now.core[index]!;
    if (part !== other) return part > other;
  }
  return next.pre === undefined && now.pre !== undefined;
}

export function installCommand(install: Install, version: string): string[] {
  const dev = { pnpm: "--save-dev", npm: "--save-dev", yarn: "--dev", bun: "--dev" }[
    install.manager
  ];
  const exact = { pnpm: "--save-exact", npm: "--save-exact", yarn: "--exact", bun: "--exact" }[
    install.manager
  ];
  return [
    install.manager,
    install.manager === "npm" ? "install" : "add",
    ...(install.dev ? [dev] : []),
    ...(install.exact ? [exact] : []),
    `pk-annotator@${version}`,
  ];
}

async function readManifest(dir: string): Promise<z.infer<typeof Manifest> | undefined> {
  const file = path.join(dir, "package.json");
  const text = await readFile(file, "utf8").catch((cause: unknown) => {
    if (isErrno(cause, "ENOENT")) return undefined;
    throw cause;
  });
  if (text === undefined) return undefined;
  const parsed = Manifest.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(`${file} is not a valid package.json: ${parsed.error.message}`);
  return parsed.data;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    (cause: unknown) => {
      if (isErrno(cause, "ENOENT")) return false;
      throw cause;
    },
  );
}

/**
 * The manifest that declares pk-annotator, from the Vite root up to the workspace root, and
 * the workspace's package manager. Null when the dependency is not a registry version, for
 * example this repository's fixture or a workspace link.
 */
async function findInstall(viteRoot: string, workspaceRoot: string): Promise<Install | null> {
  if (!OWN_MANIFEST.split(path.sep).includes("node_modules")) return null;
  let declared: Omit<Install, "manager"> | undefined;
  for (let dir = path.resolve(viteRoot); ; dir = path.dirname(dir)) {
    const manifest = await readManifest(dir);
    const dev = manifest?.devDependencies?.["pk-annotator"];
    const spec = dev ?? manifest?.dependencies?.["pk-annotator"];
    if (spec !== undefined) {
      const match = REGISTRY_SPEC.exec(spec);
      if (match === null) return null;
      declared = { dir, dev: dev !== undefined, exact: match[1] === "" };
      break;
    }
    if (dir === path.resolve(workspaceRoot) || dir === path.dirname(dir)) return null;
  }
  const field = (await readManifest(workspaceRoot))?.packageManager?.split("@")[0];
  if (field === "pnpm" || field === "npm" || field === "yarn" || field === "bun") {
    return { ...declared, manager: field };
  }
  for (const [lockfile, manager] of LOCKFILES) {
    if (await exists(path.join(workspaceRoot, lockfile))) return { ...declared, manager };
  }
  return null;
}

/** The real path of the pk-annotator manifest that `dir` resolves, read fresh from disk. */
async function resolveInstalled(dir: string): Promise<string> {
  for (let from = dir; ; from = path.dirname(from)) {
    const found = await realpath(path.join(from, "node_modules/pk-annotator/package.json")).catch(
      (cause: unknown) => {
        if (isErrno(cause, "ENOENT")) return undefined;
        throw cause;
      },
    );
    if (found !== undefined) return found;
    if (from === path.dirname(from)) throw new Error(`${dir} resolves no pk-annotator`);
  }
}

export type UpdateOffer = { current: string; latest: string };
export type InstallOutcome = "restart" | "restart-manually";

/**
 * Checks npm for a newer pk-annotator when a page mounts, at most once an hour, and installs
 * it on request with the workspace's package manager. Nothing runs between those events.
 */
export function createUpdater(
  viteRoot: string,
  workspaceRoot: string,
  warn: (line: string) => void,
) {
  let install: Promise<Install | null> | undefined;
  let checked: { at: number; latest: Promise<string | null> } | undefined;
  let installing = false;
  let staleWarned = false;

  // A failed check warns once and offers nothing until the next check is due.
  async function latest(): Promise<string | null> {
    if (checked === undefined || Date.now() - checked.at > CHECK_TTL_MS) {
      const request = fetch(REGISTRY_LATEST, { signal: AbortSignal.timeout(10_000) })
        .then(async (response) => {
          if (!response.ok) throw new Error(`${REGISTRY_LATEST} answered ${response.status}`);
          return Published.parse(await response.json()).version;
        })
        .catch((cause: unknown) => {
          warn(`update check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
          return null;
        });
      checked = { at: Date.now(), latest: request };
    }
    return checked.latest;
  }

  return {
    /** The update to offer, or null when the installed version is current or not managed by version. */
    async check(): Promise<UpdateOffer | null> {
      install ??= findInstall(viteRoot, workspaceRoot);
      if ((await install) === null) return null;
      const onDisk = Published.parse(JSON.parse(await readFile(OWN_MANIFEST, "utf8"))).version;
      if (onDisk !== RUNNING) {
        if (!staleWarned) {
          staleWarned = true;
          warn(`${onDisk} is installed but ${RUNNING} is running; restart the dev server`);
        }
        return null;
      }
      const version = await latest();
      return version !== null && isNewer(version, RUNNING)
        ? { current: RUNNING, latest: version }
        : null;
    },

    /**
     * Installs `version`, which must be the release the last check offered. "restart" means a
     * dev server restart loads it; "restart-manually" means the package was replaced in place,
     * where Node keeps the old plugin module until the process restarts.
     */
    async install(version: string): Promise<InstallOutcome> {
      const target = await install;
      if (target === undefined || target === null) {
        throw new Error("This workspace does not install pk-annotator from the npm registry");
      }
      if (checked === undefined || (await checked.latest) !== version) {
        throw new Error(`${version} is not the release last offered`);
      }
      if (installing) throw new Error("An update is already installing");
      installing = true;
      try {
        const [command, ...args] = installCommand(target, version);
        try {
          await execFileAsync(command!, args, { cwd: target.dir, timeout: INSTALL_TIMEOUT_MS });
        } catch (cause) {
          const stderr =
            cause instanceof Error && "stderr" in cause ? String(cause.stderr).trim() : "";
          const detail = stderr === "" ? String(cause) : stderr.slice(-600);
          throw new Error(`${[command, ...args].join(" ")} failed in ${target.dir}: ${detail}`, {
            cause,
          });
        }
        const resolved = await resolveInstalled(target.dir);
        const installed = Published.parse(JSON.parse(await readFile(resolved, "utf8"))).version;
        if (installed !== version) {
          throw new Error(
            `Installed ${version}, but ${target.dir} resolves pk-annotator ${installed}`,
          );
        }
        return resolved === OWN_MANIFEST ? "restart-manually" : "restart";
      } finally {
        installing = false;
      }
    },
  };
}
