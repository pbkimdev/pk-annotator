import { describe, expect, it } from "vitest";

import { Verdict } from "../shared/verdict.ts";
import { DEFAULT_BUDGETS, computeVerdict, type RunMetric, type RunResult } from "./verdict.ts";

function run(n: number, metrics: RunResult["metrics"]): RunResult {
  return {
    run: n,
    metrics,
    trace: `/tmp/out/trace-${n}.json.gz`,
    analysis: {
      insights: [
        {
          name: "INPBreakdown",
          page: "http://127.0.0.1:3210/lab",
          state: n === 2 ? "pass" : "fail",
          summary: `run ${n}`,
        },
      ],
      unavailable: [{ name: "ForcedReflow", reason: "not produced for /lab" }],
      hotFunction: undefined,
    },
  };
}

const inp = (value: number): RunMetric => ({
  value,
  page: "http://127.0.0.1:3210/lab",
  element: 'button[data-testid="lab-slow"]',
  breakdown: { inputDelay: 1.4, processingDuration: value - 10, presentationDelay: 8.6 },
});

describe("computeVerdict", () => {
  it("takes the median, band, and budget status per metric and the culprit from the median run", () => {
    const verdict = computeVerdict({
      createdAt: "2026-10-02T12:00:00.000Z",
      conditions: {
        url: "http://127.0.0.1:3210/",
        flow: "/tmp/flow.jsonl",
        steps: 4,
        runs: 4,
        cpuRate: 4,
        network: "slow4g",
        networkConditions: {
          latencyMs: 562.5,
          downloadBytesPerSec: 180000,
          uploadBytesPerSec: 84375,
        },
        cache: "cold",
        chromium: "153.0.8010.12",
        viewport: "1280x720",
      },
      budgets: { ...DEFAULT_BUDGETS, CLS: 0.05 },
      runs: [
        run(1, { INP: inp(300.4), LCP: { value: 1000, page: "p", breakdown: {} } }),
        run(2, { INP: inp(250), CLS: { value: 0.04, page: "p", breakdown: {} } }),
        run(3, { INP: inp(320), LCP: { value: 1200, page: "p", breakdown: {} } }),
      ],
      failures: [{ run: 4, step: 1, message: "Step 1: cannot find" }],
    });

    expect(Verdict.parse(verdict)).toEqual(verdict);
    expect(verdict.metrics.INP).toMatchObject({
      values: [300, 250, 320, null],
      median: 300,
      min: 250,
      max: 320,
      band: 70,
      budget: 200,
      status: "fail",
      culprit: {
        run: 1,
        element: 'button[data-testid="lab-slow"]',
        breakdown: { inputDelay: 1, processingDuration: 290, presentationDelay: 9 },
        insight: "run 1",
      },
    });
    expect(verdict.metrics.LCP).toMatchObject({ median: 1100, band: 200, status: "pass" });
    expect(verdict.metrics.CLS).toMatchObject({ values: [null, 0.04, null, null], status: "pass" });
    expect(verdict.status).toBe("fail");
    expect(verdict.insights).toEqual([
      { name: "INPBreakdown", page: "/lab", state: "fail", runs: 3, failed: 2, summary: "run 3" },
    ]);
    expect(verdict.unavailable).toEqual([
      { name: "ForcedReflow", reason: "not produced for /lab" },
    ]);
  });
});
