import { instrument, type LiteEvent, type LiteHandle } from "react-scan/lite";
import {
  onCLS,
  onINP,
  onLCP,
  type CLSMetricWithAttribution,
  type INPMetricWithAttribution,
  type LCPMetricWithAttribution,
  type MetricWithAttribution,
} from "web-vitals/attribution";

import { redactUrl } from "../../core/network.ts";
import { SOURCE_ATTRIBUTE } from "../../select/source.ts";
import { HOST_TAG } from "../launcher.ts";
import { createStore } from "../store.ts";
import { addCommit, hotSpotKey, type HotSpot } from "./join.ts";
import { disconnectAll } from "./observer.ts";

const MAX_FRAMES = 10;
const MAX_GROUPS = 100;
const MAX_SCRIPTS_PER_FRAME = 3;
const MAX_HOT_SPOTS = 200;
const MAX_TARGETS = 100;
const TARGET_DEPTH = 4;
const OVERLAY_TARGET = `${HOST_TAG} (this overlay)`;

export type Target = { selector: string; source?: string };

export type Lcp = {
  value: number;
  navigation: string;
  target?: Target;
  url?: string;
  timeToFirstByte: number;
  resourceLoadDelay: number;
  resourceLoadDuration: number;
  elementRenderDelay: number;
};

export type Script = {
  invoker: string;
  invokerType: string;
  /** Script URL path without query, or host and path when cross-origin. */
  source: string;
  functionName: string;
  durationMs: number;
  forcedLayoutMs: number;
};

export type Inp = {
  value: number;
  navigation: string;
  target?: Target;
  interactionType?: "pointer" | "keyboard";
  inputDelay: number;
  processingDuration: number;
  presentationDelay: number;
  longestScript?: Script & { subpart: string; intersectingMs: number };
};

export type Cls = {
  value: number;
  navigation: string;
  target?: Target;
  largestShift?: number;
};

export type Frame = {
  /** Milliseconds since the time origin. */
  start: number;
  durationMs: number;
  blockingMs: number;
  forcedLayoutMs: number;
  scripts: Script[];
};

export type ScriptGroup = {
  source: string;
  functionName: string;
  invoker: string;
  frames: number;
  durationMs: number;
  forcedLayoutMs: number;
  maxBlockingMs: number;
};

export type PerfState = {
  lcp?: Lcp;
  inp?: Inp;
  cls?: Cls;
  frames: Frame[];
  groups: ScriptGroup[];
  hotSpots: HotSpot[];
  loafSupported: boolean;
  scanning: boolean;
};

const EMPTY: PerfState = {
  frames: [],
  groups: [],
  hotSpots: [],
  loafSupported: true,
  scanning: false,
};

export const perf = createStore<PerfState>(EMPTY);

const ms = (value: number): number => Math.round(value);

// web-vitals asks for a target string while the node still exists; its source is kept by
// selector so the views can name file:line.
const targetSources = new Map<string, string>();

function selectorOf(element: Element, depth: number): string {
  const testId = element.getAttribute("data-testid");
  if (testId !== null) return `${element.localName}[data-testid="${testId}"]`;
  if (element.id !== "") return `${element.localName}#${element.id}`;
  const parent = element.parentElement;
  if (parent === null || depth >= TARGET_DEPTH) return element.localName;
  return `${selectorOf(parent, depth + 1)} > ${element.localName}`;
}

function generateTarget(node: Node | null): string | undefined {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  if (element === null) return undefined;
  // Events inside the shadow root are retargeted to the host.
  if (element.localName === HOST_TAG) return OVERLAY_TARGET;
  const selector = selectorOf(element, 0);
  const source = element.getAttribute(SOURCE_ATTRIBUTE);
  if (source !== null) {
    targetSources.delete(selector);
    targetSources.set(selector, source);
    if (targetSources.size > MAX_TARGETS) {
      const oldest = targetSources.keys().next().value;
      if (oldest !== undefined) targetSources.delete(oldest);
    }
  }
  return selector;
}

function targetOf(selector: string | undefined): Target | undefined {
  if (selector === undefined) return undefined;
  const source = targetSources.get(selector);
  return source === undefined ? { selector } : { selector, source };
}

function navigationOf(metric: MetricWithAttribution): string {
  return metric.navigationType === "soft-navigation" && metric.navigationURL !== undefined
    ? `soft-navigation ${redactUrl(metric.navigationURL)}`
    : metric.navigationType;
}

function scriptSource(url: string): string {
  if (url === "" || !URL.canParse(url)) return url;
  const parsed = new URL(url);
  return parsed.origin === location.origin ? parsed.pathname : `${parsed.host}${parsed.pathname}`;
}

function scriptOf(entry: PerformanceScriptTiming): Script {
  return {
    invoker: entry.invoker,
    invokerType: entry.invokerType,
    source: scriptSource(entry.sourceURL),
    functionName: entry.sourceFunctionName,
    durationMs: ms(entry.duration),
    forcedLayoutMs: ms(entry.forcedStyleAndLayoutDuration),
  };
}

function toLcp(metric: LCPMetricWithAttribution): Lcp {
  const { attribution } = metric;
  const lcp: Lcp = {
    value: ms(metric.value),
    navigation: navigationOf(metric),
    timeToFirstByte: ms(attribution.timeToFirstByte),
    resourceLoadDelay: ms(attribution.resourceLoadDelay),
    resourceLoadDuration: ms(attribution.resourceLoadDuration),
    elementRenderDelay: ms(attribution.elementRenderDelay),
  };
  const target = targetOf(attribution.target);
  if (target !== undefined) lcp.target = target;
  if (attribution.url !== undefined) lcp.url = redactUrl(attribution.url);
  return lcp;
}

function toInp(metric: INPMetricWithAttribution): Inp {
  const { attribution } = metric;
  const inp: Inp = {
    value: ms(metric.value),
    navigation: navigationOf(metric),
    inputDelay: ms(attribution.inputDelay),
    processingDuration: ms(attribution.processingDuration),
    presentationDelay: ms(attribution.presentationDelay),
  };
  const target = targetOf(attribution.interactionTarget);
  if (target !== undefined) inp.target = target;
  if (attribution.interactionType !== undefined) inp.interactionType = attribution.interactionType;
  const longest = attribution.longestScript;
  if (longest !== undefined) {
    inp.longestScript = {
      ...scriptOf(longest.entry),
      subpart: longest.subpart,
      intersectingMs: ms(longest.intersectingDuration),
    };
  }
  return inp;
}

function toCls(metric: CLSMetricWithAttribution): Cls {
  const { attribution } = metric;
  const cls: Cls = {
    value: Math.round(metric.value * 1000) / 1000,
    navigation: navigationOf(metric),
  };
  const target = targetOf(attribution.largestShiftTarget);
  if (target !== undefined) cls.target = target;
  if (attribution.largestShiftValue !== undefined) {
    cls.largestShift = Math.round(attribution.largestShiftValue * 1000) / 1000;
  }
  return cls;
}

const groups = new Map<string, ScriptGroup>();

function addGroup(script: Script, blockingMs: number): void {
  const key = `${script.source}|${script.functionName || script.invoker}`;
  const group = groups.get(key) ?? {
    source: script.source,
    functionName: script.functionName,
    invoker: script.invoker,
    frames: 0,
    durationMs: 0,
    forcedLayoutMs: 0,
    maxBlockingMs: 0,
  };
  group.frames += 1;
  group.durationMs += script.durationMs;
  group.forcedLayoutMs += script.forcedLayoutMs;
  group.maxBlockingMs = Math.max(group.maxBlockingMs, blockingMs);
  groups.set(key, group);
  if (groups.size <= MAX_GROUPS) return;
  let smallest: [string, ScriptGroup] | undefined;
  for (const entry of groups) {
    if (smallest === undefined || entry[1].durationMs < smallest[1].durationMs) smallest = entry;
  }
  if (smallest !== undefined) groups.delete(smallest[0]);
}

function addFrames(entries: readonly PerformanceLongAnimationFrameTiming[]): void {
  const frames = [...perf.get().frames];
  for (const entry of entries) {
    const scripts = entry.scripts.map(scriptOf);
    const blockingMs = ms(entry.blockingDuration);
    for (const script of scripts) addGroup(script, blockingMs);
    frames.push({
      start: ms(entry.startTime),
      durationMs: ms(entry.duration),
      blockingMs,
      forcedLayoutMs: scripts.reduce((sum, script) => sum + script.forcedLayoutMs, 0),
      scripts: scripts
        .toSorted((a, b) => b.durationMs - a.durationMs)
        .slice(0, MAX_SCRIPTS_PER_FRAME),
    });
  }
  perf.set({
    frames: frames.toSorted((a, b) => b.blockingMs - a.blockingMs).slice(0, MAX_FRAMES),
    groups: [...groups.values()].toSorted((a, b) => b.durationMs - a.durationMs),
  });
}

let observing = false;

/** Starts web-vitals and the long-animation-frame observer; buffered entries arrive too. */
export function startObservers(): void {
  if (observing) return;
  observing = true;
  const options = { reportAllChanges: true, reportSoftNavs: true, generateTarget };
  onLCP((metric) => perf.set({ lcp: toLcp(metric) }), options);
  onINP((metric) => perf.set({ inp: toInp(metric) }), options);
  onCLS((metric) => perf.set({ cls: toCls(metric) }), options);
  if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
    perf.set({ loafSupported: false });
    return;
  }
  const observer = new PerformanceObserver((list) => {
    // SAFETY: the observer is registered only for "long-animation-frame" entries.
    addFrames(list.getEntries() as PerformanceLongAnimationFrameTiming[]);
  });
  observer.observe({ type: "long-animation-frame", buffered: true });
}

// The overlay's own chunks load from the same directory as this one; in a consumer they sit
// under node_modules, in the fixture under dist/.
const overlayBase = new URL(".", import.meta.url).href;

function isProject(fileName: string): boolean {
  if (!URL.canParse(fileName) || fileName.startsWith(overlayBase)) return false;
  const url = new URL(fileName);
  if (url.origin !== location.origin || url.pathname.includes("/node_modules/")) return false;
  return !url.pathname.startsWith("/@") || url.pathname.startsWith("/@fs/");
}

const hotSpots = new Map<string, HotSpot>();
let scan: { handle: LiteHandle; owned: boolean; unsubscribe(): void } | undefined;
let publishQueued = false;

function publishHotSpots(): void {
  publishQueued = false;
  const ranked = [...hotSpots.values()].toSorted((a, b) => b.renders - a.renders);
  for (const spot of ranked.slice(MAX_HOT_SPOTS)) {
    hotSpots.delete(hotSpotKey(spot));
  }
  perf.set({ hotSpots: ranked.slice(0, MAX_HOT_SPOTS) });
}

function onCommit(event: LiteEvent): void {
  if (event.kind !== "commit" || event.tree === undefined) return;
  if (!addCommit(hotSpots, event.tree, isProject) || publishQueued) return;
  publishQueued = true;
  queueMicrotask(publishHotSpots);
}

/** Starts react-scan/lite render tracking; runs only while the Perf panel is open. */
export function startScan(): void {
  if (scan !== undefined) return;
  // instrument() returns the page's own handle when the app already runs react-scan/lite.
  const owned = window.__REACT_SCAN_LITE__ === undefined;
  const handle = instrument({
    recordChangeDescriptions: true,
    includeFiberSource: true,
    includeProfilingHooks: false,
    includeLaneLabels: false,
  });
  scan = { handle, owned, unsubscribe: handle.subscribe(onCommit) };
  perf.set({ scanning: handle.isActive() });
}

export function stopScan(): void {
  if (scan === undefined) return;
  scan.unsubscribe();
  if (scan.owned) scan.handle.stop();
  scan = undefined;
  perf.set({ scanning: false });
}

/** Stops everything; called when the overlay unmounts. A later open starts afresh. */
export function stopAll(): void {
  stopScan();
  disconnectAll();
  observing = false;
  groups.clear();
  hotSpots.clear();
  targetSources.clear();
  perf.set(EMPTY);
}
