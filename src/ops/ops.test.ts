import { mkdir, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnnotationDraft } from "../shared/schema.ts";
import { createStore, listIds } from "../store/store.ts";
import { create, loadAnnotation, wait, type WaitOptions } from "./ops.ts";

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
    const { id } = await create(store, DRAFT);
    const result = await wait(store, OPTIONS);
    expect(result.annotation?.id).toBe(id);
    expect(await openWatchers()).toBe(0);
  });

  it("wakes when a new annotation is written", async () => {
    const pending = wait(store, OPTIONS);
    await sleep(50);
    expect(await openWatchers()).toBe(1);
    const { id } = await create(store, DRAFT);
    expect((await pending).annotation?.id).toBe(id);
    expect(await openWatchers()).toBe(0);
  });

  it("times out as a normal result and closes the watcher", async () => {
    const result = await wait(store, { ...OPTIONS, timeoutMs: 100 });
    expect(result).toEqual({ timedOut: true });
    expect(await openWatchers()).toBe(0);
  });
});

describe("create", () => {
  it("moves chunks staged on disk into place with the annotation in one rename", async () => {
    const staging = path.join(store, ".staging", "request-1");
    await mkdir(path.join(staging, "capture"), { recursive: true });
    const video = new Uint8Array(3 * 1024 * 1024).map((_, index) => index % 251);
    const handle = await open(path.join(staging, "capture", "video.webm"), "wx");
    for (let offset = 0; offset < video.length; offset += 512 * 1024) {
      await handle.write(video.subarray(offset, offset + 512 * 1024), 0, undefined, offset);
    }
    await handle.close();
    expect(await listIds(store)).toEqual([]);

    const draft: AnnotationDraft = {
      ...DRAFT,
      attachments: [{ kind: "video", path: "capture/video.webm", summary: "3 MB" }],
    };
    const { id } = await create(store, draft, { dir: staging, paths: ["capture/video.webm"] });
    const record = await loadAnnotation(store, id);
    expect(record.state.status).toBe("pending");
    expect(new Uint8Array(await readFile(path.join(record.dir, "capture", "video.webm")))).toEqual(
      video,
    );
    expect(await readdir(path.join(store, ".staging"))).toEqual([]);

    const missing = path.join(store, ".staging", "request-2");
    await mkdir(missing);
    await expect(
      create(store, draft, { dir: missing, paths: ["capture/video.webm"] }),
    ).rejects.toThrow();
    expect(await listIds(store)).toEqual([id]);
    expect(await readdir(path.join(store, ".staging"))).toEqual([]);
  });
});
