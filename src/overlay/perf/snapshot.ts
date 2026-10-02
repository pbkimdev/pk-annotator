import { calibrateFromDocument, symbolicate } from "../../select/source.ts";
import { getCapture } from "../capture.ts";
import type { CollectedAttachment } from "../registry.ts";
import { perf, type Cls, type Frame, type Inp, type Lcp, type ScriptGroup } from "./collector.ts";
import {
  frameCause,
  hotSpotKey,
  slowRequests,
  type Cause,
  type HotSpot,
  type SlowRequest,
} from "./join.ts";

export const LAB_COMMAND = "pka lab --url <production preview url> --flow <annotation id>";
const MAX_HOT_SPOTS = 10;

/**
 * Values past these mark suspects: the web-vitals "good" limits, a frame blocking for
 * 100 ms, a request over 500 ms. They are not budgets; pass/fail belongs to lab verdicts.
 */
export const SUSPECT = { lcpMs: 2500, inpMs: 200, cls: 0.1, frameBlockingMs: 100, requestMs: 500 };
const MAX_GROUPS = 8;

export type FrameView = Frame & { cause?: Cause };
export type HotSpotView = Omit<HotSpot, "site"> & { source?: string };

export type PerfSnapshot = {
  build: "dev";
  note: string;
  takenAt: string;
  lcp?: Lcp;
  inp?: Inp;
  cls?: Cls;
  longAnimationFrames: { supported: boolean; frames: FrameView[]; groups: ScriptGroup[] };
  requests: SlowRequest[];
  renders: HotSpotView[];
  lab: string;
};

// Bounded like the hot spots it serves; a rejected lookup is dropped so a later render can
// retry once the source map is ready.
const MAX_SOURCES = 200;
const sources = new Map<string, Promise<string | undefined>>();

/** The hot spot's site through its source map, cached per site. */
export function hotSpotSource(spot: HotSpot): Promise<string | undefined> {
  const key = hotSpotKey(spot);
  let source = sources.get(key);
  if (source === undefined) {
    calibrateFromDocument();
    source = symbolicate(spot.site);
    source.catch(() => sources.delete(key));
    sources.set(key, source);
    if (sources.size > MAX_SOURCES) {
      const oldest = sources.keys().next().value;
      if (oldest !== undefined) sources.delete(oldest);
    }
  }
  return source;
}

export function clearSources(): void {
  sources.clear();
}

export function frameViews(frames: readonly Frame[]): FrameView[] {
  const { actions } = getCapture().snapshot();
  return frames.map((frame) => {
    const cause = frameCause(frame.start, frame.durationMs, actions, performance.timeOrigin);
    return cause === undefined ? frame : { ...frame, cause };
  });
}

export function requestViews(): SlowRequest[] {
  const { requests, actions } = getCapture().snapshot();
  return slowRequests(requests, actions);
}

async function hotSpotViews(spots: readonly HotSpot[]): Promise<HotSpotView[]> {
  return Promise.all(
    spots.slice(0, MAX_HOT_SPOTS).map(async (spot) => {
      const source = await hotSpotSource(spot);
      const { site: _site, ...rest } = spot;
      const view: HotSpotView = { ...rest, selfMs: Math.round(spot.selfMs * 10) / 10 };
      if (source !== undefined) view.source = source;
      return view;
    }),
  );
}

export async function takeSnapshot(): Promise<PerfSnapshot> {
  const state = perf.get();
  const snapshot: PerfSnapshot = {
    build: "dev",
    note: "Live numbers from a dev build. They name suspects; pass/fail comes only from pka lab verdicts on a production build.",
    takenAt: new Date().toISOString(),
    longAnimationFrames: {
      supported: state.loafSupported,
      frames: frameViews(state.frames),
      groups: state.groups.slice(0, MAX_GROUPS),
    },
    requests: requestViews(),
    renders: await hotSpotViews(state.hotSpots),
    lab: LAB_COMMAND,
  };
  if (state.lcp !== undefined) snapshot.lcp = state.lcp;
  if (state.inp !== undefined) snapshot.inp = state.inp;
  if (state.cls !== undefined) snapshot.cls = state.cls;
  return snapshot;
}

const at = (source: string | undefined): string => (source === undefined ? "" : ` (${source})`);

function vitalLines(snapshot: PerfSnapshot): string[] {
  const lines: string[] = [];
  const { lcp, inp, cls } = snapshot;
  if (lcp !== undefined) {
    lines.push(
      `- LCP ${lcp.value} ms${flag(lcp.value > SUSPECT.lcpMs)}: ${lcp.target?.selector ?? "no element"}${at(lcp.target?.source)}; ` +
        `TTFB ${lcp.timeToFirstByte}, load delay ${lcp.resourceLoadDelay}, load ${lcp.resourceLoadDuration}, render delay ${lcp.elementRenderDelay} ms`,
    );
  }
  if (inp !== undefined) {
    lines.push(
      `- INP ${inp.value} ms${flag(inp.value > SUSPECT.inpMs)}: ${inp.target?.selector ?? "no element"}${at(inp.target?.source)}; ` +
        `input delay ${inp.inputDelay}, processing ${inp.processingDuration}, presentation ${inp.presentationDelay} ms`,
    );
  }
  if (cls !== undefined) {
    lines.push(
      `- CLS ${cls.value}${flag(cls.value > SUSPECT.cls)}: ${cls.target?.selector ?? "no shift"}${at(cls.target?.source)}`,
    );
  }
  return lines;
}

function causeText(cause: Cause | undefined, relation: "during" | "after"): string {
  if (cause === undefined) return "";
  return ` ${relation} ${cause.handler} on ${cause.target}${at(cause.source)}, action seq ${cause.seq}`;
}

const flag = (suspect: boolean): string => (suspect ? " **suspect**" : "");

function suspectLines(snapshot: PerfSnapshot): string[] {
  const lines: string[] = [];
  for (const frame of snapshot.longAnimationFrames.frames.slice(0, 3)) {
    const script = frame.scripts[0];
    const forced = frame.forcedLayoutMs > 0 ? `, forced layout ${frame.forcedLayoutMs} ms` : "";
    const where =
      script === undefined ? "" : `; ${script.functionName || script.invoker} in ${script.source}`;
    lines.push(
      `- Long frame ${frame.blockingMs} ms blocking${flag(frame.blockingMs >= SUSPECT.frameBlockingMs)}${forced}${causeText(frame.cause, "during")}${where}`,
    );
  }
  for (const request of snapshot.requests.slice(0, 3)) {
    const timing = request.serverTiming
      .map((entry) => `${entry.name} ${entry.duration} ms`)
      .join(", ");
    lines.push(
      `- ${request.method} ${request.url} ${request.durationMs} ms${flag(request.durationMs >= SUSPECT.requestMs)}${timing === "" ? "" : ` (${timing})`}${causeText(request.cause, "after")}`,
    );
  }
  for (const spot of snapshot.renders.slice(0, 3)) {
    const props = spot.props.length === 0 ? "" : `, props ${spot.props.join(", ")}`;
    lines.push(`- ${spot.name} rendered ${spot.renders}x${at(spot.source)}${props}`);
  }
  return lines;
}

export function summaryMarkdown(snapshot: PerfSnapshot, jsonPath: string): string {
  return [
    "# Live perf snapshot (dev build)",
    "",
    "Values marked suspect passed a highlight threshold; they are not budgets. Pass/fail comes from `pka lab` verdicts on a production build.",
    "",
    ...vitalLines(snapshot),
    ...suspectLines(snapshot),
    "",
    `Lab run: \`${snapshot.lab}\``,
    `Details: ${jsonPath}`,
    "",
  ].join("\n");
}

export function summaryLine(snapshot: PerfSnapshot): string {
  const parts = [
    snapshot.lcp === undefined ? undefined : `LCP ${snapshot.lcp.value} ms`,
    snapshot.inp === undefined ? undefined : `INP ${snapshot.inp.value} ms`,
    snapshot.cls === undefined ? undefined : `CLS ${snapshot.cls.value}`,
    `long frames ${snapshot.longAnimationFrames.frames.length}`,
    `requests ${snapshot.requests.length}`,
    `render hot spots ${snapshot.renders.length}`,
  ].filter((part) => part !== undefined);
  return `Live dev-build perf: ${parts.join(", ")}`;
}

/** Files for a "perf" attachment: the JSON snapshot and a short summary the agent reads first. */
export function collected(snapshot: PerfSnapshot): CollectedAttachment {
  const stamp = snapshot.takenAt.replace(/[:.]/g, "-");
  const jsonPath = `capture/perf/live-${stamp}.json`;
  const summaryPath = `capture/perf/live-${stamp}.md`;
  return {
    path: summaryPath,
    summary: summaryLine(snapshot),
    files: [
      {
        path: jsonPath,
        data: new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      },
      {
        path: summaryPath,
        data: new Blob([summaryMarkdown(snapshot, jsonPath)], { type: "text/markdown" }),
      },
    ],
  };
}
