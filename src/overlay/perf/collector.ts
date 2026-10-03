import { getRDTHook, instrument, type FiberRoot } from "bippy";
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
import { claimRecent, pausePerf, resumePerf } from "./observer.ts";

// web-vitals has evaluated by now; the resource observer it creates at import is Perf's.
claimRecent();

const MAX_FRAMES = 10;
const MAX_GROUPS = 100;
const MAX_SCRIPTS_PER_FRAME = 3;
const MAX_HOT_SPOTS = 200;
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
  lcp: Lcp | undefined;
  inp: Inp | undefined;
  cls: Cls | undefined;
  frames: Frame[];
  groups: ScriptGroup[];
  hotSpots: HotSpot[];
  loafSupported: boolean;
  scanning: boolean;
};

const EMPTY: PerfState = {
  lcp: undefined,
  inp: undefined,
  cls: undefined,
  frames: [],
  groups: [],
  hotSpots: [],
  loafSupported: true,
  scanning: false,
};

export const perf = createStore<PerfState>(EMPTY);

const ms = (value: number): number => Math.round(value);

function selectorOf(element: Element, depth: number): string {
  const testId = element.getAttribute("data-testid");
  if (testId !== null) return `${element.localName}[data-testid="${testId}"]`;
  if (element.id !== "") return `${element.localName}#${element.id}`;
  const parent = element.parentElement;
  if (parent === null || depth >= TARGET_DEPTH) return element.localName;
  return `${selectorOf(parent, depth + 1)} > ${element.localName}`;
}

// web-vitals asks for a target string while the node still exists and keeps only that
// string, so the element's own source travels inside it: a short selector is not unique,
// and a source looked up by selector could name another element's file:line.
function generateTarget(node: Node | null): string | undefined {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  if (element === null) return undefined;
  // Events inside the shadow root are retargeted to the host.
  if (element.localName === HOST_TAG) return OVERLAY_TARGET;
  const target: Target = { selector: selectorOf(element, 0) };
  const source = element.getAttribute(SOURCE_ATTRIBUTE);
  if (source !== null) target.source = source;
  return JSON.stringify(target);
}

// A target web-vitals took from the entry instead (a node already removed) is the
// browser's CSS selector, which cannot start with "{".
function targetOf(value: string | undefined): Target | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith("{")) return { selector: value };
  // SAFETY: generateTarget wrote this JSON from a Target.
  return JSON.parse(value) as Target;
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

let started = false;
let observing = false;

/**
 * Runs web-vitals and the long-animation-frame observer while the Perf panel is open.
 * web-vitals starts once per page because each start adds listeners it never removes; a
 * later opening resumes its observers, which pick up the entries buffered while closed.
 */
export function startObservers(): void {
  if (observing) return;
  observing = true;
  if (started) {
    resumePerf();
    return;
  }
  started = true;
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

/** Pauses every Perf observer when the panel closes, leaving capture's own. */
export function stopObservers(): void {
  observing = false;
  pausePerf();
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
let unsubscribe: (() => void) | undefined;
let publishQueued = false;

function publishHotSpots(): void {
  publishQueued = false;
  const ranked = [...hotSpots.values()].toSorted((a, b) => b.renders - a.renders);
  for (const spot of ranked.slice(MAX_HOT_SPOTS)) {
    hotSpots.delete(hotSpotKey(spot));
  }
  perf.set({ hotSpots: ranked.slice(0, MAX_HOT_SPOTS) });
}

function onCommit(root: FiberRoot): void {
  if (!addCommit(hotSpots, root.current, isProject) || publishQueued) return;
  publishQueued = true;
  queueMicrotask(publishHotSpots);
}

/** Starts render tracking on the React DevTools hook; runs only while the Perf panel is open. */
export function startScan(): void {
  if (unsubscribe !== undefined) return;
  unsubscribe = instrument({
    onActive: () => perf.set({ scanning: true }),
    onCommitFiberRoot: (_rendererId, root) => onCommit(root),
  });
  // A hook installed after React loaded never receives a renderer.
  perf.set({ scanning: getRDTHook().renderers.size > 0 });
}

export function stopScan(): void {
  if (unsubscribe === undefined) return;
  unsubscribe();
  unsubscribe = undefined;
  perf.set({ scanning: false });
}

/** Stops everything and drops the hot spots; called when the overlay unmounts. */
export function stopAll(): void {
  stopScan();
  stopObservers();
  hotSpots.clear();
  perf.set({ hotSpots: [] });
}
