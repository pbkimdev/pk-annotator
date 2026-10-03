import type { HydrationOptions } from "react-dom/client";

import type { CHANNEL, ErrorsAckMessage, ErrorsMessage } from "../shared/channel.ts";
import type { ErrorGroup } from "../shared/schema.ts";
import type {
  ActionEntry,
  ActionTarget,
  ConsoleEntry,
  ErrorEntry,
  ErrorSource,
  NavigationEntry,
  RequestEntry,
  TimelineEntry,
} from "../shared/timeline.ts";
import { fingerprintError, fingerprintResource, isOverlayError } from "./errors.ts";
import { installNetwork, MAX_URL, redactUrl } from "./network.ts";
import { capString, detach, errorText, formatArgs, serializeArgs } from "./serialize.ts";

const HOST_TAG = "pk-annotator";
const MAX_ENTRIES = 500;
const MAX_GROUPS = 200;
const MAX_GROUPS_PER_MESSAGE = 50;
const MAX_STACK = 16_000;
const SEND_INTERVAL_MS = 1000;
const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
const ACTION_EVENTS = ["click", "input", "change", "submit", "keydown"] as const;
const INTERACTIVE = "a,button,input,select,textarea,summary,label,[role],[data-testid]";

export interface CaptureOptions {
  send: (event: typeof CHANNEL.errors, payload: ErrorsMessage) => void;
  // Same-origin path prefixes whose JSON and text bodies are kept.
  bodies: readonly string[];
  // React's captureOwnerStack (dev builds, 19.1+). Injected so core does not import React.
  captureOwnerStack?: () => string | null;
}

export type CaptureStream = "console" | "network" | "errors";

export type ReactRootOptions = Pick<
  HydrationOptions,
  "onCaughtError" | "onUncaughtError" | "onRecoverableError"
>;

export interface CaptureSnapshot {
  console: ConsoleEntry[];
  errors: ErrorEntry[];
  groups: ErrorGroup[];
  requests: RequestEntry[];
  actions: (ActionEntry | NavigationEntry)[];
}

export interface HuntContext {
  group: ErrorGroup;
  // The occurrence that opened the group, or reopened it after a clear.
  error: ErrorEntry;
  actions: (ActionEntry | NavigationEntry)[];
  requests: RequestEntry[];
}

export interface Capture {
  subscribe: (listener: () => void) => () => void;
  // Returns the same object until something changes, so it can back useSyncExternalStore.
  snapshot: () => CaptureSnapshot;
  clear: (stream: CaptureStream) => void;
  markSent: (fingerprints: readonly string[]) => void;
  // The agent resolved the annotation that carried these groups and the page hot-updated at
  // `updatedAt` (epoch ms). A sent group not seen since is cleared; one seen since reopens
  // with its latest occurrence.
  markResolved: (fingerprints: readonly string[], updatedAt: number) => void;
  huntContext: (fingerprint: string, windowMs?: number) => HuntContext;
  applySymbolicated: (ack: ErrorsAckMessage) => void;
  // Passes every new entry to the listener before a ring buffer can drop it, so a
  // recording keeps all of them. A request arrives twice as the same live entry: when it
  // starts and when it settles. Its bodies can be dropped later to keep the ring's body
  // cap, so a recording copies them when the request settles.
  tap: (listener: (entry: TimelineEntry) => void) => () => void;
  // The page's fetch from before capture wrapped it. Overlay requests (source maps,
  // screenshot resources) go through it so they never show up as page requests.
  fetch: typeof fetch;
  reactRootOptions: ReactRootOptions;
  stop: () => void;
}

interface Thrown {
  type: string;
  message: string;
  stack: string;
}

interface GroupState {
  // `stack` and `topFrame` show the symbolicated values once the plugin acknowledges them.
  group: ErrorGroup;
  // The browser's stack, which is what the plugin can symbolicate on every send.
  raw: Pick<ErrorGroup, "stack" | "topFrame">;
  opened: ErrorEntry;
  latest: { entry: ErrorEntry; topFrame: string | undefined };
}

function rawStack(entry: ErrorEntry, topFrame: string | undefined): GroupState["raw"] {
  const stack = entry.stack ?? "";
  return topFrame === undefined ? { stack } : { stack, topFrame };
}

const EMPTY: CaptureSnapshot = { console: [], errors: [], groups: [], requests: [], actions: [] };

function inertCapture(): Capture {
  return {
    subscribe: () => () => {},
    snapshot: () => EMPTY,
    clear: () => {},
    markSent: () => {},
    markResolved: () => {},
    huntContext: (fingerprint) => {
      throw new Error(`No error group ${fingerprint}: capture is off under navigator.webdriver`);
    },
    applySymbolicated: () => {},
    tap: () => () => {},
    fetch: globalThis.fetch.bind(globalThis),
    reactRootOptions: {},
    stop: () => {},
  };
}

function pushBounded<Item>(list: Item[], item: Item): void {
  list.push(item);
  if (list.length > MAX_ENTRIES) list.shift();
}

function describeThrown<Value>(value: Value, fallbackType: string): Thrown {
  if (value instanceof Error) {
    return {
      type: value.name,
      message: capString(value.message),
      stack: capString(value.stack ?? "", MAX_STACK),
    };
  }
  return { type: fallbackType, message: formatArgs([value]), stack: "" };
}

// Drops the "Error" header line and the frame of the wrapper that created the error.
function callerStack(error: Error): string {
  const lines = (error.stack ?? "").split("\n");
  const first = lines.findIndex((line) => /:\d+:\d+\)?\s*$/.test(line));
  return capString(lines.slice(first + 1).join("\n"), MAX_STACK);
}

function shortText(element: Element): string | undefined {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = "";
  while (text.length < 80 && walker.nextNode() !== null) {
    text += ` ${(walker.currentNode.nodeValue ?? "").slice(0, 80)}`;
  }
  const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 40);
  return trimmed === "" ? undefined : detach(trimmed);
}

function isField(element: Element): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLFormElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

// A field's accessible label or name; never its value.
function fieldLabel(element: Element): string | undefined {
  const labelledBy = element.getAttribute("aria-labelledby");
  const labels =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
      ? element.labels
      : null;
  const label =
    element.getAttribute("aria-label") ??
    labels?.[0]?.textContent ??
    (labelledBy === null ? null : document.getElementById(labelledBy)?.textContent) ??
    element.getAttribute("name") ??
    element.getAttribute("placeholder");
  const trimmed = label?.replace(/\s+/g, " ").trim().slice(0, 40);
  return trimmed === undefined || trimmed === "" ? undefined : detach(trimmed);
}

function describeTarget(element: Element): ActionTarget {
  const target: ActionTarget = { tag: element.localName };
  if (element.id !== "") target.id = element.id;
  const testId = element.getAttribute("data-testid");
  if (testId !== null) target.testId = testId;
  const src = element.getAttribute("data-pka-src");
  if (src !== null) target.src = src;
  const role = element.getAttribute("role");
  if (role !== null) target.role = role;
  const described = isField(element) ? fieldLabel(element) : shortText(element);
  if (described !== undefined) target[isField(element) ? "label" : "text"] = described;
  return target;
}

function sameTarget(left: ActionTarget, right: ActionTarget): boolean {
  return (
    left.tag === right.tag &&
    left.id === right.id &&
    left.testId === right.testId &&
    left.src === right.src &&
    left.label === right.label
  );
}

function resourceUrl(element: Element): string {
  if (element instanceof HTMLMediaElement) return element.currentSrc || element.src;
  if (element instanceof HTMLLinkElement) return element.href;
  return element.getAttribute("src") ?? "";
}

export function createCapture(options: CaptureOptions): Capture {
  if (navigator.webdriver) return inertCapture();

  let seq = 0;
  let version = 0;
  let cached: { version: number; value: CaptureSnapshot } | undefined;
  let stopped = false;
  const consoleEntries: ConsoleEntry[] = [];
  const errorEntries: ErrorEntry[] = [];
  const actionEntries: (ActionEntry | NavigationEntry)[] = [];
  const groups = new Map<string, GroupState>();
  const counted = new WeakSet<Error>();
  const watermarks = { console: 0, network: 0, errors: 0 } satisfies Record<CaptureStream, number>;
  const listeners = new Set<() => void>();
  const taps = new Set<(entry: TimelineEntry) => void>();
  let notifyQueued = false;
  const pendingSend = new Set<string>();
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  const cleanups: (() => void)[] = [];

  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const originalError = originalConsole.error;
  const nextSeq = (): number => (seq += 1);
  const now = (): string => new Date().toISOString();

  function fail(context: string, cause: unknown): void {
    originalError.call(console, `pk-annotator: ${context} failed`, cause);
  }

  function emit(entry: TimelineEntry): void {
    for (const tap of taps) {
      try {
        tap(entry);
      } catch (cause) {
        fail("recording tap", cause);
      }
    }
  }

  function append<Entry extends TimelineEntry>(list: Entry[], entry: Entry): void {
    pushBounded(list, entry);
    emit(entry);
  }

  function changed(): void {
    version += 1;
    if (listeners.size === 0 || notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      for (const listener of listeners) listener();
    });
  }

  // At most one pka:errors message per second; the timer exists only while groups wait.
  function scheduleSend(): void {
    if (sendTimer !== undefined || pendingSend.size === 0 || stopped) return;
    const delay = Math.max(0, lastSentAt + SEND_INTERVAL_MS - performance.now());
    sendTimer = setTimeout(flushSend, delay);
  }

  function flushSend(): void {
    sendTimer = undefined;
    lastSentAt = performance.now();
    const batch: ErrorGroup[] = [];
    for (const fingerprint of pendingSend) {
      if (batch.length === MAX_GROUPS_PER_MESSAGE) break;
      pendingSend.delete(fingerprint);
      const state = groups.get(fingerprint);
      if (state === undefined) continue;
      const { stack: _shownStack, topFrame: _shownTopFrame, ...rest } = state.group;
      batch.push({ ...rest, ...state.raw });
    }
    if (batch.length > 0) {
      try {
        options.send("pka:errors" satisfies typeof CHANNEL.errors, { groups: batch });
      } catch (cause) {
        fail("sending error groups", cause);
      }
    }
    scheduleSend();
  }

  function groupChanged(fingerprint: string): void {
    pendingSend.add(fingerprint);
    scheduleSend();
  }

  function evictGroup(): void {
    let oldest: GroupState | undefined;
    for (const state of groups.values()) {
      if (oldest === undefined || state.group.lastSeq < oldest.group.lastSeq) oldest = state;
    }
    if (oldest !== undefined) groups.delete(oldest.group.fingerprint);
  }

  function recordError(entry: ErrorEntry, topFrame: string | undefined): void {
    append(errorEntries, entry);
    const state = groups.get(entry.fingerprint);
    if (state === undefined) {
      if (groups.size >= MAX_GROUPS) evictGroup();
      const raw = rawStack(entry, topFrame);
      const group: ErrorGroup = {
        fingerprint: entry.fingerprint,
        message: entry.message,
        type: entry.type,
        count: 1,
        firstSeen: entry.at,
        lastSeen: entry.at,
        lastSeq: entry.seq,
        status: "open",
        ...raw,
      };
      groups.set(entry.fingerprint, { group, raw, opened: entry, latest: { entry, topFrame } });
    } else {
      const { group } = state;
      group.count += 1;
      group.lastSeen = entry.at;
      group.lastSeq = entry.seq;
      state.latest = { entry, topFrame };
      if (group.status === "cleared" && entry.seq > watermarks.errors) reopen(state);
    }
    groupChanged(entry.fingerprint);
    changed();
  }

  function reopen(state: GroupState): void {
    const { group } = state;
    const { entry, topFrame } = state.latest;
    group.status = "open";
    group.message = entry.message;
    state.raw = rawStack(entry, topFrame);
    group.stack = state.raw.stack;
    if (topFrame === undefined) delete group.topFrame;
    else group.topFrame = topFrame;
    state.opened = entry;
  }

  function recordThrown(
    source: ErrorSource,
    thrown: Thrown,
    extra: Pick<ErrorEntry, "componentStack" | "ownerStack">,
  ): void {
    if (isOverlayError(thrown.stack)) return;
    const { fingerprint, topFrame } = fingerprintError(thrown.type, thrown.message, thrown.stack);
    const entry: ErrorEntry = {
      kind: "error",
      seq: nextSeq(),
      at: now(),
      source,
      fingerprint,
      type: thrown.type,
      message: thrown.message,
      ...extra,
    };
    if (thrown.stack !== "") entry.stack = thrown.stack;
    recordError(entry, topFrame);
  }

  function recordValue<Value>(source: ErrorSource, value: Value, fallbackType: string): void {
    if (value instanceof Error) {
      if (counted.has(value)) return;
      counted.add(value);
    }
    recordThrown(source, describeThrown(value, fallbackType), {});
  }

  // Console

  function recordConsole(
    level: ConsoleEntry["level"],
    args: readonly unknown[],
    site: Error | undefined,
  ): void {
    append(consoleEntries, {
      kind: "console",
      seq: nextSeq(),
      at: now(),
      level,
      args: serializeArgs(args),
    });
    changed();
    if (site === undefined) return;
    const caller = callerStack(site);
    if (isOverlayError(caller)) return;
    const error = args.find((arg): arg is Error => arg instanceof Error);
    if (error !== undefined) {
      if (counted.has(error)) return;
      counted.add(error);
    }
    const message = formatArgs(args.map((arg) => (arg instanceof Error ? arg.message : arg)));
    recordThrown(
      "console",
      {
        type: error?.name ?? "ConsoleError",
        message,
        stack: error === undefined ? caller : errorText(error),
      },
      {},
    );
  }

  let insideConsole = false;
  const consoleWrappers = { ...originalConsole };
  for (const level of LEVELS) {
    const original = originalConsole[level];
    consoleWrappers[level] = function (...args: unknown[]) {
      original.apply(console, args);
      if (insideConsole || stopped) return;
      insideConsole = true;
      try {
        recordConsole(level, args, level === "error" ? new Error() : undefined);
      } catch (cause) {
        fail("console capture", cause);
      } finally {
        insideConsole = false;
      }
    };
    console[level] = consoleWrappers[level];
  }
  // A wrapper that another library has wrapped since stays in place and records nothing.
  cleanups.push(() => {
    for (const level of LEVELS) {
      if (console[level] === consoleWrappers[level]) console[level] = originalConsole[level];
    }
  });

  // Errors

  function onWindowError(event: Event): void {
    if (event instanceof ErrorEvent) {
      const value = event.error;
      if (value instanceof Error) return recordValue("window", value, "Error");
      const where =
        event.filename === ""
          ? ""
          : `    at ${capString(event.filename, MAX_URL)}:${event.lineno}:${event.colno}`;
      return recordThrown(
        "window",
        { type: "Error", message: capString(event.message), stack: where },
        {},
      );
    }
    const target = event.target;
    if (!(target instanceof Element) || target.closest(HOST_TAG) !== null) return;
    const tag = target.localName;
    const url = redactUrl(resourceUrl(target));
    const entry: ErrorEntry = {
      kind: "error",
      seq: nextSeq(),
      at: now(),
      source: "resource",
      fingerprint: fingerprintResource(tag, url),
      type: "ResourceError",
      message: `<${tag}> failed to load ${url}`,
      resource: { tag, url },
    };
    recordError(entry, undefined);
  }

  function onRejection(event: PromiseRejectionEvent): void {
    recordValue("rejection", event.reason, "UnhandledRejection");
  }

  addEventListener("error", onWindowError, true);
  addEventListener("unhandledrejection", onRejection);
  cleanups.push(() => {
    removeEventListener("error", onWindowError, true);
    removeEventListener("unhandledrejection", onRejection);
  });

  // Supplying these replaces React's own logging, so each handler forwards to
  // the original console.error, which core does not record.
  function reactHandler(
    source: ErrorSource,
    label: string,
  ): NonNullable<ReactRootOptions["onUncaughtError"]> {
    return (error, info) => {
      const ownerStack = stopped ? null : (options.captureOwnerStack?.() ?? null);
      originalError.call(console, `${label}:`, error, info.componentStack ?? "");
      if (stopped) return;
      if (error instanceof Error) {
        if (counted.has(error)) return;
        counted.add(error);
      }
      const extra: Pick<ErrorEntry, "componentStack" | "ownerStack"> = {};
      if (info.componentStack !== undefined) {
        extra.componentStack = capString(info.componentStack, MAX_STACK);
      }
      if (ownerStack !== null) extra.ownerStack = capString(ownerStack, MAX_STACK);
      recordThrown(source, describeThrown(error, "Error"), extra);
    };
  }

  const reactRootOptions: ReactRootOptions = {
    onCaughtError: reactHandler("react-caught", "React caught an error"),
    onUncaughtError: reactHandler("react-uncaught", "Uncaught error in React"),
    onRecoverableError: reactHandler("react-recoverable", "React recovered from an error"),
  };

  // Network

  const network = installNetwork({
    bodies: options.bodies,
    nextSeq,
    changed,
    added: emit,
    settled: emit,
    fail,
  });
  cleanups.push(network.restore);

  // Actions and navigation

  function onAction(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(HOST_TAG) !== null) return;
    let key: ActionEntry["key"];
    if (event.type === "keydown") {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key !== "Enter" && event.key !== "Escape") return;
      key = event.key;
    }
    const element = event.type === "click" ? (target.closest(INTERACTIVE) ?? target) : target;
    const type = ACTION_EVENTS.find((name) => name === event.type);
    if (type === undefined) return;
    const descriptor = describeTarget(element);
    // When the browser created the event, on the performance.now() clock.
    const performanceMs = event.timeStamp;
    const last = actionEntries.at(-1);
    // One entry per run of keystrokes in the same field; its duration runs to the latest.
    if (type === "input" && last?.kind === "action" && last.type === "input") {
      if (sameTarget(last.target, descriptor)) {
        const first = last.performanceMs ?? performanceMs;
        last.durationMs = Math.max(last.durationMs ?? 0, performanceMs - first);
        return;
      }
    }
    const entry: ActionEntry = {
      kind: "action",
      seq: nextSeq(),
      at: now(),
      performanceMs,
      type,
      target: descriptor,
    };
    if (type === "input") entry.durationMs = 0;
    if (key !== undefined) entry.key = key;
    append(actionEntries, entry);
    changed();
  }

  for (const type of ACTION_EVENTS) {
    document.addEventListener(type, onAction, { capture: true, passive: true });
  }
  cleanups.push(() => {
    for (const type of ACTION_EVENTS) document.removeEventListener(type, onAction, true);
  });

  let lastUrl: string | undefined;
  function recordNavigation(type: NavigationEntry["type"], url: string): void {
    const to = redactUrl(url);
    const entry: NavigationEntry = { kind: "navigation", seq: nextSeq(), at: now(), type, to };
    if (lastUrl !== undefined) entry.from = lastUrl;
    lastUrl = to;
    append(actionEntries, entry);
    changed();
  }

  recordNavigation("load", location.href);
  if ("navigation" in globalThis) {
    const onNavigate = (event: NavigateEvent): void => {
      recordNavigation(event.navigationType, event.destination.url);
    };
    navigation.addEventListener("navigate", onNavigate);
    cleanups.push(() => navigation.removeEventListener("navigate", onNavigate));
  } else {
    const { pushState, replaceState } = history;
    const pushWrapper = function (...args: Parameters<History["pushState"]>) {
      pushState.apply(history, args);
      if (!stopped) recordNavigation("push", location.href);
    };
    const replaceWrapper = function (...args: Parameters<History["replaceState"]>) {
      replaceState.apply(history, args);
      if (!stopped) recordNavigation("replace", location.href);
    };
    history.pushState = pushWrapper;
    history.replaceState = replaceWrapper;
    const onPop = (): void => recordNavigation("traverse", location.href);
    addEventListener("popstate", onPop);
    cleanups.push(() => {
      if (history.pushState === pushWrapper) history.pushState = pushState;
      if (history.replaceState === replaceWrapper) history.replaceState = replaceState;
      removeEventListener("popstate", onPop);
    });
  }

  // Read side

  function setStatus(state: GroupState, status: ErrorGroup["status"]): void {
    if (state.group.status === status) return;
    state.group.status = status;
    groupChanged(state.group.fingerprint);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot() {
      network.resolveTimings();
      if (cached?.version === version) return cached.value;
      const value: CaptureSnapshot = {
        console: consoleEntries.filter((entry) => entry.seq > watermarks.console),
        errors: errorEntries.filter((entry) => entry.seq > watermarks.errors),
        groups: [...groups.values()].map((state) => ({ ...state.group })),
        requests: network.list().filter((entry) => entry.seq > watermarks.network),
        actions: [...actionEntries],
      };
      cached = { version, value };
      return value;
    },
    clear(stream) {
      watermarks[stream] = seq;
      if (stream === "errors") {
        for (const state of groups.values()) setStatus(state, "cleared");
      }
      changed();
    },
    markSent(fingerprints) {
      for (const fingerprint of fingerprints) {
        const state = groups.get(fingerprint);
        if (state !== undefined && state.group.status === "open") setStatus(state, "sent");
      }
      changed();
    },
    markResolved(fingerprints, updatedAt) {
      for (const fingerprint of fingerprints) {
        const state = groups.get(fingerprint);
        if (state === undefined || state.group.status !== "sent") continue;
        if (Date.parse(state.group.lastSeen) < updatedAt) {
          setStatus(state, "cleared");
          continue;
        }
        reopen(state);
        groupChanged(fingerprint);
      }
      changed();
    },
    huntContext(fingerprint, windowMs = 20_000) {
      const state = groups.get(fingerprint);
      if (state === undefined) {
        throw new Error(`No error group ${fingerprint}; it was never seen or has been evicted`);
      }
      network.resolveTimings();
      const opened = state.opened;
      const end = Date.parse(opened.at);
      const inWindow = (entry: { seq: number; at: string }): boolean =>
        entry.seq <= opened.seq && Date.parse(entry.at) >= end - windowMs;
      return {
        group: { ...state.group },
        error: opened,
        actions: actionEntries.filter(inWindow),
        requests: network.list().filter(inWindow),
      };
    },
    applySymbolicated(ack) {
      for (const symbolicated of ack.groups) {
        const state = groups.get(symbolicated.fingerprint);
        if (state === undefined) continue;
        state.group.stack = symbolicated.stack;
        if (symbolicated.topFrame !== undefined) state.group.topFrame = symbolicated.topFrame;
      }
      changed();
    },
    tap(listener) {
      taps.add(listener);
      return () => taps.delete(listener);
    },
    fetch: network.untracked,
    reactRootOptions,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      if (sendTimer !== undefined) clearTimeout(sendTimer);
      sendTimer = undefined;
      pendingSend.clear();
      listeners.clear();
      taps.clear();
    },
  };
}
