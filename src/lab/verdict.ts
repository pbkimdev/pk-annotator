import { z } from "zod";

import {
  LabMetric,
  type Culprit,
  type HotFunction,
  type InsightVerdict,
  type LoafScript,
  type MetricVerdict,
  type Verdict,
} from "../shared/verdict.ts";

export interface Budgets {
  LCP: number;
  INP: number;
  CLS: number;
}

// Core Web Vitals "good" thresholds: https://web.dev/articles/vitals
export const DEFAULT_BUDGETS = { LCP: 2500, INP: 200, CLS: 0.1 } satisfies Budgets;

/** Parses `lcp=2500,inp=200,cls=0.1`; metrics left out keep the Core Web Vitals "good" threshold. */
export const BudgetOption = z
  .string()
  .optional()
  .transform((text, ctx): Budgets => {
    const budgets = { ...DEFAULT_BUDGETS };
    if (text === undefined) return budgets;
    const seen = new Set<string>();
    for (const part of text.split(",")) {
      const match = /^(lcp|inp|cls)=(\d+(?:\.\d+)?)$/.exec(part.trim());
      if (match === null || match[1] === undefined || match[2] === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `budget entry ${JSON.stringify(part)} must look like lcp=2500, inp=200, or cls=0.1`,
        });
        return z.NEVER;
      }
      if (seen.has(match[1])) {
        ctx.addIssue({ code: "custom", message: `budget names ${match[1]} twice` });
        return z.NEVER;
      }
      seen.add(match[1]);
      budgets[LabMetric.parse(match[1].toUpperCase())] = Number(match[2]);
    }
    return budgets;
  });

/** The worst value of one metric across the pages of one run, with what caused it. */
export interface RunMetric {
  value: number;
  page: string;
  element?: string | undefined;
  resource?: string | undefined;
  breakdown: Record<string, number>;
  script?: LoafScript | undefined;
  /** The Event Timing interactionId of an INP value. */
  interaction?: number | undefined;
}

export interface InsightSummary {
  name: string;
  page: string;
  state: InsightVerdict["state"];
  summary: string;
}

export interface TraceAnalysis {
  insights: InsightSummary[];
  unavailable: Array<{ name: string; reason: string }>;
  longestInteraction: { id: number; hotFunction: HotFunction | undefined } | undefined;
}

/** What the separate traced run contributes; its metrics are not samples. */
export interface Diagnostic {
  insights: InsightSummary[];
  unavailable: Array<{ name: string; reason: string }>;
  /** The heaviest function of the traced run's INP interaction, and where that interaction was. */
  hot: { hotFunction: HotFunction; page: string; element: string | undefined } | undefined;
}

/** One untraced run: a verdict sample. */
export interface RunResult {
  run: number;
  metrics: Partial<Record<LabMetric, RunMetric>>;
}

export interface RunFailure {
  run: number;
  step?: number;
  message: string;
}

export interface VerdictInput {
  createdAt: string;
  conditions: Verdict["conditions"];
  budgets: Budgets;
  runs: RunResult[];
  failures: RunFailure[];
  diagnostic: Diagnostic;
  traces: string[];
}

const CULPRIT_INSIGHT = {
  LCP: "LCPBreakdown",
  INP: "INPBreakdown",
  CLS: "CLSCulprits",
} satisfies Record<LabMetric, string>;

function round(metric: LabMetric, value: number): number {
  return metric === "CLS" ? Math.round(value * 10_000) / 10_000 : Math.round(value);
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new Error("median of an empty list");
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new Error("median index out of range");
  return (lower + upper) / 2;
}

function pagePath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function culpritFor(
  metric: LabMetric,
  result: RunResult,
  measured: RunMetric,
  diagnostic: Diagnostic,
): Culprit {
  const insights = diagnostic.insights.filter(
    (insight) => insight.name === CULPRIT_INSIGHT[metric],
  );
  const insight =
    insights.find((candidate) => pagePath(candidate.page) === pagePath(measured.page)) ??
    (insights.length === 1 ? insights[0] : undefined);
  const culprit: Culprit = {
    run: result.run,
    page: measured.page,
    breakdown: Object.fromEntries(
      Object.entries(measured.breakdown).map(([name, value]) => [name, round(metric, value)]),
    ),
  };
  if (measured.element !== undefined) culprit.element = measured.element;
  if (measured.resource !== undefined) culprit.resource = measured.resource;
  if (measured.script !== undefined) {
    culprit.script = { ...measured.script, durationMs: Math.round(measured.script.durationMs) };
  }
  if (insight !== undefined) culprit.insight = insight.summary;
  return culprit;
}

function metricVerdict(metric: LabMetric, input: VerdictInput): MetricVerdict {
  const byRun = new Map(input.runs.map((result) => [result.run, result]));
  const values = Array.from({ length: input.conditions.runs }, (_, index) => {
    const measured = byRun.get(index + 1)?.metrics[metric];
    return measured === undefined ? null : round(metric, measured.value);
  });
  const budget = input.budgets[metric];
  const unit = metric === "CLS" ? "score" : "ms";
  const present = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (present.length === 0) {
    return {
      unit,
      values,
      median: null,
      min: null,
      max: null,
      band: null,
      budget,
      status: "unmeasured",
      note:
        input.runs.length === 0
          ? "No run completed; see failures"
          : metric === "INP"
            ? "No interaction of 16 ms or longer was reported; the flow may have no clicks, keys, or taps"
            : `No run reported ${metric}`,
    };
  }
  const middle = round(metric, median(present));
  const min = present[0] ?? middle;
  const max = present.at(-1) ?? middle;
  // The run closest to the median, preferring the worse one on a tie, supplies the culprit.
  let representative: RunResult | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const result of input.runs) {
    const measured = result.metrics[metric];
    if (measured === undefined) continue;
    const gap = Math.abs(round(metric, measured.value) - middle);
    const current = representative?.metrics[metric]?.value ?? Number.NEGATIVE_INFINITY;
    if (gap < distance || (gap === distance && measured.value > current)) {
      representative = result;
      distance = gap;
    }
  }
  const measured = representative?.metrics[metric];
  if (representative === undefined || measured === undefined) {
    throw new Error(`no representative run for ${metric} although values exist`);
  }
  return {
    unit,
    values,
    median: middle,
    min,
    max,
    band: round(metric, max - min),
    budget,
    status: middle <= budget ? "pass" : "fail",
    culprit: culpritFor(metric, representative, measured, input.diagnostic),
  };
}

function aggregateInsights(insights: InsightSummary[]): InsightVerdict[] {
  const groups = new Map<string, InsightVerdict>();
  for (const insight of insights) {
    const page = pagePath(insight.page);
    const key = `${insight.name}\u0000${page}`;
    const group = groups.get(key) ?? {
      name: insight.name,
      page,
      state: insight.state,
      runs: 0,
      failed: 0,
      summary: insight.summary,
    };
    group.runs += 1;
    if (insight.state === "fail") {
      group.failed += 1;
      group.state = "fail";
      group.summary = insight.summary;
    } else if (group.failed === 0) {
      group.state = insight.state;
      group.summary = insight.summary;
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

function formatValue(metric: LabMetric, value: number): string {
  return metric === "CLS" ? value.toFixed(3) : `${value} ms`;
}

/** One line for the perf attachment summary and the first line of the CLI output. */
export function summarizeVerdict(verdict: Verdict): string {
  const metrics = LabMetric.options.map((metric) => {
    const result = verdict.metrics[metric];
    if (result.median === null) return `${metric} unmeasured`;
    const over = result.status === "fail" ? ` > ${formatValue(metric, result.budget)}` : "";
    return `${metric} ${formatValue(metric, result.median)} ${result.status}${over}`;
  });
  const { conditions } = verdict;
  const failed = verdict.failures.length > 0 ? `, ${verdict.failures.length} failed` : "";
  return `lab ${verdict.status}: ${metrics.join(", ")} (median of ${conditions.runs} runs${failed}, ${conditions.cpuRate}x CPU, ${conditions.network})`;
}

export function computeVerdict(input: VerdictInput): Verdict {
  const metrics = {
    LCP: metricVerdict("LCP", input),
    INP: metricVerdict("INP", input),
    CLS: metricVerdict("CLS", input),
  };
  const computed = new Set(input.diagnostic.insights.map((insight) => insight.name));
  const unavailable = new Map<string, { name: string; reason: string }>();
  for (const missing of input.diagnostic.unavailable) {
    if (!computed.has(missing.name)) {
      unavailable.set(`${missing.name}\u0000${missing.reason}`, missing);
    }
  }
  // The hot function comes from another run; it names the culprit's work only
  // when that run's INP was on the same element and page.
  const culprit = metrics.INP.culprit;
  const hot = input.diagnostic.hot;
  if (culprit !== undefined && hot !== undefined) {
    if (
      hot.element !== undefined &&
      hot.element === culprit.element &&
      pagePath(hot.page) === pagePath(culprit.page)
    ) {
      culprit.hotFunction = hot.hotFunction;
    } else {
      const where = `${hot.element ?? "an unnamed element"} on ${pagePath(hot.page)}`;
      const missing = {
        name: "hotFunction",
        reason: `the traced run's INP was ${where}, not the INP culprit's interaction`,
      };
      unavailable.set(`${missing.name}\u0000${missing.reason}`, missing);
    }
  }
  const statuses = Object.values(metrics).map((metric) => metric.status);
  const status = statuses.includes("fail")
    ? "fail"
    : statuses.includes("unmeasured") || input.failures.length > 0
      ? "incomplete"
      : "pass";
  return {
    version: 1,
    createdAt: input.createdAt,
    status,
    conditions: input.conditions,
    metrics,
    insights: aggregateInsights(input.diagnostic.insights),
    unavailable: [...unavailable.values()],
    failures: input.failures,
    traces: input.traces,
  };
}
