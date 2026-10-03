import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AnnotationDraft, ClaimProcess } from "../shared/schema.ts";
import { PkaError, createClaim, createStore, listIds, removeClaim } from "../store/store.ts";
import {
  attach,
  create,
  get,
  list,
  loadAnnotation,
  loadAnnotationUpdates,
  SetStatusResult,
  reply,
  type SetStatusInput,
  validateAttachTarget,
  setStatus,
  wait,
  type WaitOptions,
} from "./ops.ts";
import { thisProcess } from "./presence.ts";
import { CONCISE_BYTES } from "./views.ts";

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

async function exitedProcess(): Promise<ClaimProcess> {
  const child = spawn(process.execPath, ["--eval", ""]);
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("node did not start");
  return { ...thisProcess(), pid: child.pid };
}

// Runs store operations in a separate Node process, one JSON command per stdin line.
const WORKER = `
import { createInterface } from "node:readline";
const ops = await import(process.argv[1]);
const store = await import(process.argv[2]);
const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  try {
    if (command.op === "hold") {
      // Holds the lock until the process is killed.
      void store.withAnnotationLock(command.store, command.id, () => {
        say({ ok: "held" });
        return new Promise(() => {});
      });
      continue;
    }
    say({ ok: await ops.setStatus(command.store, command.input, command.by) });
  } catch (error) {
    say({ error: error.message });
  }
}
`;

const WorkerReply = z.strictObject({ ok: z.unknown().optional(), error: z.string().optional() });

type WorkerCommand =
  | { op: "hold"; store: string; id: string }
  | { op?: undefined; store: string; input: SetStatusInput; by: string };

interface Worker {
  child: ReturnType<typeof spawn>;
  call: (command: WorkerCommand) => Promise<z.infer<typeof WorkerReply>>;
}

function startWorker(): Worker {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      WORKER,
      fileURLToPath(new URL("ops.ts", import.meta.url)),
      fileURLToPath(new URL("../store/store.ts", import.meta.url)),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  if (child.stdin === null || child.stdout === null) throw new Error("worker has no pipes");
  const { stdin } = child;
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    child,
    async call(command) {
      stdin.write(`${JSON.stringify(command)}\n`);
      const next = await lines.next();
      if (next.done === true) throw new Error("worker exited");
      return WorkerReply.parse(JSON.parse(next.value));
    },
  };
}

async function stopWorker(worker: Worker): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exited = once(worker.child, "exit");
  worker.child.kill("SIGKILL");
  await exited;
}

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

describe("list", () => {
  it("pages through one status with a cursor", async () => {
    for (let index = 0; index < 5; index += 1) await create(store, DRAFT);
    const ids = await listIds(store);
    for (const id of ids.filter((_, index) => index % 2 === 1)) {
      await setStatus(store, { id, status: "acknowledged" }, "agent-a");
    }
    const pending = ids.filter((_, index) => index % 2 === 0);
    const page = { status: "pending", limit: 2, cursor: undefined, detail: "concise" } as const;
    const first = await list(store, page);
    expect(first.items.map((item) => item.id)).toEqual(pending.slice(0, 2));
    expect(first.nextCursor).toBe(pending[1]);
    const second = await list(store, { ...page, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(pending.slice(2));
    expect(second.nextCursor).toBeUndefined();
  });

  it("ends a concise page at the byte budget and continues from its cursor", async () => {
    const draft = { ...DRAFT, route: `/${"r".repeat(600)}`, prompt: "p".repeat(600) };
    for (let index = 0; index < 60; index += 1) await create(store, draft);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(store, { status: "all", limit: 100, cursor, detail: "concise" });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(CONCISE_BYTES);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual(await listIds(store));
  });
});

describe("get", () => {
  it("keeps a concise annotation within the byte budget and says full returns the rest", async () => {
    const long = (length: number): string => "x".repeat(length);
    const elements = Array.from({ length: 100 }, (_, index) => ({
      n: index + 1,
      source: `src/${long(500)}.tsx:1:1`,
      owners: Array.from({ length: 12 }, () => long(300)),
      selector: { name: long(300), css: long(500) },
      html: long(5000),
      box: { x: 0, y: 0, w: 1, h: 1 },
      text: long(1000),
    }));
    const { id } = await create(store, { ...DRAFT, elements });
    const concise = await get(store, { id, detail: "concise" });
    expect(Buffer.byteLength(JSON.stringify(concise.annotation))).toBeLessThanOrEqual(
      CONCISE_BYTES,
    );
    const kept = concise.annotation.elements.map((element) => element.n);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(elements.slice(0, kept.length).map((element) => element.n));
    expect(concise.annotation.omitted).toMatchObject({
      elements: 100 - kept.length,
      attachments: 0,
      promptCharacters: 0,
      note: expect.stringContaining("detail full"),
    });
    const full = await get(store, { id, detail: "full" });
    expect(full.annotation.elements).toHaveLength(100);
    expect(full.annotation.omitted).toBeUndefined();

    // Several saved marks can combine into one long prompt; quotes double in JSON.
    const prompt = `"😀${"p".repeat(30_000)}`;
    const { id: longPrompt } = await create(store, {
      ...DRAFT,
      prompt,
      elements: elements.slice(0, 5),
    });
    const capped = (await get(store, { id: longPrompt, detail: "concise" })).annotation;
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(CONCISE_BYTES);
    expect(prompt.startsWith(capped.prompt)).toBe(true);
    expect(capped.omitted?.promptCharacters).toBe(prompt.length - capped.prompt.length);
    expect(capped.elements.length).toBeGreaterThan(0);
    expect((await get(store, { id: longPrompt, detail: "full" })).annotation.prompt).toBe(prompt);
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
    // Element-wise toEqual on 3 MB takes seconds.
    expect(
      Buffer.compare(await readFile(path.join(record.dir, "capture", "video.webm")), video),
    ).toBe(0);
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

describe("closed annotations", () => {
  it("refuse agent changes", async () => {
    const { id } = await create(store, DRAFT);
    await setStatus(store, { id, status: "acknowledged" }, "agent-a");
    await setStatus(store, { id, status: "resolved" }, "agent-a");

    await expect(reply(store, { id, text: "late" }, "agent-a")).rejects.toThrow(
      `Annotation ${id} is resolved; reply before set_status resolved`,
    );
    await expect(setStatus(store, { id, status: "dismissed" }, "agent-a")).rejects.toThrow(
      /is resolved/,
    );
    expect(await setStatus(store, { id, status: "resolved" }, "agent-b")).toEqual({
      id,
      status: "resolved",
      changed: false,
    });
    const verdict = new TextEncoder().encode("{}\n");
    await expect(
      attach(
        store,
        id,
        [{ kind: "perf", path: "capture/perf/lab.json", summary: "lab", data: verdict }],
        "agent-a",
      ),
    ).rejects.toThrow(/is resolved/);
    await expect(validateAttachTarget(store, id, "agent-a")).rejects.toThrow(/is resolved/);
    await expect(validateAttachTarget(store, "0000missing", "agent-a")).rejects.toThrow(
      "No annotation 0000missing",
    );
    expect((await loadAnnotation(store, id)).annotation.attachments).toEqual([]);
    expect((await loadAnnotation(store, id)).state.history).toHaveLength(3);
  });

  it("leave an acknowledged annotation to the session that claimed it", async () => {
    const { id } = await create(store, DRAFT);
    await setStatus(store, { id, status: "acknowledged" }, "agent-a");
    const claimed = new RegExp(`${id} was claimed by agent-a`);
    const verdict = new TextEncoder().encode("{}\n");
    const lab = {
      kind: "perf" as const,
      path: "capture/perf/lab.json",
      summary: "lab",
      data: verdict,
    };

    await expect(setStatus(store, { id, status: "resolved" }, "agent-b")).rejects.toThrow(claimed);
    await expect(reply(store, { id, text: "mine" }, "agent-b")).rejects.toThrow(claimed);
    await expect(attach(store, id, [lab], "agent-b")).rejects.toThrow(claimed);
    await expect(validateAttachTarget(store, id, "agent-b")).rejects.toThrow(claimed);
    await validateAttachTarget(store, id, "agent-a");

    await reply(store, { id, text: "Fixed the padding" }, "agent-a");
    await attach(store, id, [lab], "agent-a");
    await setStatus(store, { id, status: "resolved" }, "agent-a");
    const record = await loadAnnotation(store, id);
    expect(record.state.history.at(-1)).toMatchObject({ status: "resolved", by: "agent-a" });
    expect(record.thread.map((entry) => entry.text)).toEqual(["Fixed the padding"]);
    const { dir, state, thread } = record;
    expect(await loadAnnotationUpdates(store, id)).toEqual({ dir, state, thread });
  });
});

describe("claims", () => {
  it("let another session replace a claim whose claimant died before acknowledging", async () => {
    const { id } = await create(store, DRAFT);
    const fresh = new Date(Date.now() - 30_000).toISOString();
    const stale = new Date(Date.now() - 120_000).toISOString();
    await createClaim(store, id, { by: "agent-a", at: fresh });
    await expect(setStatus(store, { id, status: "acknowledged" }, "agent-b")).rejects.toThrow(
      `${id} was claimed by agent-a`,
    );

    await removeClaim(store, id);
    await createClaim(store, id, { by: "agent-a", at: stale });
    expect((await wait(store, OPTIONS)).annotation?.id).toBe(id);
    const results = await Promise.allSettled([
      setStatus(store, { id, status: "acknowledged" }, "agent-b"),
      setStatus(store, { id, status: "acknowledged" }, "agent-c"),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    expect(won).toHaveLength(1);
    const winner = won[0]?.value.claimedBy;
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({
      message: expect.stringContaining(`${id} was claimed by`),
    });
    expect((await loadAnnotation(store, id)).claim?.by).toBe(winner);
    expect((await readdir(path.join(store, id))).filter((name) => name.includes("claim"))).toEqual([
      "claim.json",
    ]);

    await removeClaim(store, id);
    await createClaim(store, id, { by: "agent-a", at: stale });
    await expect(setStatus(store, { id, status: "acknowledged" }, "agent-d")).rejects.toThrow(
      `${id} was claimed by agent-a`,
    );
  });

  it("offer an acknowledged annotation again once its claimant exits, for takeover", async () => {
    const exited = await exitedProcess();
    const { id } = await create(store, DRAFT);
    await setStatus(store, { id, status: "acknowledged" }, `mcp:${exited.pid}`, exited);
    expect((await wait(store, OPTIONS)).annotation?.id).toBe(id);
    await expect(reply(store, { id, text: "mine" }, "agent-b")).rejects.toThrow(
      /whose session has exited/,
    );

    const results = await Promise.allSettled([
      setStatus(store, { id, status: "acknowledged" }, "agent-b", thisProcess()),
      setStatus(store, { id, status: "acknowledged" }, "agent-c", thisProcess()),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    expect(won).toHaveLength(1);
    const winner = won[0]?.value.claimedBy ?? "";
    expect((await loadAnnotation(store, id)).claim?.by).toBe(winner);
    expect((await readdir(path.join(store, id))).filter((name) => name.includes("claim"))).toEqual([
      "claim.json",
    ]);
    await setStatus(store, { id, status: "resolved" }, winner);
  });

  it("leave a claim from another PID namespace to the age rule", async () => {
    const exited = await exitedProcess();
    const foreign = { ...exited, namespace: "linux:other-host:pid:[4026531836]" };
    const { id } = await create(store, DRAFT);
    await setStatus(store, { id, status: "acknowledged" }, `mcp:${exited.pid}`, foreign);
    expect(await wait(store, { ...OPTIONS, timeoutMs: 100 })).toEqual({ timedOut: true });
    await expect(setStatus(store, { id, status: "acknowledged" }, "agent-b")).rejects.toThrow(
      `${id} was claimed by mcp:${exited.pid}`,
    );
  });

  it("keep an acknowledge that a stalled claimant writes after another session found its claim orphaned", async () => {
    const { id } = await create(store, DRAFT);
    await createClaim(store, id, {
      by: "agent-a",
      at: new Date(Date.now() - 120_000).toISOString(),
    });
    await setStatus(store, { id, status: "acknowledged" }, "agent-a");
    await expect(setStatus(store, { id, status: "acknowledged" }, "agent-b")).rejects.toThrow(
      `${id} was claimed by agent-a`,
    );

    // A store written before claims were serialized can hold an acknowledge without a claim.
    await removeClaim(store, id);
    await expect(setStatus(store, { id, status: "acknowledged" }, "agent-b")).rejects.toThrow(
      `Annotation ${id} is acknowledged`,
    );
    expect((await loadAnnotation(store, id)).claim).toBeUndefined();
    await setStatus(store, { id, status: "resolved" }, "agent-a");
  });
});

describe("status changes", () => {
  it("from separate processes are serialized, so exactly one of acknowledge and dismiss lands", async () => {
    const workers = [startWorker(), startWorker()] as const;
    try {
      for (let trial = 0; trial < 100; trial += 1) {
        const { id } = await create(store, DRAFT);
        const results = await Promise.all([
          workers[0].call({ store, input: { id, status: "acknowledged" }, by: "agent-a" }),
          workers[1].call({ store, input: { id, status: "dismissed" }, by: "agent-b" }),
        ]);
        const changed = results.flatMap((result) => {
          const ok = SetStatusResult.optional().parse(result.ok);
          return ok?.changed === true ? [ok.status] : [];
        });
        expect(changed, JSON.stringify(results)).toHaveLength(1);
        const { state } = await loadAnnotation(store, id);
        expect(state.history.map((event) => event.status)).toEqual(["pending", ...changed]);
      }
    } finally {
      await Promise.all(workers.map(stopWorker));
    }
  });

  it("from a stalled claimant and a takeover in separate processes leave one acknowledge and its claimant", async () => {
    const workers = [startWorker(), startWorker()] as const;
    try {
      for (let trial = 0; trial < 30; trial += 1) {
        const { id } = await create(store, DRAFT);
        await createClaim(store, id, {
          by: "agent-a",
          at: new Date(Date.now() - 120_000).toISOString(),
        });
        const results = await Promise.all([
          workers[0].call({ store, input: { id, status: "acknowledged" }, by: "agent-a" }),
          workers[1].call({ store, input: { id, status: "acknowledged" }, by: "agent-b" }),
        ]);
        const winners = results.flatMap((result) => {
          const ok = SetStatusResult.optional().parse(result.ok);
          return ok?.changed === true ? [ok.claimedBy] : [];
        });
        expect(winners, JSON.stringify(results)).toHaveLength(1);
        const record = await loadAnnotation(store, id);
        expect(record.claim?.by).toBe(winners[0]);
        expect(record.state.history.map((event) => [event.status, event.by])).toEqual([
          ["pending", undefined],
          ["acknowledged", winners[0]],
        ]);
      }
    } finally {
      await Promise.all(workers.map(stopWorker));
    }
  });

  it("wait for a running lock holder and break the lock once that process is killed", async () => {
    const { id } = await create(store, DRAFT);
    const holder = startWorker();
    try {
      expect(await holder.call({ op: "hold", store, id })).toEqual({ ok: "held" });
      const lock = path.join(store, id, "state.lock");
      const settled = vi.fn();
      const acknowledged = setStatus(store, { id, status: "acknowledged" }, "agent-b").finally(
        settled,
      );
      await sleep(300);
      expect(settled).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({
        process: { pid: holder.child.pid },
      });

      await stopWorker(holder);
      expect(await acknowledged).toMatchObject({ changed: true, claimedBy: "agent-b" });
      const clean = ["annotation.json", "claim.json", "state.json"];
      expect((await readdir(path.join(store, id))).sort()).toEqual(clean);

      // A process that died while breaking a dead holder's lock left both locks.
      const dead = { token: "0123456789abcdef", process: await exitedProcess() };
      const breaker = { token: "fedcba9876543210", process: await exitedProcess() };
      await writeFile(lock, JSON.stringify(dead));
      await writeFile(`${lock}.${dead.token}.break`, JSON.stringify(breaker));
      expect(await setStatus(store, { id, status: "resolved" }, "agent-b")).toMatchObject({
        changed: true,
      });
      expect((await readdir(path.join(store, id))).sort()).toEqual(clean);
    } finally {
      await stopWorker(holder);
    }
  });
});

describe("attach", () => {
  const data = new TextEncoder().encode("{}\n");
  const perf = (file: string) => ({ kind: "perf" as const, path: file, summary: "lab", data });

  it("refuses paths outside capture/ and a symlinked capture directory", async () => {
    const { id } = await create(store, DRAFT);
    for (const file of [
      "../escape.json",
      "capture/../../escape.json",
      "notes.json",
      "/tmp/x.json",
    ]) {
      await expect(attach(store, id, [perf(file)], "agent-a")).rejects.toThrow(PkaError);
    }
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(store, id, "capture"));
    await expect(attach(store, id, [perf("capture/perf/lab.json")], "agent-a")).rejects.toThrow(
      /symlink/,
    );
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(root)).toEqual(["_interim", "outside"]);
    expect((await get(store, { id, detail: "full" })).annotation.attachments).toEqual([]);
  });

  it("adds every file or none, never overwrites, and get lists the result", async () => {
    const { id } = await create(store, DRAFT);
    const perfDir = path.join(store, id, "capture", "perf");
    await mkdir(perfDir, { recursive: true });
    await writeFile(path.join(perfDir, "old.json"), data);
    await expect(
      attach(store, id, [perf("capture/perf/new.json"), perf("capture/perf/old.json")], "agent-a"),
    ).rejects.toThrow(/already exists/);
    expect(await readdir(perfDir)).toEqual(["old.json"]);
    expect((await get(store, { id, detail: "full" })).annotation.attachments).toEqual([]);

    await attach(store, id, [perf("capture/perf/new.json")], "agent-a");
    expect((await readdir(perfDir)).sort()).toEqual(["new.json", "old.json"]);
    expect((await get(store, { id, detail: "full" })).annotation.attachments).toEqual([
      { kind: "perf", path: "capture/perf/new.json", summary: "lab" },
    ]);
  });
});
