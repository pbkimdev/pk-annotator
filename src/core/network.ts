import type { RequestEntry } from "../shared/timeline.ts";

export const MAX_REQUESTS = 500;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BODY_TOTAL_BYTES = 8 * 1024 * 1024;
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
  timingUntil: number | undefined;
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
  return url.href;
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

// Replaces the value of every credential-like key, at any depth. Bodies that
// do not parse are kept as sent; the server produced them and they explain failures.
export function redactBody(text: string, contentType: string): string {
  if (!/json/i.test(contentType)) return text;
  try {
    return JSON.stringify(
      JSON.parse(text, (key, value) => (SECRET_JSON_KEY.test(key) ? "[redacted]" : value)),
    );
  } catch {
    return text;
  }
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
    const url = new URL(rawUrl, location.href);
    const sameOrigin = url.origin === location.origin;
    const entry: RequestEntry = {
      kind: "request",
      seq: hooks.nextSeq(),
      at: new Date().toISOString(),
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
      start: performance.now(),
      bodyAllowed: sameOrigin && hooks.bodies.some((prefix) => url.pathname.startsWith(prefix)),
      bodyBytes: 0,
      timingUntil: undefined,
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
      storeBody(item, "requestBody", redactBody(text, type));
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
          storeBody(item, "responseBody", redactBody(read.text, type));
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
  globalThis.fetch = function fetch(input: RequestInfo | URL, init?: RequestInit) {
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
      return originalFetch(input, init);
    }
    return originalFetch(input, nextInit).then(
      (response) => {
        try {
          onFetchResponse(item, response);
        } catch (cause) {
          hooks.fail("fetch response capture", cause);
        }
        return response;
      },
      (cause) => {
        settleFailure(item, cause);
        throw cause;
      },
    );
  };

  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetRequestHeader = proto.setRequestHeader;
  const opened = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: Headers }>();

  const inFlight = new WeakMap<XMLHttpRequest, () => void>();

  proto.open = function open(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    // Reopening an in-flight request aborts it without an abort event.
    inFlight.get(this)?.();
    opened.set(this, { method, url: String(url), headers: new Headers() });
    // Omitted arguments take the defaults the two-argument form uses.
    originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  proto.setRequestHeader = function setRequestHeader(
    this: XMLHttpRequest,
    name: string,
    value: string,
  ) {
    originalSetRequestHeader.call(this, name, value);
    try {
      opened.get(this)?.headers.append(name, value);
    } catch (cause) {
      hooks.fail("XMLHttpRequest header capture", cause);
    }
  };

  proto.send = function send(this: XMLHttpRequest, body?: XhrBody) {
    const request = opened.get(this);
    if (request !== undefined) {
      try {
        trackXhr(this, request, body);
      } catch (cause) {
        hooks.fail("XMLHttpRequest capture", cause);
      }
    }
    originalSend.call(this, body);
  };

  function trackXhr(
    xhr: XMLHttpRequest,
    request: { method: string; url: string; headers: Headers },
    body: XhrBody,
  ): void {
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
    const end = (outcome: string): void => {
      listening.abort();
      inFlight.delete(xhr);
      try {
        finishXhr(xhr, item, outcome);
      } catch (cause) {
        hooks.fail("XMLHttpRequest response capture", cause);
      }
    };
    const onEnd = (event: Event): void => end(event.type);
    inFlight.set(xhr, () => end("abort"));
    xhr.addEventListener("readystatechange", onHeaders, { signal: listening.signal });
    for (const type of ["load", "error", "abort", "timeout"]) {
      xhr.addEventListener(type, onEnd, { signal: listening.signal });
    }
  }

  function finishXhr(xhr: XMLHttpRequest, item: Tracked, outcome: string): void {
    if (outcome === "abort") return settle(item, "aborted");
    if (outcome !== "load") return settle(item, "failed", outcome);
    if (item.entry.status === undefined) {
      recordResponseHead(item, xhr.status, parseRawHeaders(xhr), xhr.responseType || "text");
    }
    const text = xhrText(xhr);
    if (item.entry.responseSize === undefined && text !== undefined) {
      item.entry.responseSize = utf8Length(text);
    }
    const type = item.entry.contentType ?? "";
    if (
      item.bodyAllowed &&
      text !== undefined &&
      TEXT_TYPE.test(type) &&
      (item.entry.responseSize ?? 0) <= MAX_BODY_BYTES
    ) {
      storeBody(item, "responseBody", redactBody(text, type));
    }
    settle(item, "done");
  }

  function resolveTimings(): boolean {
    collectTimings(timingObserver.takeRecords());
    const pending = tracked.filter((item) => item.timingUntil !== undefined);
    if (pending.length === 0) return false;
    const now = performance.now();
    let changed = false;
    for (const item of pending) {
      const match = timings.find(
        ({ name, timing }) => timing.startTime >= item.start - 1 && name === item.entry.url,
      );
      if (match === undefined) {
        if (now > (item.timingUntil ?? 0)) item.timingUntil = undefined;
        continue;
      }
      timings.splice(timings.indexOf(match), 1);
      applyTiming(item, match.timing);
      changed = true;
    }
    if (changed) hooks.changed();
    return changed;
  }

  return {
    list: () => tracked.map((item) => ({ ...item.entry })),
    resolveTimings,
    // Called as a method of another object, the native fetch throws "Illegal invocation".
    untracked: (input, init) => originalFetch(input, init),
    restore() {
      timingObserver.disconnect();
      globalThis.fetch = originalFetch;
      proto.open = originalOpen;
      proto.send = originalSend;
      proto.setRequestHeader = originalSetRequestHeader;
    },
  };
}

function applyTiming(item: Tracked, timing: PerformanceResourceTiming): void {
  const { entry } = item;
  item.timingUntil = undefined;
  if (timing.responseEnd > 0) entry.durationMs = Math.round(timing.duration);
  if (timing.transferSize > 0) entry.transferSize = timing.transferSize;
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
