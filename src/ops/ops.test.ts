import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnnotationDraft } from "../shared/schema.ts";
import { createStore } from "../store/store.ts";
import { create, wait, type WaitOptions } from "./ops.ts";

const DRAFT: AnnotationDraft = {
  url: "http://localhost:3000/projects",
  route: "/projects",
  viewport: { w: 1440, h: 900, dpr: 2, scrollX: 0, scrollY: 0 },
  prompt: "Archive should confirm first",
  elements: [],
  attachments: [],
};

const OPTIONS: WaitOptions = {
  timeoutMs: 5000,
  signal: undefined,
  onProgress: undefined,
  skip: new Set(),
};

async function openWatchers(): Promise<number> {
  // A closed fs.watch handle leaves the active list once its close callback has run.
  await sleep(10);
  return process.getActiveResourcesInfo().filter((resource) => resource === "FSEventWrap").length;
}

let root: string;
let store: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pka-ops-"));
  store = await createStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("wait", () => {
  it("returns an existing pending annotation at once", async () => {
    const { id } = await create(store, DRAFT, []);
    const result = await wait(store, OPTIONS);
    expect(result.annotation?.id).toBe(id);
    expect(await openWatchers()).toBe(0);
  });

  it("wakes when a new annotation is written", async () => {
    const pending = wait(store, OPTIONS);
    await sleep(50);
    expect(await openWatchers()).toBe(1);
    const { id } = await create(store, DRAFT, []);
    expect((await pending).annotation?.id).toBe(id);
    expect(await openWatchers()).toBe(0);
  });

  it("times out as a normal result and closes the watcher", async () => {
    const result = await wait(store, { ...OPTIONS, timeoutMs: 100 });
    expect(result).toEqual({ timedOut: true });
    expect(await openWatchers()).toBe(0);
  });
});
