// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ErrorsMessage } from "../shared/channel.ts";
import { ErrorGroup } from "../shared/schema.ts";
import { TimelineEntry } from "../shared/timeline.ts";
import { fingerprintError } from "./errors.ts";
import { createCapture, type Capture } from "./index.ts";
import { MAX_BODY_BYTES } from "./network.ts";

let capture: Capture | undefined;
const sent: ErrorsMessage[] = [];

function start(): Capture {
  // happy-dom reports automation, which would make the capture inert.
  vi.spyOn(navigator, "webdriver", "get").mockReturnValue(false);
  capture = createCapture({ send: (_event, payload) => sent.push(payload), bodies: ["/api/"] });
  return capture;
}

afterEach(() => {
  capture?.stop();
  capture = undefined;
  sent.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("console capture", () => {
  it("caps serialized arguments, marks cycles, and keeps no reference to logged objects", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const current = start();
    const logged = {
      name: "first",
      long: "x".repeat(2500),
      items: Array.from({ length: 60 }, (_, index) => index),
      keys: Object.fromEntries(Array.from({ length: 55 }, (_, index) => [`k${index}`, index])),
      deep: { a: { b: { c: { d: 1 } } } },
      self: {},
    };
    Object.assign(logged.self, { parent: logged });
    console.log("state", logged);
    logged.name = "mutated";
    logged.deep.a.b = { c: { d: 2 } };

    const [entry] = current.snapshot().console;
    expect(TimelineEntry.parse(entry)).toEqual(entry);
    expect(entry?.args[0]).toBe("state");
    expect(entry?.args[1]).toMatchObject({
      name: "first",
      long: `${"x".repeat(2000)}…[+500 chars]`,
      deep: { a: { b: "[Object]" } },
      self: { parent: "[Circular]" },
    });
    const value = JSON.parse(JSON.stringify(entry?.args[1]));
    expect(value.items).toHaveLength(51);
    expect(value.items[50]).toBe("[+10 items]");
    expect(Object.keys(value.keys)).toHaveLength(51);
    expect(value.keys["…"]).toBe("[+5 keys]");
  });
});

describe("error groups", () => {
  it("groups by in-app frames, clears with a watermark, and reopens on recurrence", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const current = start();
    // Fingerprints use the top three in-app frames, so every call enters through dispatch.
    const raise = (id: number): void => console.error(new TypeError(`row ${id} missing`));
    const handle = (id: number): void => raise(id);
    const dispatch = (id: number): void => handle(id);

    dispatch(1);
    dispatch(2);
    let [group] = current.snapshot().groups;
    expect(group).toMatchObject({ type: "TypeError", count: 2, status: "open" });
    expect(ErrorGroup.parse(group)).toEqual(group);
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(1);

    current.clear("errors");
    expect(current.snapshot().groups[0]?.status).toBe("cleared");
    expect(current.snapshot().errors).toHaveLength(0);
    dispatch(3);
    [group] = current.snapshot().groups;
    expect(group).toMatchObject({ count: 3, status: "open", message: "row 3 missing" });
    expect(current.huntContext(group?.fingerprint ?? "").error.message).toBe("row 3 missing");

    // The clear and the recurrence fall inside one throttle window: one more message.
    vi.advanceTimersByTime(999);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.groups[0]?.status).toBe("open");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows the symbolicated stack but resends the browser stack on recurrence", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const current = start();
    const raise = (): void => console.error(new Error("recurs"));
    const handle = (): void => raise();
    const dispatch = (): void => handle();
    dispatch();
    vi.advanceTimersByTime(0);
    const browserStack = sent[0]?.groups[0]?.stack;
    const fingerprint = sent[0]?.groups[0]?.fingerprint ?? "";
    current.applySymbolicated({
      groups: [
        {
          fingerprint,
          stack: "Error: recurs\n    at raise (src/a.ts:1:1)",
          topFrame: "src/a.ts:1",
        },
      ],
    });
    expect(current.snapshot().groups[0]).toMatchObject({ topFrame: "src/a.ts:1" });

    dispatch();
    vi.advanceTimersByTime(1000);
    expect(sent[1]?.groups[0]).toMatchObject({ count: 2, stack: browserStack });
    expect(sent[1]?.groups[0]?.topFrame).not.toBe("src/a.ts:1");
    expect(current.snapshot().groups[0]).toMatchObject({ topFrame: "src/a.ts:1" });
  });

  it("clears a resolved group unless it recurred after the hot update", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const current = start();
    const raise = (message: string): void => console.error(new Error(message));
    const handle = (message: string): void => raise(message);
    const dispatch = (message: string): void => handle(message);
    dispatch("fixed");
    dispatch("still broken");
    const fingerprints = current.snapshot().groups.map((group) => group.fingerprint);
    current.markSent(fingerprints);
    vi.advanceTimersByTime(10);
    const updatedAt = Date.now();
    vi.advanceTimersByTime(10);
    dispatch("still broken");
    current.markResolved(fingerprints, updatedAt);
    expect(current.snapshot().groups.map((group) => [group.message, group.status])).toEqual([
      ["fixed", "cleared"],
      ["still broken", "open"],
    ]);
    expect(current.huntContext(fingerprints[1] ?? "").error.seq).toBe(
      current.snapshot().groups[1]?.lastSeq,
    );
  });

  it("groups messages that differ only in numbers and addresses", () => {
    const vendor =
      "    at render (http://localhost:3000/node_modules/.vite/deps/react-dom.js:10:5)";
    const first = fingerprintError("Error", "user 42 at 0xdeadbeef1", vendor);
    const second = fingerprintError("Error", "user 7 at 0xc0ffee99a", vendor);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.topFrame).toBeUndefined();
  });

  it("separates different messages thrown from inline handlers with the same name", () => {
    const stack = (line: number) =>
      `Error\n    at onClick (http://localhost:3000/src/routes/lab.tsx?t=1:${line}:19)\n` +
      "    at executeDispatch (http://localhost:3000/node_modules/.vite/deps/react-dom.js:9906:5)";
    const thrown = fingerprintError("Error", "lab: click handler threw", stack(70));
    const rejected = fingerprintError("Error", "lab: unhandled rejection", stack(79));
    expect(thrown.fingerprint).not.toBe(rejected.fingerprint);
    // An edit above the throw moves the line but keeps the group.
    expect(fingerprintError("Error", "lab: click handler threw", stack(74)).fingerprint).toBe(
      thrown.fingerprint,
    );
  });
});

describe("network capture", () => {
  it("redacts headers, query values, and JSON bodies, and keeps bodies only within the allowlist and cap", async () => {
    const seen: RequestInit[] = [];
    // vitest's happy-dom globals serve fetch from a fixed getter; a stub makes it
    // a writable property, as it is in a browser.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      const url = String(input);
      const body = url.includes("/big")
        ? JSON.stringify({ data: "y".repeat(MAX_BODY_BYTES) })
        : JSON.stringify({ ok: true, access_token: "secret-value" });
      return new Response(body, {
        headers: { "content-type": "application/json", "content-length": String(body.length) },
      });
    });
    const current = start();

    await fetch("/api/login?token=abc&page=2", {
      method: "POST",
      headers: {
        authorization: "Bearer x",
        cookie: "sid=1",
        "x-api-key": "k",
        "content-type": "application/json",
      },
      body: JSON.stringify({ user: "paul", password: "hunter2", nested: { sessionId: "s" } }),
    });
    await fetch("/other/data");
    await fetch("/api/big");
    await fetch("https://example.com/api/data");
    // Overlay requests go around capture.
    await current.fetch("/api/overlay-source.js");
    await vi.waitFor(() => expect(current.snapshot().requests[0]?.state).toBe("done"));

    expect(current.snapshot().requests).toHaveLength(4);
    const [login, other, big, crossOrigin] = current.snapshot().requests;
    expect(login?.url).toBe("http://localhost:3000/api/login?token=REDACTED&page=2");
    expect(login?.requestHeaders).toEqual({
      "content-type": "application/json",
      traceparent: login?.traceparent,
    });
    expect(login?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(new Headers(seen[0]?.headers).get("traceparent")).toBe(login?.traceparent);
    expect(JSON.parse(login?.requestBody ?? "")).toEqual({
      user: "paul",
      password: "[redacted]",
      nested: { sessionId: "[redacted]" },
    });
    expect(JSON.parse(login?.responseBody ?? "")).toEqual({ ok: true, access_token: "[redacted]" });
    expect(other?.responseBody).toBeUndefined();
    expect(big?.responseBody).toBeUndefined();
    expect(big?.responseSize).toBeGreaterThan(MAX_BODY_BYTES);
    expect(crossOrigin?.traceparent).toBeUndefined();
    expect(seen[3]).toEqual({});
    for (const entry of current.snapshot().requests) {
      expect(TimelineEntry.parse(entry)).toEqual(entry);
    }
  });

  it("reads a JSON body of unknown length up to the cap, and never clones NDJSON", async () => {
    const chunked = (parts: string[], type: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
            controller.close();
          },
        }),
        { headers: { "content-type": type } },
      );
    const ndjson = chunked(['{"n":1}\n'], "application/x-ndjson");
    const clone = vi.spyOn(ndjson, "clone");
    const responses = [
      chunked(['{"ok":true,', '"access_token":"t"}'], "application/json; charset=utf-8"),
      chunked(["[", `"${"y".repeat(MAX_BODY_BYTES)}"`, "]"], "application/json"),
      ndjson,
    ];
    vi.stubGlobal("fetch", async () => responses.shift());
    const current = start();

    const small = await fetch("/api/small");
    const large = await fetch("/api/large");
    await fetch("/api/feed");
    await vi.waitFor(() =>
      expect(current.snapshot().requests.map((request) => request.state)).toEqual([
        "done",
        "done",
        "done",
      ]),
    );

    expect(await small.json()).toEqual({ ok: true, access_token: "t" });
    expect(await large.text()).toHaveLength(MAX_BODY_BYTES + 4);
    const [smallEntry, largeEntry, feedEntry] = current.snapshot().requests;
    expect(JSON.parse(smallEntry?.responseBody ?? "")).toEqual({
      ok: true,
      access_token: "[redacted]",
    });
    expect(smallEntry?.responseSize).toBe(30);
    expect(largeEntry?.responseBody).toBeUndefined();
    expect(feedEntry?.responseBody).toBeUndefined();
    expect(clone).not.toHaveBeenCalled();
  });

  it("never clones or reads an endless event stream", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(encoder.encode(`data: ${pulls}\n\n`));
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const clone = vi.spyOn(response, "clone");
    const text = vi.spyOn(response, "text");
    vi.stubGlobal("fetch", async () => response);
    const current = start();

    const received = await fetch("/api/events");
    const reader = received.body?.getReader();
    const first = await reader?.read();
    const second = await reader?.read();
    await reader?.cancel();

    expect(new TextDecoder().decode(first?.value)).toBe("data: 1\n\n");
    expect(new TextDecoder().decode(second?.value)).toBe("data: 2\n\n");
    expect(pulls).toBe(2);
    expect(clone).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(current.snapshot().requests[0]).toMatchObject({
      stream: true,
      state: "open",
      contentType: "text/event-stream",
    });
    expect(current.snapshot().requests[0]?.responseBody).toBeUndefined();
  });
});

describe("tap", () => {
  it("passes every entry to a recording after the ring buffer has dropped the oldest", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("ok"));
    const current = start();
    const tapped: TimelineEntry[] = [];
    const untap = current.tap((entry) => tapped.push(entry));

    for (let index = 0; index < 600; index += 1) console.log("line", index);
    await fetch("/api/after");
    untap();
    console.log("after untap");

    expect(current.snapshot().console).toHaveLength(500);
    expect(tapped.filter((entry) => entry.kind === "console")).toHaveLength(600);
    const requests = tapped.filter((entry) => entry.kind === "request");
    // Once when it starts and once, as the same live entry, when it settles.
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(requests[1]).toMatchObject({ state: "done" });
  });
});
