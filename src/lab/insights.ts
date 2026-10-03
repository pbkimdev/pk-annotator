// The only module that touches @paulirish/trace_engine. Its API is unstable,
// so the version is pinned and everything it returns is reduced here to the
// plain summaries in TraceAnalysis.
import type * as Trace from "@paulirish/trace_engine";

import type { HotFunction } from "../shared/verdict.ts";
import type { InsightSummary, TraceAnalysis } from "./verdict.ts";

type Engine = typeof Trace;
type InsightSet = Trace.Insights.Types.InsightSet;
type Models = Trace.Insights.Types.InsightModels;

export const REQUESTED_INSIGHTS = [
  "LCPBreakdown",
  "INPBreakdown",
  "CLSCulprits",
  "RenderBlocking",
  "ForcedReflow",
  "DocumentLatency",
  "NetworkDependencyTree",
] as const;

const SUMMARY_CAP = 400;

/** A trace that could not be recorded, saved, or parsed; it costs the insights, not the verdict. */
export class TraceError extends Error {}

let engine: Promise<Engine> | undefined;

// The trace engine is DevTools code and constructs DOMRect, which Node lacks.
class NodeDOMRect {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {}
  get left(): number {
    return this.x + Math.min(0, this.width);
  }
  get right(): number {
    return this.x + Math.max(0, this.width);
  }
  get top(): number {
    return this.y + Math.min(0, this.height);
  }
  get bottom(): number {
    return this.y + Math.max(0, this.height);
  }
}

function loadEngine(): Promise<Engine> {
  if (!("DOMRect" in globalThis)) {
    Object.defineProperty(globalThis, "DOMRect", { value: NodeDOMRect, configurable: true });
  }
  engine ??= import("@paulirish/trace_engine");
  return engine;
}

const ms = (micro: number): number => Math.round(micro / 1000);

function cap(text: string): string {
  return text.length <= SUMMARY_CAP ? text : `${text.slice(0, SUMMARY_CAP - 1)}…`;
}

// The packaged engine's i18nString returns only { i18nId, values }: the English
// message with {PH1}-style placeholders. Its typings also promise a
// formattedDefault that is absent at runtime.
function uiText(text: { i18nId: string; values?: Record<string, string | number> }): string {
  return text.i18nId.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = text.values?.[key];
    return value === undefined ? match : String(value);
  });
}

function frameLabel(frame: { functionName: string; url: string; lineNumber: number } | null) {
  if (frame === null) return "(unknown)";
  return `${frame.functionName || "(anonymous)"} ${frame.url}:${frame.lineNumber + 1}`;
}

type Model<K extends keyof Models> = NonNullable<Models[K]>;

function lcpSummary(model: Model<"LCPBreakdown">): string {
  if (model.lcpMs === undefined || model.subparts === undefined) return "No LCP in this page";
  const parts = Object.entries(model.subparts)
    .filter(([, subpart]) => subpart !== undefined)
    .map(([part, subpart]) => `${part} ${ms(subpart.range)} ms`);
  const request = model.lcpRequest === undefined ? "text" : model.lcpRequest.args.data.url;
  return `LCP ${Math.round(model.lcpMs)} ms (${request}): ${parts.join(", ")}`;
}

function inpSummary(model: Model<"INPBreakdown">): string {
  const event = model.longestInteractionEvent;
  if (event === undefined) return "No interactions in this page";
  return (
    `Longest interaction ${event.type} ${ms(event.dur)} ms: input delay ${ms(event.inputDelay)} ms, ` +
    `processing ${ms(event.mainThreadHandling)} ms, presentation ${ms(event.presentationDelay)} ms`
  );
}

function clsSummary(model: Model<"CLSCulprits">): string {
  const worst = model.worstCluster;
  if (worst === undefined) return "No layout shifts";
  const culprits = (model.topCulpritsByCluster.get(worst) ?? []).map((item) =>
    uiText(item.description),
  );
  const score = Math.round(worst.clusterCumulativeScore * 10_000) / 10_000;
  const named = culprits.length > 0 ? `culprits: ${culprits.join("; ")}` : "no culprit identified";
  return `Worst cluster ${score}; ${named}`;
}

function renderBlockingSummary(model: Model<"RenderBlocking">): string {
  const requests = model.renderBlockingRequests;
  if (requests.length === 0) return "No render-blocking requests";
  const saving = model.metricSavings?.FCP;
  const urls = requests.map((request) => request.args.data.url).join(", ");
  return `${requests.length} render-blocking: ${urls}${saving === undefined ? "" : `; FCP saving ~${Math.round(saving)} ms`}`;
}

function forcedReflowSummary(model: Model<"ForcedReflow">): string {
  const top = model.topLevelFunctionCallData;
  const sites = model.aggregatedBottomUpData
    .slice(0, 3)
    .map((site) => `${frameLabel(site.bottomUpData)} ${ms(site.totalTime)} ms`);
  if (top === undefined && sites.length === 0) return "No forced reflow";
  const total = top === undefined ? "" : `${ms(top.totalReflowTime)} ms forced reflow; `;
  return `${total}${sites.join("; ")}`;
}

function documentLatencySummary(model: Model<"DocumentLatency">): string {
  const data = model.data;
  if (data === undefined) return "No document request";
  const failed = Object.values(data.checklist)
    .filter((item) => !item.value)
    .map((item) => uiText(item.label));
  const timing = `Server response ${Math.round(data.serverResponseTime)} ms, redirects ${Math.round(data.redirectDuration)} ms`;
  return failed.length > 0 ? `${timing}; failed: ${failed.join("; ")}` : timing;
}

function dependencySummary(model: Model<"NetworkDependencyTree">): string {
  let chain: string[] = [];
  let nodes = model.rootNodes;
  while (nodes.length > 0) {
    const next = nodes.find((node) => node.isLongest) ?? nodes[0];
    if (next === undefined) break;
    chain.push(new URL(next.request.args.data.url).pathname);
    nodes = next.children;
  }
  if (chain.length > 6) chain = [...chain.slice(0, 3), "…", ...chain.slice(-2)];
  return `Critical chain ${ms(model.maxTime)} ms: ${chain.join(" → ") || "none"}`;
}

function genericSummary(model: Model<keyof Models>): string {
  const savings = Object.entries(model.metricSavings ?? {})
    .map(([metric, value]) => `${metric} ${Math.round(Number(value))}`)
    .join(", ");
  return `${uiText(model.title)}${savings === "" ? "" : ` (savings: ${savings})`}`;
}

function summarize(name: keyof Models, models: Models): string | undefined {
  switch (name) {
    case "LCPBreakdown":
      return models.LCPBreakdown && lcpSummary(models.LCPBreakdown);
    case "INPBreakdown":
      return models.INPBreakdown && inpSummary(models.INPBreakdown);
    case "CLSCulprits":
      return models.CLSCulprits && clsSummary(models.CLSCulprits);
    case "RenderBlocking":
      return models.RenderBlocking && renderBlockingSummary(models.RenderBlocking);
    case "ForcedReflow":
      return models.ForcedReflow && forcedReflowSummary(models.ForcedReflow);
    case "DocumentLatency":
      return models.DocumentLatency && documentLatencySummary(models.DocumentLatency);
    case "NetworkDependencyTree":
      return models.NetworkDependencyTree && dependencySummary(models.NetworkDependencyTree);
    default: {
      const model = models[name];
      return model && genericSummary(model);
    }
  }
}

function longestInteraction(sets: InsightSet[]) {
  let longest: Trace.Types.Events.SyntheticInteractionPair | undefined;
  for (const set of sets) {
    const event = set.model.INPBreakdown?.longestInteractionEvent;
    if (event !== undefined && (longest === undefined || event.dur > longest.dur)) longest = event;
  }
  return longest;
}

// Sums the CPU-sample self time per function inside one interaction and
// returns the heaviest page function. LoAF names the event dispatcher; the
// samples name the handler that did the work.
function hotFunction(
  parsed: Trace.TraceModel.ParsedTrace,
  interaction: Trace.Types.Events.SyntheticInteractionPair,
): HotFunction | undefined {
  const thread = parsed.data.Renderer.processes.get(interaction.pid)?.threads.get(interaction.tid);
  if (thread === undefined) return undefined;
  const start = interaction.ts;
  const end = interaction.ts + interaction.dur;
  const totals = new Map<string, HotFunction>();
  for (const call of thread.profileCalls) {
    if (call.ts < start || call.ts >= end || call.callFrame.url === "") continue;
    const self = parsed.data.Renderer.entryToNode.get(call)?.selfTime ?? 0;
    const frame = call.callFrame;
    const key = `${frame.url}:${frame.lineNumber}:${frame.columnNumber}:${frame.functionName}`;
    const total = totals.get(key) ?? {
      function: frame.functionName || "(anonymous)",
      url: frame.url,
      line: frame.lineNumber + 1,
      column: frame.columnNumber + 1,
      selfMs: 0,
    };
    total.selfMs += self / 1000;
    totals.set(key, total);
  }
  let top: HotFunction | undefined;
  for (const total of totals.values())
    if (top === undefined || total.selfMs > top.selfMs) top = total;
  // Under half a millisecond of self time names no culprit, only the last frame sampled.
  if (top === undefined || Math.round(top.selfMs) === 0) return undefined;
  return { ...top, selfMs: Math.round(top.selfMs) };
}

/** Parses one trace with the DevTools trace engine and reduces its insights to short summaries. */
export async function analyzeTrace(events: unknown[]): Promise<TraceAnalysis> {
  const Engine = await loadEngine();
  const model = Engine.TraceModel.Model.createWithAllHandlers();
  try {
    // SAFETY: the events are Chrome's own Tracing output for this run, the input
    // the engine is written for; it checks each event's name and phase itself.
    await model.parse(events as Trace.Types.Events.Event[]);
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    throw new TraceError(`trace_engine could not parse the trace: ${reason}`, { cause: thrown });
  }
  const parsed = model.parsedTrace();
  if (parsed === null) throw new Error("trace_engine parsed the trace but returned no data");
  const sets = [...(parsed.insights?.values() ?? [])].filter((set) =>
    set.url.protocol.startsWith("http"),
  );
  const insights: InsightSummary[] = [];
  const unavailable: TraceAnalysis["unavailable"] = [];
  if (sets.length === 0) {
    for (const name of REQUESTED_INSIGHTS) {
      unavailable.push({
        name,
        reason: "the trace has no page navigation to compute insights for",
      });
    }
  }
  for (const set of sets) {
    const requested = new Set<string>(REQUESTED_INSIGHTS);
    // SAFETY: set.model is the engine's InsightModels object, keyed only by insight names.
    for (const name of Object.keys(set.model) as Array<keyof Models>) {
      const insight = set.model[name];
      if (insight === undefined) continue;
      if (!requested.has(name) && insight.state !== "fail") continue;
      const summary = summarize(name, set.model);
      if (summary === undefined) continue;
      insights.push({ name, page: set.url.href, state: insight.state, summary: cap(summary) });
    }
    for (const name of REQUESTED_INSIGHTS) {
      if (set.model[name] !== undefined) continue;
      const error = set.modelErrors[name];
      unavailable.push({
        name,
        reason:
          error === undefined
            ? `not produced for ${set.url.pathname}`
            : `failed for ${set.url.pathname}: ${error.message}`,
      });
    }
  }
  const longest = longestInteraction(sets);
  return {
    insights,
    unavailable,
    longestInteraction:
      longest === undefined
        ? undefined
        : { id: longest.interactionId, hotFunction: hotFunction(parsed, longest) },
  };
}
