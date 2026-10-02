// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  NetworkLine,
  RECORDING,
  RecordingErrors,
  RecordingManifestDraft,
} from "../../shared/recording.ts";
import { TimelineEntry } from "../../shared/timeline.ts";
import { buildRecording } from "./files.ts";

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
