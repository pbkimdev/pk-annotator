// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  NetworkLine,
  RECORDING,
  RecordingErrors,
  RecordingManifestDraft,
} from "../../shared/recording.ts";
import { TimelineEntry, type RequestEntry } from "../../shared/timeline.ts";
import type { Capture } from "../../core/index.ts";
import { setActive } from "../capture.ts";
import { attachments } from "../registry.ts";
import { buildRecording } from "./files.ts";
import { createRecorder } from "./recorder.ts";

const at = (second: number) => new Date(Date.UTC(2026, 9, 2, 12, 0, second)).toISOString();

function text(files: { path: string; data: Blob }[], path: string): Promise<string> {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`No ${path} in the recording`);
  return file.data.text();
}

describe("buildRecording", () => {
  it("writes schema-valid files and states the truncation in summary.md and manifest.json", async () => {
    const entries: TimelineEntry[] = [
      {
        kind: "action",
        seq: 10,
        at: at(1),
        type: "input",
        target: { tag: "input", testId: "lab-input", label: "Text" },
      },
      {
        kind: "action",
        seq: 11,
        at: at(2),
        type: "click",
        target: { tag: "button", testId: "lab-fetch-fail", text: "Fetch" },
      },
      {
        kind: "request",
        seq: 12,
        at: at(2),
        initiator: "fetch",
        method: "GET",
        url: `${location.origin}/api/fail`,
        state: "done",
        status: 500,
        durationMs: 12,
        stream: false,
        serverFn: false,
        requestHeaders: {},
        responseHeaders: { "content-type": "application/json" },
        contentType: "application/json",
        responseBody: '{"error":"fixture failure"}',
      },
      {
        kind: "error",
        seq: 13,
        at: at(3),
        source: "window",
        fingerprint: "Error|boom",
        type: "Error",
        message: "boom",
        stack: "Error: boom",
      },
      {
        kind: "error",
        seq: 14,
        at: at(4),
        source: "window",
        fingerprint: "Error|boom",
        type: "Error",
        message: "boom",
        stack: "Error: boom",
      },
      {
        kind: "navigation",
        seq: 15,
        at: at(5),
        type: "push",
        from: `${location.origin}/lab`,
        to: `${location.origin}/`,
      },
    ];
    const built = buildRecording({
      url: `${location.origin}/lab`,
      endUrl: `${location.origin}/`,
      viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
      startedAt: at(0),
      endedAt: at(6),
      entries,
      entryLimit: entries.length,
      entriesDropped: 3,
      frames: [{ path: "capture/frames/001.webp", seq: 11, at: at(2), data: new Blob(["webp"]) }],
      frameLimit: 200,
      framesDropped: 0,
      framesFailed: 0,
      bodyLimit: 8 * 1024 * 1024,
      bodiesDropped: 0,
      video: { data: undefined, meta: { path: null, reason: "Not chosen" } },
      groups: [],
      bodies: ["/api/"],
    });

    expect(built.path).toBe(RECORDING.summary);
    const timeline = (await text(built.files, RECORDING.timeline)).trim().split("\n");
    expect(timeline.map((line) => TimelineEntry.parse(JSON.parse(line)).seq)).toEqual([
      10, 11, 12, 13, 14, 15,
    ]);
    expect(timeline[2]).not.toContain("responseBody");
    const [request] = (await text(built.files, RECORDING.network)).trim().split("\n");
    expect(NetworkLine.parse(JSON.parse(request ?? ""))).toMatchObject({
      response: { status: 500, content: { text: '{"error":"fixture failure"}' } },
    });
    expect(
      RecordingErrors.parse(JSON.parse(await text(built.files, RECORDING.errors))).groups,
    ).toMatchObject([{ fingerprint: "Error|boom", count: 2, lastSeq: 14 }]);
    const manifest = RecordingManifestDraft.parse(
      JSON.parse(await text(built.files, RECORDING.manifest)),
    );
    expect(manifest.entries).toEqual({ recorded: 6, limit: 6, dropped: 3 });
    expect(manifest.seq).toEqual({ first: 10, last: 15 });

    const summary = await text(built.files, RECORDING.summary);
    expect(summary).toContain("**Truncated:**");
    expect(summary).toContain(
      '2. +2.0s click button "Fetch" [data-testid=lab-fetch-fail] · frames/001.webp',
    );
    expect(summary).toContain("GET /api/fail → 500 in 12 ms · after step 2");
    expect(summary.length).toBeLessThan(2500);
  });
});

describe("createRecorder", () => {
  it("keeps the bodies of a request first seen as it settles and writes the timeline in seq order", async () => {
    let tap: ((entry: TimelineEntry) => void) | undefined;
    const unused = () => {
      throw new Error("The recorder does not call this");
    };
    const capture: Capture = {
      tap(listener) {
        tap = listener;
        return () => {
          tap = undefined;
        };
      },
      snapshot: () => ({ console: [], errors: [], groups: [], requests: [], actions: [] }),
      subscribe: unused,
      clear: unused,
      markSent: unused,
      markResolved: unused,
      huntContext: unused,
      applySymbolicated: unused,
      fetch: unused,
      reactRootOptions: {},
      stop: unused,
    };
    setActive({
      mounted: { reactRootOptions: {}, setTheme: unused, unmount: unused },
      capture,
    });
    // Began before the recording, so the tap first sees it when it settles.
    const request: RequestEntry = {
      kind: "request",
      seq: 2,
      at: at(1),
      initiator: "fetch",
      method: "GET",
      url: `${location.origin}/api/items`,
      state: "pending",
      stream: false,
      serverFn: false,
      requestHeaders: {},
      responseHeaders: {},
    };
    const recorder = createRecorder();
    recorder.start();
    tap?.({ kind: "console", seq: 3, at: at(2), level: "log", args: ["after"] });
    Object.assign(request, { state: "done", status: 200, responseBody: '{"items":["alpha"]}' });
    tap?.(request);
    // The capture may drop a settled request's bodies to keep its own cap.
    delete request.responseBody;
    await recorder.stop();
    setActive(undefined);

    const recording = attachments.get().find((attachment) => attachment.kind === "recording");
    if (recording === undefined) throw new Error(`No recording: ${recorder.state.get().error}`);
    const { files } = await recording.collect();
    attachments.clear();
    const timeline = (await text(files, RECORDING.timeline)).trim().split("\n");
    expect(timeline.map((line) => TimelineEntry.parse(JSON.parse(line)).seq)).toEqual([2, 3]);
    const [line] = (await text(files, RECORDING.network)).trim().split("\n");
    expect(NetworkLine.parse(JSON.parse(line ?? ""))).toMatchObject({
      response: { status: 200, content: { text: '{"items":["alpha"]}' } },
    });
  });
});
