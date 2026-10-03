import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";

import { AGENTS_DIR, AgentPresence } from "../shared/agent.ts";
import { PkaError, isErrno, readJson, resolveInside, writeJsonAtomic } from "../store/store.ts";

export function agentsDir(store: string): string {
  return resolveInside(store, ...AGENTS_DIR);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to another user.
    return !isErrno(cause, "ESRCH");
  }
}

/** The presence file of one session, known before it is written so an exit can remove it. */
export function agentFile(store: string, name: string, pid: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 60);
  return resolveInside(agentsDir(store), `${slug}-${pid}.json`);
}

/** Records a connected MCP client at `file` (from agentFile). */
export async function announceAgent(
  store: string,
  file: string,
  presence: AgentPresence,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(store, file, AgentPresence.parse(presence));
}

/**
 * Removes a presence file and this process's unfinished temporary copies of it.
 * Synchronous, so it can run in a process "exit" handler.
 */
export function withdrawAgent(file: string): void {
  rmSync(file, { force: true });
  const temporary = `${path.basename(file)}.${process.pid}.`;
  try {
    for (const name of readdirSync(path.dirname(file))) {
      if (name.startsWith(temporary)) rmSync(path.join(path.dirname(file), name), { force: true });
    }
  } catch (cause) {
    if (!isErrno(cause, "ENOENT")) throw cause;
  }
}

export type LiveAgents = {
  /** Most recently connected first. */
  agents: AgentPresence[];
  /** Files that are not presence records; they are left in place. */
  invalid: Array<{ file: string; reason: string }>;
};

/** Reads the presence files and removes those whose process has exited. */
export async function liveAgents(store: string): Promise<LiveAgents> {
  const dir = agentsDir(store);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return { agents: [], invalid: [] };
    throw cause;
  }
  const result: LiveAgents = { agents: [], invalid: [] };
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = resolveInside(dir, name);
    let presence: AgentPresence;
    try {
      presence = await readJson(store, file, AgentPresence);
    } catch (cause) {
      // Removed between readdir and read: the session exited.
      if (isErrno(cause, "ENOENT")) continue;
      if (!(cause instanceof PkaError)) throw cause;
      result.invalid.push({ file, reason: cause.message });
      continue;
    }
    if (processAlive(presence.pid)) result.agents.push(presence);
    else await rm(file, { force: true });
  }
  result.agents.sort((a, b) => Date.parse(b.connectedAt) - Date.parse(a.connectedAt));
  return result;
}
