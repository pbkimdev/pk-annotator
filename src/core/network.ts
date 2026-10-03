import type { RequestEntry } from "../shared/timeline.ts";
import { capString } from "./serialize.ts";

export const MAX_REQUESTS = 500;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BODY_TOTAL_BYTES = 8 * 1024 * 1024;
// A data: URL can be megabytes long; a kept URL is cut after redaction.
export const MAX_URL = 2000;
const MAX_HEADERS = 50;
const MAX_HEADER_VALUE = 1000;
// Matches authorization, proxy-authorization, cookie, set-cookie, x-api-key,
// x-csrf-token, x-xsrf-token, and other credential-bearing names.
const SECRET_HEADER = /auth|cookie|token|secret|session|api-?key|csrf|xsrf|passw/i;
const SECRET_PARAM = /token|code|state|passw|secret|key|session|auth|credential/i;
const SECRET_JSON_KEY =
  /token|secret|passw(?:or)?d|session|cookie|authorization|api[-_ ]?key|credential/i;
const TEXT_TYPE = /^\s*(?:text\/(?!event-stream)|application\/(?:[\w.-]+\+)?json\b)/i;
const EVENT_STREAM = /^\s*text\/event-stream/i;
// JSON is a finite document, so a body of unknown length is read only when it is
// JSON and not one of the streaming JSON formats.
const JSON_DOCUMENT = /^\s*application\/(?!stream\+)(?:[\w.-]+\+)?json\s*(?:;|$)/i;
// After a request settles, how long to keep looking for its resource timing entry.
const TIMING_GRACE_MS = 10_000;
// Browsers coarsen both clocks, so starts this close cannot be ordered.
const CLOCK_TOLERANCE_MS = 1;

export interface NetworkHooks {
  bodies: readonly string[];
  nextSeq: () => number;
  changed: () => void;
  added: (entry: RequestEntry) => void;
  settled: (entry: RequestEntry) => void;
  fail: (context: string, cause: unknown) => void;
}

export interface Network {
  list: () => RequestEntry[];
  resolveTimings: () => boolean;
  // The fetch this module wrapped; requests made through it are not tracked.
  untracked: typeof fetch;
  restore: () => void;
}

interface Tracked {
  entry: RequestEntry;
  start: number;
  bodyAllowed: boolean;
  bodyBytes: number;
  // Set once the request settles or opens a stream; until then its timing is not applied.
  timingUntil: number | undefined;
  // It received its timing or stopped waiting for one.
  timed: boolean;
}

type FetchRecorder = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  underlying: typeof fetch,
) => Promise<Response>;

// One capture records at a time. A fetch wrapper outlives its capture when the page keeps a
// reference to it or another library wraps it, so every wrapper sends its calls to the
// recording capture, or straight to the fetch it wrapped when none records.
let recordFetch: FetchRecorder | undefined;
// A wrapper calls the fetch it wrapped with a view of the init made for that one call,
// kept here, and with this flag set while the call runs, so an older wrapper further down
// that chain passes the request through instead of recording it again. The view marks a
// call that a library forwards after an await; the flag marks one whose library replaced
// the init. A page call that reuses the same init object is not marked.
const forwarded = new WeakSet<RequestInit>();
let forwarding = false;

// fetch reads each init member with [[Get]], own or inherited, so a Request or class
// instance passed as the init supplies its method, body, and signal through getters. A
// copy of such an init loses them; a proxy that runs its getters on the original keeps them.
function initView(init: RequestInit | undefined): RequestInit {
  if (init === undefined) return {};
  return new Proxy(init, { get: memberOf });
}

// Reads a member with the original init as the receiver of its getter.
function memberOf(init: RequestInit, key: string | symbol): RequestInit[keyof RequestInit] {
  // SAFETY: fetch reads any key it knows, including members newer than this lib's
  // RequestInit; a key the init lacks reads as undefined, as it would on the init.
  return init[key as keyof RequestInit];
}

function forward(
  underlying: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  // An empty init leaves a Request input as it is.
  const view = initView(init);
  forwarded.add(view);
  const outer = forwarding;
  forwarding = true;
  try {
    return underlying(input, view);
  } finally {
    forwarding = outer;
  }
}

type AnyBody = BodyInit | Document | null | undefined;
type XhrBody = Document | XMLHttpRequestBodyInit | null | undefined;
type HeaderRecord = RequestEntry["requestHeaders"];

interface BodyInfo {
  size?: number;
  text?: string;
}

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw, location.href);
  } catch {
    return "[invalid url]";
  }
  url.username = "";
  url.password = "";
  if (redactParams(url.searchParams)) url.search = url.searchParams.toString();
  if (url.hash.includes("=")) {
    const params = new URLSearchParams(url.hash.slice(1));
    if (redactParams(params)) url.hash = params.toString();
  }
  return capString(url.href, MAX_URL);
}

function redactParams(params: URLSearchParams): boolean {
  let redacted = false;
  for (const name of new Set(params.keys())) {
    if (!SECRET_PARAM.test(name)) continue;
    params.set(name, "REDACTED");
    redacted = true;
  }
  return redacted;
}

export function filterHeaders(headers: Headers): HeaderRecord {
  const out: HeaderRecord = {};
  let count = 0;
  for (const [name, value] of headers) {
    if (SECRET_HEADER.test(name)) continue;
    if (count === MAX_HEADERS) break;
    out[name] = value.length > MAX_HEADER_VALUE ? `${value.slice(0, MAX_HEADER_VALUE)}…` : value;
    count += 1;
  }
  return out;
}

// Replaces the value of every credential-like key, at any depth, in any body that parses as
// a JSON object or array: a declared type does not show what a body holds. Bodies that do
// not parse are kept as sent; the server produced them and they explain failures.
export function redactBody(text: string): string {
  if (!/^\s*[[{]/.test(text)) return text;
  let redacted = false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (key, value) => {
      if (!SECRET_JSON_KEY.test(key)) return value;
      redacted = true;
      return "[redacted]";
    });
  } catch {
    return text;
  }
  return redacted ? JSON.stringify(parsed) : text;
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function traceparent(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `00-${hex.slice(0, 32)}-${hex.slice(32)}-01`;
}

function contentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value);
}

// Size and, when it is plain text, the text of a request body. Streams and
// FormData have no size before they are sent.
function describeBody(body: AnyBody): BodyInfo {
  if (body === null || body === undefined) return {};
  if (body instanceof URLSearchParams) return { size: utf8Length(body.toString()) };
  if (body instanceof Blob) return { size: body.size };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { size: body.byteLength };
  if (body instanceof FormData || body instanceof ReadableStream || body instanceof Document) {
    return {};
  }
  const text = String(body);
  return { size: utf8Length(text), text };
}

export function installNetwork(hooks: NetworkHooks): Network {
  const tracked: Tracked[] = [];
  // Fetch and XHR timings by redacted URL, oldest first. An observer receives
  // entries after the page's resource timing buffer is full (250 by default,
  // which a Vite dev page fills with module scripts), and reading it leaves
  // the page's own buffer untouched.
  const timings: { name: string; timing: PerformanceResourceTiming }[] = [];
  const timingObserver = new PerformanceObserver((list) => collectTimings(list.getEntries()));
  timingObserver.observe({ type: "resource" });
  let bodyTotal = 0;

  function collectTimings(entries: PerformanceEntryList): void {
    for (const timing of entries) {
      if (
        !(timing instanceof PerformanceResourceTiming) ||
        (timing.initiatorType !== "fetch" && timing.initiatorType !== "xmlhttprequest")
      ) {
        continue;
      }
      timings.push({ name: redactUrl(timing.name), timing });
      if (timings.length > MAX_REQUESTS) timings.shift();
    }
  }

  function begin(
    initiator: RequestEntry["initiator"],
    method: string,
    rawUrl: string,
    headers: Headers,
  ): Tracked {
    const start = performance.now();
    const url = new URL(rawUrl, location.href);
    const sameOrigin = url.origin === location.origin;
    const entry: RequestEntry = {
      kind: "request",
      seq: hooks.nextSeq(),
      at: new Date().toISOString(),
      performanceMs: start,
      initiator,
      method: method.toUpperCase(),
      url: redactUrl(url.href),
      state: "pending",
      stream: false,
      serverFn: headers.has("x-tsr-serverfn") || url.pathname.includes("/_serverFn/"),
      requestHeaders: {},
      responseHeaders: {},
    };
    if (sameOrigin && !headers.has("traceparent")) {
      entry.traceparent = traceparent();
      headers.set("traceparent", entry.traceparent);
    }
    entry.requestHeaders = filterHeaders(headers);
    const item: Tracked = {
      entry,
      start,
      bodyAllowed: sameOrigin && hooks.bodies.some((prefix) => url.pathname.startsWith(prefix)),
      bodyBytes: 0,
      timingUntil: undefined,
      timed: false,
    };
    tracked.push(item);
    if (tracked.length > MAX_REQUESTS) bodyTotal -= tracked.shift()?.bodyBytes ?? 0;
    hooks.added(entry);
    hooks.changed();
    return item;
  }

  function recordRequestBody(item: Tracked, body: AnyBody, contentType: string | null): void {
    const { size, text } = describeBody(body);
    if (size !== undefined) item.entry.requestSize = size;
    const type = contentType ?? (text === undefined ? "" : "text/plain");
    if (item.bodyAllowed && text !== undefined && TEXT_TYPE.test(type)) {
      storeBody(item, "requestBody", redactBody(text));
    }
  }

  // Keeps the newest bodies: when the total would pass the cap, bodies are
  // dropped from the oldest requests first.
  function storeBody(item: Tracked, field: "requestBody" | "responseBody", text: string): void {
    const bytes = utf8Length(text);
    if (bytes > MAX_BODY_BYTES) return;
    // A body read can finish after its request left the ring. Only a recording still holds
    // that entry, so the body goes to it without counting against the ring's total.
    if (!tracked.includes(item)) {
      item.entry[field] = text;
      return;
    }
    for (const other of tracked) {
      if (bodyTotal + bytes <= MAX_BODY_TOTAL_BYTES) break;
      if (other === item || other.bodyBytes === 0) continue;
      delete other.entry.requestBody;
      delete other.entry.responseBody;
      bodyTotal -= other.bodyBytes;
      other.bodyBytes = 0;
    }
    if (bodyTotal + bytes > MAX_BODY_TOTAL_BYTES) return;
    item.entry[field] = text;
    item.bodyBytes += bytes;
    bodyTotal += bytes;
  }

  function recordResponseHead(
    item: Tracked,
    status: number,
    headers: Headers,
    responseType: string,
  ): void {
    const { entry } = item;
    entry.status = status;
    entry.responseType = responseType;
    entry.responseHeaders = filterHeaders(headers);
    const type = headers.get("content-type");
    if (type !== null) entry.contentType = type;
    const length = contentLength(headers);
    if (length !== undefined) entry.responseSize = length;
    if (type !== null && EVENT_STREAM.test(type)) {
      entry.stream = true;
      entry.state = "open";
      item.timingUntil = Number.POSITIVE_INFINITY;
    }
  }

  function settle(item: Tracked, state: RequestEntry["state"], error?: string): void {
    const now = performance.now();
    item.entry.state = state;
    item.entry.durationMs = Math.round(now - item.start);
    if (error !== undefined) item.entry.error = error;
    item.timingUntil = now + TIMING_GRACE_MS;
    hooks.settled(item.entry);
    hooks.changed();
  }

  function settleFailure(item: Tracked, cause: unknown): void {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    settle(item, aborted ? "aborted" : "failed", String(cause));
  }

  // Event streams and other streaming types are never cloned: a tee would buffer
  // an endless body in memory. Other bodies are read from a clone and given up
  // past the per-body cap, so a body of unknown length costs at most that much.
  function onFetchResponse(item: Tracked, response: Response): void {
    recordResponseHead(item, response.status, response.headers, response.type);
    if (item.entry.stream) {
      hooks.changed();
      return;
    }
    const type = item.entry.contentType ?? "";
    const length = item.entry.responseSize;
    const readable =
      item.bodyAllowed &&
      response.body !== null &&
      TEXT_TYPE.test(type) &&
      (length === undefined ? JSON_DOCUMENT.test(type) : length <= MAX_BODY_BYTES);
    const body = readable ? response.clone().body : null;
    if (body === null) {
      settle(item, "done");
      return;
    }
    hooks.changed();
    readCapped(body).then(
      (read) => {
        if (read !== undefined) {
          if (length === undefined) item.entry.responseSize = read.bytes;
          storeBody(item, "responseBody", redactBody(read.text));
        }
        settle(item, "done");
      },
      (cause) => settleFailure(item, cause),
    );
  }

  // Undefined once the body passes the cap. Cancelling one branch of a tee resolves
  // only after the other branch ends, so the cancel is not awaited.
  async function readCapped(
    body: ReadableStream<Uint8Array>,
  ): Promise<{ text: string; bytes: number } | undefined> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return { text: text + decoder.decode(), bytes };
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        reader.cancel().catch((cause: unknown) => hooks.fail("response body cancel", cause));
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  }

  const originalFetch = globalThis.fetch;
  let stopped = false;

  const recorder: FetchRecorder = (input, init, underlying) => {
    let item: Tracked;
    let nextInit = init;
    try {
      const isRequest = input instanceof Request;
      const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
      const method = init?.method ?? (isRequest ? input.method : "GET");
      item = begin("fetch", method, isRequest ? input.url : String(input), headers);
      if (item.entry.traceparent !== undefined) nextInit = { ...init, headers };
      recordRequestBody(item, init?.body, headers.get("content-type"));
    } catch (cause) {
      hooks.fail("fetch capture", cause);
      return forward(underlying, input, init);
    }
    let response: Promise<Response>;
    try {
      response = forward(underlying, input, nextInit);
    } catch (cause) {
      settleFailure(item, cause);
      throw cause;
    }
    return response.then(
      (value) => {
        try {
          onFetchResponse(item, value);
        } catch (cause) {
          hooks.fail("fetch response capture", cause);
        }
        return value;
      },
      (cause: unknown) => {
        settleFailure(item, cause);
        throw cause;
      },
    );
  };
  // Calls through this wrapper go to the fetch it replaced, never to a later global, so a
  // library that wrapped it and is called from it cannot loop.
  const fetchWrapper = function fetch(input: RequestInfo | URL, init?: RequestInit) {
    const passed = forwarding || (init !== undefined && forwarded.has(init));
    const record = passed ? undefined : recordFetch;
    return record === undefined ? originalFetch(input, init) : record(input, init, originalFetch);
  };
  recordFetch = recorder;
  globalThis.fetch = fetchWrapper;

  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetRequestHeader = proto.setRequestHeader;
  const opened = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: Headers }>();

  const inFlight = new WeakMap<XMLHttpRequest, () => void>();

  const open = function open(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    if (!stopped) {
      // Reopening an in-flight request aborts it without an abort event.
      inFlight.get(this)?.();
      opened.set(this, { method, url: String(url), headers: new Headers() });
    }
    // Omitted arguments take the defaults the two-argument form uses.
    originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  const setRequestHeader = function setRequestHeader(
    this: XMLHttpRequest,
    name: string,
    value: string,
  ) {
    originalSetRequestHeader.call(this, name, value);
    if (stopped) return;
    try {
      opened.get(this)?.headers.append(name, value);
    } catch (cause) {
      hooks.fail("XMLHttpRequest header capture", cause);
    }
  };

  const send = function send(this: XMLHttpRequest, body?: XhrBody) {
    const request = stopped ? undefined : opened.get(this);
    let sendFailed: ((cause: unknown) => void) | undefined;
    if (request !== undefined) {
      try {
        sendFailed = trackXhr(this, request, body);
      } catch (cause) {
        hooks.fail("XMLHttpRequest capture", cause);
      }
    }
    try {
      originalSend.call(this, body);
    } catch (cause) {
      sendFailed?.(cause);
      throw cause;
    }
  };

  proto.open = open;
  proto.setRequestHeader = setRequestHeader;
  proto.send = send;

  // Returns what settles the entry when send throws: a synchronous request reports its
  // network error that way, before any event.
  function trackXhr(
    xhr: XMLHttpRequest,
    request: { method: string; url: string; headers: Headers },
    body: XhrBody,
  ): (cause: unknown) => void {
    const item = begin("xhr", request.method, request.url, request.headers);
    if (item.entry.traceparent !== undefined) {
      originalSetRequestHeader.call(xhr, "traceparent", item.entry.traceparent);
    }
    recordRequestBody(item, body, request.headers.get("content-type"));
    const listening = new AbortController();
    const onHeaders = (): void => {
      if (xhr.readyState < XMLHttpRequest.HEADERS_RECEIVED) return;
      xhr.removeEventListener("readystatechange", onHeaders);
      recordResponseHead(item, xhr.status, parseRawHeaders(xhr), xhr.responseType || "text");
      hooks.changed();
    };
    const abortOnReopen = (): void => end("abort");
    function stopListening(): void {
      listening.abort();
      if (inFlight.get(xhr) === abortOnReopen) inFlight.delete(xhr);
    }
    function end(outcome: string): void {
      stopListening();
      try {
        finishXhr(xhr, item, outcome);
      } catch (cause) {
        hooks.fail("XMLHttpRequest response capture", cause);
      }
    }
    const onEnd = (event: Event): void => end(event.type);
    inFlight.set(xhr, abortOnReopen);
    xhr.addEventListener("readystatechange", onHeaders, { signal: listening.signal });
    for (const type of ["load", "error", "abort", "timeout"]) {
      xhr.addEventListener(type, onEnd, { signal: listening.signal });
    }
    return (cause) => {
      if (listening.signal.aborted) return;
      stopListening();
      settleFailure(item, cause);
    };
  }

  // Only a body that may be kept is read: serializing or counting a response of megabytes
  // takes milliseconds. Its size otherwise comes from Content-Length or its resource timing.
  function finishXhr(xhr: XMLHttpRequest, item: Tracked, outcome: string): void {
    if (outcome === "abort") return settle(item, "aborted");
    if (outcome !== "load") return settle(item, "failed", outcome);
    if (item.entry.status === undefined) {
      recordResponseHead(item, xhr.status, parseRawHeaders(xhr), xhr.responseType || "text");
    }
    const type = item.entry.contentType ?? "";
    if (
      item.bodyAllowed &&
      TEXT_TYPE.test(type) &&
      (item.entry.responseSize ?? 0) <= MAX_BODY_BYTES
    ) {
      const text = xhrText(xhr);
      // UTF-8 takes at least one byte per UTF-16 code unit, so a longer text is over the cap.
      if (text !== undefined && text.length <= MAX_BODY_BYTES) {
        item.entry.responseSize ??= utf8Length(text);
        storeBody(item, "responseBody", redactBody(text));
      }
    }
    settle(item, "done");
  }

  // A resource timing entry starts when its request is sent, so it belongs to the
  // same-URL request sent closest before it; a request still waiting for a timing that
  // never came cannot take a later request's one. A timing whose owner has not settled
  // yet stays for that owner, and one that two requests could own is dropped.
  function resolveTimings(): boolean {
    collectTimings(timingObserver.takeRecords());
    if (!tracked.some((item) => item.timingUntil !== undefined)) return false;
    const byUrl = new Map<string, Tracked[]>();
    for (const item of tracked) {
      if (item.timed) continue;
      const sameUrl = byUrl.get(item.entry.url);
      if (sameUrl === undefined) byUrl.set(item.entry.url, [item]);
      else sameUrl.push(item);
    }
    let changed = false;
    let index = 0;
    while (index < timings.length) {
      const candidate = timings[index];
      if (candidate === undefined) throw new Error(`No resource timing at index ${index}`);
      const { name, timing } = candidate;
      const candidates = (byUrl.get(name) ?? []).filter(
        (item) => !item.timed && item.start <= timing.startTime + CLOCK_TOLERANCE_MS,
      );
      let owner: Tracked | undefined;
      for (const item of candidates) {
        const gap = Math.abs(timing.startTime - item.start);
        if (owner === undefined || gap < Math.abs(timing.startTime - owner.start)) owner = item;
      }
      // Two requests sent within the tolerance could own either timing; neither gets one.
      if (
        owner !== undefined &&
        candidates.some(
          (item) => item !== owner && Math.abs(item.start - owner.start) <= CLOCK_TOLERANCE_MS,
        )
      ) {
        timings.splice(index, 1);
        continue;
      }
      if (owner?.timingUntil === undefined) {
        index += 1;
        continue;
      }
      timings.splice(index, 1);
      applyTiming(owner, timing);
      changed = true;
    }
    const now = performance.now();
    for (const item of tracked) {
      if (item.timingUntil === undefined || now <= item.timingUntil) continue;
      item.timingUntil = undefined;
      item.timed = true;
    }
    if (changed) hooks.changed();
    return changed;
  }

  return {
    list: () => tracked.map((item) => ({ ...item.entry })),
    resolveTimings,
    untracked: (input, init) => forward(originalFetch, input, init),
    // A wrapper that another library has wrapped since stays in place, passing calls
    // through: putting the original back would drop that library's wrapper.
    restore() {
      stopped = true;
      timingObserver.disconnect();
      if (recordFetch === recorder) recordFetch = undefined;
      if (globalThis.fetch === fetchWrapper) globalThis.fetch = originalFetch;
      if (proto.open === open) proto.open = originalOpen;
      if (proto.send === send) proto.send = originalSend;
      if (proto.setRequestHeader === setRequestHeader) {
        proto.setRequestHeader = originalSetRequestHeader;
      }
    },
  };
}

function applyTiming(item: Tracked, timing: PerformanceResourceTiming): void {
  const { entry } = item;
  item.timingUntil = undefined;
  item.timed = true;
  if (timing.responseEnd > 0) entry.durationMs = Math.round(timing.duration);
  if (timing.transferSize > 0) entry.transferSize = timing.transferSize;
  if (entry.responseSize === undefined && timing.decodedBodySize > 0) {
    entry.responseSize = timing.decodedBodySize;
  }
  if (timing.serverTiming.length > 0) {
    entry.serverTiming = timing.serverTiming.map(({ name, duration, description }) => ({
      name,
      duration,
      description,
    }));
  }
  if (entry.state === "open") entry.state = "done";
}

function parseRawHeaders(xhr: XMLHttpRequest): Headers {
  const headers = new Headers();
  for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return headers;
}

function xhrText(xhr: XMLHttpRequest): string | undefined {
  if (xhr.responseType === "" || xhr.responseType === "text") return xhr.responseText;
  if (xhr.responseType === "json") return JSON.stringify(xhr.response);
  return undefined;
}
