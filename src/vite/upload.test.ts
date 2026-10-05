import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { createServer, type ViteDevServer } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CHANNEL,
  CreatedMessage,
  CreateFailedMessage,
  FileWrittenMessage,
  UploadReadyMessage,
  type ChannelEvents,
} from "../shared/channel.ts";
import * as ops from "../ops/ops.ts";
import { buildRecording } from "../overlay/recording/files.ts";
import * as symbolication from "./symbolicate.ts";
import { annotator } from "./index.ts";

const Message = z.strictObject({ type: z.literal("custom"), event: z.string(), data: z.unknown() });
type Message = z.infer<typeof Message>;
let root: string;
let server: ViteDevServer;
let socket: WebSocket;
let messages: Message[];
let wake: () => void;

beforeEach(async () => {
  await mkdir("/tmp/pk-annotator", { recursive: true });
  root = await mkdtemp("/tmp/pk-annotator/upload-test-");
  vi.stubEnv("VITEST", "");
  const plugins = annotator({ storeRoot: root });
  vi.unstubAllEnvs();
  server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    plugins,
    server: { host: "127.0.0.1", port: 0 },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const address = z
    .strictObject({ address: z.string(), family: z.string(), port: z.number().int() })
    .parse(server.httpServer?.address());
  socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/?token=${server.config.webSocketToken}`,
    "vite-hmr",
  );
  messages = [];
  wake = () => {};
  socket.addEventListener("message", (event) => {
    const parsed = Message.safeParse(JSON.parse(String(event.data)));
    if (parsed.success) {
      messages.push(parsed.data);
      wake();
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Test websocket failed")), {
      once: true,
    });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  socket?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

async function receive(event: string): Promise<Message> {
  const take = () => {
    const index = messages.findIndex((message) => message.event === event);
    return index < 0 ? undefined : messages.splice(index, 1)[0];
  };
  const buffered = take();
  if (buffered !== undefined) return buffered;
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<Message>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`No ${event} message`)), 3000);
    wake = () => {
      const message = take();
      if (message !== undefined) resolve(message);
    };
  }).finally(() => {
    clearTimeout(timer);
    wake = () => {};
  });
}

function send<E extends keyof ChannelEvents>(event: E, data: ChannelEvents[E]): void {
  socket.send(JSON.stringify({ type: "custom", event, data }));
}

function create(requestId: string): void {
  send(CHANNEL.create, {
    requestId,
    draft: {
      url: "http://example.test/",
      route: "/",
      prompt: "Inspect this capture",
      viewport: { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 },
      elements: [],
      attachments: [{ kind: "frame", path: "capture/frame.webp", summary: "Synthetic bytes" }],
    },
    files: [
      { path: "capture/frame.webp", bytes: 4 },
      { path: "capture/empty.txt", bytes: 0 },
    ],
  });
}

it("acknowledges staging and written chunks before committing a complete upload", async () => {
  const requestId = "upload-success";
  create(requestId);
  expect(UploadReadyMessage.parse((await receive(CHANNEL.uploadReady)).data)).toEqual({
    requestId,
  });
  send(CHANNEL.file, {
    requestId,
    path: "capture/frame.webp",
    offset: 0,
    data: Buffer.from("ab").toString("base64"),
  });
  expect(FileWrittenMessage.parse((await receive(CHANNEL.fileWritten)).data)).toEqual({
    requestId,
    path: "capture/frame.webp",
    offset: 2,
  });
  const staging = path.join(root, "_interim/annotations/.staging");
  const [serverDir] = await readdir(staging);
  expect(
    await readFile(path.join(staging, serverDir!, requestId, "capture/frame.webp"), "utf8"),
  ).toBe("ab");
  send(CHANNEL.file, {
    requestId,
    path: "capture/frame.webp",
    offset: 2,
    data: Buffer.from("cd").toString("base64"),
  });
  const created = CreatedMessage.parse((await receive(CHANNEL.created)).data);
  expect(created.requestId).toBe(requestId);
  expect(
    await readFile(
      path.join(root, "_interim/annotations", created.id, "capture/frame.webp"),
      "utf8",
    ),
  ).toBe("abcd");
  expect(
    await readFile(
      path.join(root, "_interim/annotations", created.id, "capture/empty.txt"),
      "utf8",
    ),
  ).toBe("");
});

it("rejects a sender that outruns disk acknowledgement and frees its upload slot", async () => {
  const requestId = "upload-overrun";
  create(requestId);
  await receive(CHANNEL.uploadReady);
  send(CHANNEL.file, { requestId, path: "capture/frame.webp", offset: 0, data: "YWI=" });
  send(CHANNEL.file, { requestId, path: "capture/frame.webp", offset: 2, data: "Y2Q=" });
  const failure = CreateFailedMessage.parse((await receive(CHANNEL.createFailed)).data);
  expect(failure.message).toContain("Wait for the upload acknowledgement");
  expect(
    (await readdir(path.join(root, "_interim/annotations"))).filter(
      (name) => !name.startsWith(".") && name !== "live",
    ),
  ).toEqual([]);
  create("upload-retry");
  await receive(CHANNEL.uploadReady);
  send(CHANNEL.cancelUpload, { requestId: "upload-retry" });
  expect(CreateFailedMessage.parse((await receive(CHANNEL.createFailed)).data).message).toContain(
    "cancelled",
  );
});

it("keeps the committed result when cancellation arrives during the store commit", async () => {
  const original = ops.create;
  let committing = () => {};
  let resume = () => {};
  const started = new Promise<void>((resolve) => {
    committing = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(ops, "create").mockImplementation(async (...args) => {
    committing();
    await released;
    return original(...args);
  });
  const requestId = "upload-commit-cancel";
  try {
    create(requestId);
    await receive(CHANNEL.uploadReady);
    send(CHANNEL.file, { requestId, path: "capture/frame.webp", offset: 0, data: "YWJjZA==" });
    await receive(CHANNEL.fileWritten);
    await started;
    send(CHANNEL.cancelUpload, { requestId });
    create("upload-while-committing");
    expect(CreateFailedMessage.parse((await receive(CHANNEL.createFailed)).data).requestId).toBe(
      "upload-while-committing",
    );
    resume();
    expect(CreatedMessage.parse((await receive(CHANNEL.created)).data).requestId).toBe(requestId);
    create("upload-after-commit");
    await receive(CHANNEL.uploadReady);
    send(CHANNEL.cancelUpload, { requestId: "upload-after-commit" });
    expect(CreateFailedMessage.parse((await receive(CHANNEL.createFailed)).data).requestId).toBe(
      "upload-after-commit",
    );
  } finally {
    resume();
  }
});

it("cancels recording finalization before it can commit an annotation", async () => {
  const at = "2026-10-05T00:00:00.000Z";
  const viewport = { w: 800, h: 600, dpr: 1, scrollX: 0, scrollY: 0 };
  const recording = buildRecording({
    url: "http://example.test/",
    endUrl: "http://example.test/",
    viewport,
    startedAt: at,
    endedAt: at,
    entries: [
      {
        kind: "error",
        seq: 1,
        at,
        source: "window",
        fingerprint: "fault",
        type: "Error",
        message: "Synthetic fault",
        stack: "Error: Synthetic fault",
      },
    ],
    groups: [
      {
        fingerprint: "fault",
        type: "Error",
        message: "Synthetic fault",
        count: 1,
        firstSeen: at,
        lastSeen: at,
        lastSeq: 1,
        stack: "Error: Synthetic fault",
        status: "open",
      },
    ],
    entryLimit: 10,
    entriesDropped: 0,
    frames: [],
    frameLimit: 10,
    framesDropped: 0,
    framesFailed: 0,
    bodyLimit: 1024,
    bodiesDropped: 0,
    bodies: [],
    video: { data: undefined, meta: { path: null, reason: "Video not chosen" } },
  });
  let finalizing = () => {};
  let resume = () => {};
  const started = new Promise<void>((resolve) => {
    finalizing = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(symbolication, "symbolicate").mockImplementation(async (_environment, _root, stack) => {
    finalizing();
    await released;
    return { stack, topFrame: undefined };
  });
  const commit = vi.spyOn(ops, "create");
  const requestId = "upload-finalize-cancel";
  try {
    send(CHANNEL.create, {
      requestId,
      draft: {
        url: "http://example.test/",
        route: "/",
        prompt: "Recording",
        viewport,
        elements: [],
        attachments: [{ kind: "recording", path: recording.path, summary: recording.summary }],
      },
      files: recording.files.map((file) => ({ path: file.path, bytes: file.data.size })),
    });
    await receive(CHANNEL.uploadReady);
    for (const file of recording.files) {
      if (file.data.size === 0) continue;
      send(CHANNEL.file, {
        requestId,
        path: file.path,
        offset: 0,
        data: Buffer.from(await file.data.arrayBuffer()).toString("base64"),
      });
      await receive(CHANNEL.fileWritten);
    }
    await started;
    send(CHANNEL.cancelUpload, { requestId });
    create("upload-while-finalizing");
    expect(CreateFailedMessage.parse((await receive(CHANNEL.createFailed)).data).requestId).toBe(
      "upload-while-finalizing",
    );
    resume();
    expect(CreateFailedMessage.parse((await receive(CHANNEL.createFailed)).data).requestId).toBe(
      requestId,
    );
    expect(commit).not.toHaveBeenCalled();
    expect(
      (await readdir(path.join(root, "_interim/annotations"))).filter(
        (name) => !name.startsWith(".") && name !== "live",
      ),
    ).toEqual([]);
  } finally {
    resume();
  }
});
