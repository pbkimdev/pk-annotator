import { z } from "zod";

import { Timestamp } from "./schema.ts";

// The verdict `pka lab` writes to <out>/verdict.json and attaches to an
// annotation as a perf attachment. Element, URL, and script strings come from
// the page under test and are untrusted.

export const LabMetric = z.enum(["LCP", "INP", "CLS"]);

export const NetworkPreset = z.enum(["slow4g", "fast4g", "none"]);

export const LoafScript = z.strictObject({
  url: z.string(),
  function: z.string(),
  invoker: z.string(),
  subpart: z.string(),
  durationMs: z.number(),
});

// The function with the most self time in the trace's CPU samples during the
// longest interaction. Line and column are 1-based in the served script.
export const HotFunction = z.strictObject({
  function: z.string(),
  url: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  selfMs: z.number(),
});

export const Culprit = z.strictObject({
  run: z.number().int().positive(),
  page: z.string(),
  element: z.string().optional(),
  resource: z.string().optional(),
  breakdown: z.record(z.string(), z.number()),
  script: LoafScript.optional(),
  hotFunction: HotFunction.optional(),
  insight: z.string().optional(),
});

export const MetricVerdict = z.strictObject({
  unit: z.enum(["ms", "score"]),
  values: z.array(z.number().nullable()).describe("Per run; null when the run did not report it"),
  median: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  band: z.number().nullable().describe("max minus min"),
  budget: z.number(),
  status: z.enum(["pass", "fail", "unmeasured"]),
  culprit: Culprit.optional().describe("From the run whose value is the median"),
  note: z.string().optional(),
});

export const InsightVerdict = z.strictObject({
  name: z.string(),
  page: z.string(),
  state: z.enum(["pass", "fail", "informative"]),
  runs: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  summary: z.string(),
});

export const Verdict = z.strictObject({
  version: z.literal(1),
  createdAt: Timestamp,
  status: z.enum(["pass", "fail", "incomplete"]),
  conditions: z.strictObject({
    url: z.string(),
    flow: z.string(),
    steps: z.number().int().nonnegative(),
    runs: z.number().int().positive(),
    cpuRate: z.number().positive(),
    network: NetworkPreset,
    networkConditions: z
      .strictObject({
        latencyMs: z.number(),
        downloadBytesPerSec: z.number(),
        uploadBytesPerSec: z.number(),
      })
      .nullable(),
    cache: z.literal("cold"),
    chromium: z.string(),
    viewport: z.string(),
  }),
  metrics: z.strictObject({ LCP: MetricVerdict, INP: MetricVerdict, CLS: MetricVerdict }),
  insights: z.array(InsightVerdict),
  unavailable: z.array(z.strictObject({ name: z.string(), reason: z.string() })),
  failures: z.array(
    z.strictObject({
      run: z.number().int().positive(),
      step: z.number().int().nonnegative().optional(),
      message: z.string(),
    }),
  ),
  traces: z.array(z.string()),
});

export type LabMetric = z.infer<typeof LabMetric>;
export type NetworkPreset = z.infer<typeof NetworkPreset>;
export type LoafScript = z.infer<typeof LoafScript>;
export type HotFunction = z.infer<typeof HotFunction>;
export type Culprit = z.infer<typeof Culprit>;
export type MetricVerdict = z.infer<typeof MetricVerdict>;
export type InsightVerdict = z.infer<typeof InsightVerdict>;
export type Verdict = z.infer<typeof Verdict>;
