// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ErrorsMessage } from "../shared/channel.ts";
import { ErrorGroup } from "../shared/schema.ts";
import { TimelineEntry } from "../shared/timeline.ts";
import { fingerprintError } from "./errors.ts";
import { createCapture, type Capture } from "./index.ts";
import { MAX_BODY_BYTES, MAX_URL } from "./network.ts";
import { MAX_CALL_CHARS } from "./serialize.ts";

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

  it("bounds the JSON text of one call, escapes, keys, descriptions, and arguments included", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const current = start();
    const long = "v".repeat(5000);
    const calls: unknown[][] = [
      Array.from({ length: 40 }, () => long),
      Array.from({ length: 40 }, () => "\u0001".repeat(5000)),
      Array.from({ length: 40 }, () => '"'.repeat(5000)),
      [Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`${index}${long}`, 1]))],
      [Array.from({ length: 40 }, () => Object.defineProperty(() => {}, "name", { value: long }))],
      [new Map(Array.from({ length: 40 }, (_, index) => [index, long]))],
      Array.from({ length: 10_000 }, () => "x"),
    ];
    for (const args of calls) console.log(...args);

    const entries = current.snapshot().console;
    expect(entries).toHaveLength(calls.length);
    for (const entry of entries) {
      expect(JSON.stringify(entry.args).length).toBeLessThanOrEqual(MAX_CALL_CHARS);
    }
    // Every call but the many short arguments fills most of the budget before its note.
    for (const entry of entries.slice(0, -1)) {
      expect(JSON.stringify(entry.args).length).toBeGreaterThan(MAX_CALL_CHARS - 200);
    }
    expect(entries[1]?.args.at(-1)).toMatch(/^\[\+\d+ args\]$/);
    expect(entries[3]?.args[0]).toMatchObject({ "…": expect.stringMatching(/keys\]$/) });
    const many = entries.at(-1)?.args ?? [];
    expect(many).toHaveLength(51);
    expect(many[50]).toBe("[+9950 args]");
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

  it("leaves errors raised through the overlay's chunks and no app file out of the groups", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const current = start();
    const react =
      "    at flushSync (http://localhost:3000/node_modules/.vite/deps/react-dom.js:92:5)";
    const overlay =
      "    at new ey (http://localhost:3000/node_modules/.vite/deps/pka-overlay-composer-A9J7FDgN-CFU8JGoe.js:197:9)";
    const app = "    at onClick (http://localhost:3000/src/routes/lab.tsx:70:19)";
    const raise = (...frames: string[]): void => {
      const error = new Error("raised");
      error.stack = ["Error: raised", ...frames].join("\n");
      console.error(error);
    };
    raise(react, overlay);
    raise(react, overlay, app);
    expect(current.snapshot().console).toHaveLength(2);
    expect(current.snapshot().groups.map((group) => group.topFrame)).toEqual([
      "/src/routes/lab.tsx:70",
    ]);
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
      const type = url.includes("/plain") ? "text/plain;charset=UTF-8" : "application/json";
      return new Response(body, {
        headers: { "content-type": type, "content-length": String(body.length) },
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
    // A string body is sent as text/plain unless the page declares a type.
    await fetch("/api/plain", { method: "POST", body: '{"user":"paul","password":"hunter2"}' });
    // Overlay requests go around capture.
    await current.fetch("/api/overlay-source.js");
    await vi.waitFor(() => expect(current.snapshot().requests[0]?.state).toBe("done"));

    await vi.waitFor(() => expect(current.snapshot().requests[4]?.state).toBe("done"));
    expect(current.snapshot().requests).toHaveLength(5);
    const [login, other, big, crossOrigin, plain] = current.snapshot().requests;
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
    expect(JSON.parse(plain?.requestBody ?? "")).toEqual({ user: "paul", password: "[redacted]" });
    expect(JSON.parse(plain?.responseBody ?? "")).toEqual({ ok: true, access_token: "[redacted]" });
    for (const entry of current.snapshot().requests) {
      expect(TimelineEntry.parse(entry)).toEqual(entry);
    }
  });

  it.each(["sync", "async"])(
    "keeps later wrappers on stop and records a kept fetch reference only in the running capture, with a %s library wrapper",
    async (mode) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const native = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
      );
      vi.stubGlobal("fetch", native);
      // Lets restoreAllMocks put back the prototype's own send after this test replaces it.
      vi.spyOn(XMLHttpRequest.prototype, "send");
      const first = start();
      const held = globalThis.fetch;
      const downstream = async (...args: Parameters<typeof fetch>) => {
        if (mode === "async") await Promise.resolve();
        return held(...args);
      };
      globalThis.fetch = downstream;
      const log = console.log;
      const laterLog = (...args: unknown[]) => log(...args);
      console.log = laterLog;
      const send = XMLHttpRequest.prototype.send;
      const laterSend = function (
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null,
      ) {
        send.call(this, body);
      };
      XMLHttpRequest.prototype.send = laterSend;
      first.stop();
      expect(globalThis.fetch).toBe(downstream);
      expect(console.log).toBe(laterLog);
      expect(XMLHttpRequest.prototype.send).toBe(laterSend);

      await held("/api/stopped");
      console.log("stopped");
      expect(first.snapshot().requests).toHaveLength(0);
      expect(first.snapshot().console).toHaveLength(0);

      const second = createCapture({ send: () => {}, bodies: [] });
      capture = second;
      await held("/api/items");
      await fetch("/api/global");
      await second.fetch("/api/untracked");
      // A page may reuse one init for concurrent calls, or pass a Request as the init.
      const shared = { method: "POST" };
      // Cross-origin calls get no traceparent, so the init reaches the wrapped fetch unchanged.
      await Promise.all([
        fetch("https://example.com/a", shared),
        fetch("https://example.com/b", shared),
      ]);
      const request = new Request("https://example.com/x", { method: "PUT" });
      await fetch("https://example.com/x", request);
      expect(native).toHaveBeenCalledTimes(7);
      expect(native.mock.calls.at(-1)?.[1]).toBe(request);
      expect(first.snapshot().requests).toHaveLength(0);
      expect(second.snapshot().requests.map((entry) => new URL(entry.url).pathname)).toEqual([
        "/api/items",
        "/api/global",
        "/a",
        "/b",
        "/x",
      ]);
    },
  );

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

describe("request metadata", () => {
  it("cuts huge request and resource error URLs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("ok"));
    const current = start();
    const huge = `data:image/png;base64,${"A".repeat(1_000_000)}`;
    await fetch(huge);
    const image = document.createElement("img");
    image.setAttribute("src", huge);
    document.body.append(image);
    image.dispatchEvent(new Event("error"));
    image.remove();

    const [request] = current.snapshot().requests;
    const [error] = current.snapshot().errors;
    expect(request?.url.length).toBeLessThan(MAX_URL + 20);
    expect(error?.resource?.url.length).toBeLessThan(MAX_URL + 20);
    expect(error?.message.length).toBeLessThan(MAX_URL + 40);
  });

  it("gives each resource timing to the request sent closest before it", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const queued: object[] = [];
    class Timing {
      initiatorType = "fetch";
      responseEnd = 1;
      transferSize = 300;
      decodedBodySize = 120;
      serverTiming = [];
      constructor(
        readonly name: string,
        readonly startTime: number,
        readonly duration: number,
      ) {}
    }
    vi.stubGlobal("PerformanceResourceTiming", Timing);
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        observe(): void {}
        disconnect(): void {}
        takeRecords(): object[] {
          return queued.splice(0);
        }
      },
    );
    let release: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", async (input: string) =>
      input.includes("slow")
        ? new Promise<Response>((resolve) => (release = resolve))
        : new Response("ok"),
    );
    const current = start();
    const url = `${location.origin}/api/same`;

    clock = 100;
    await fetch("/api/same");
    clock = 200;
    await fetch("/api/same");
    // Only the later request's timing arrives; the earlier one keeps waiting.
    queued.push(new Timing(url, 200.2, 7));
    clock = 210;
    expect(current.snapshot().requests.map((request) => request.durationMs)).toEqual([0, 7]);

    clock = 300;
    const slow = fetch("/api/slow");
    const slowUrl = `${location.origin}/api/slow`;
    queued.push(new Timing(slowUrl, 300.1, 40));
    clock = 320;
    expect(current.snapshot().requests[2]).toMatchObject({ state: "pending" });
    release(new Response("late"));
    await slow;
    clock = 345;
    const [early, later, settled] = current.snapshot().requests;
    expect(settled).toMatchObject({ durationMs: 40, performanceMs: 300, responseSize: 120 });
    expect(later).toMatchObject({ durationMs: 7, performanceMs: 200, transferSize: 300 });
    expect(early).toMatchObject({ durationMs: 0, performanceMs: 100 });
    expect(early?.transferSize).toBeUndefined();
  });

  it("settles a synchronous XMLHttpRequest whose send throws, and reads no body it cannot keep", () => {
    const proto = XMLHttpRequest.prototype;
    vi.spyOn(proto, "open").mockImplementation(() => {});
    vi.spyOn(proto, "setRequestHeader").mockImplementation(() => {});
    const sendSpy = vi.spyOn(proto, "send");
    const text = vi.spyOn(proto, "responseText", "get").mockReturnValue("x".repeat(100));
    const current = start();

    sendSpy.mockImplementation(() => {
      throw new DOMException("Failed to load", "NetworkError");
    });
    const failing = new XMLHttpRequest();
    failing.open("POST", "/api/sync", false);
    expect(() => failing.send("{}")).toThrow("Failed to load");

    sendSpy.mockImplementation(() => {});
    const outside = new XMLHttpRequest();
    outside.open("GET", "/other/report");
    outside.send();
    outside.dispatchEvent(new Event("load"));

    const [sync, report] = current.snapshot().requests;
    expect(sync).toMatchObject({ state: "failed", error: expect.stringContaining("NetworkError") });
    expect(report).toMatchObject({ state: "done" });
    expect(text).not.toHaveBeenCalled();
  });
});

describe("actions", () => {
  it("stamps event time and merges a run of typing into one entry that spans it", () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const current = start();
    const field = document.createElement("input");
    field.setAttribute("aria-label", "Search");
    document.body.append(field);
    for (const at of [1000, 1100, 1450]) {
      clock = at;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    clock = 1500;
    field.dispatchEvent(new Event("click", { bubbles: true }));
    field.remove();

    const actions = current.snapshot().actions.filter((entry) => entry.kind === "action");
    expect(actions).toMatchObject([
      { type: "input", performanceMs: 1000, durationMs: 450 },
      { type: "click", performanceMs: 1500 },
    ]);
    for (const entry of actions) expect(TimelineEntry.parse(entry)).toEqual(entry);
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
