import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import type { BrowserContext, CDPSession, Locator, Page, Request } from "playwright";
import { z } from "zod";

import {
  TimelineEntry,
  type ActionEntry,
  type ActionTarget,
  type NavigationEntry,
} from "../shared/timeline.ts";
import { LabMetric, LoafScript, Verdict, type NetworkPreset } from "../shared/verdict.ts";
import { get } from "../ops/ops.ts";
import { PkaError, readJsonLines, resolveInside } from "../store/store.ts";
import { analyzeTrace } from "./insights.ts";
import {
  computeVerdict,
  type Budgets,
  type RunFailure,
  type RunMetric,
  type RunResult,
} from "./verdict.ts";

export type FlowStep = ActionEntry | NavigationEntry;

// DevTools' presets, from front_end/core/sdk/NetworkManager.ts (Slow4GConditions,
// Fast4GConditions): throughput in bytes per second, latency in ms.
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/core/sdk/NetworkManager.ts
export const NETWORK_PRESETS = {
  slow4g: {
    latencyMs: 150 * 3.75,
    downloadBytesPerSec: ((1.6 * 1000 * 1000) / 8) * 0.9,
    uploadBytesPerSec: ((750 * 1000) / 8) * 0.9,
  },
  fast4g: {
    latencyMs: 60 * 2.75,
    downloadBytesPerSec: ((9 * 1000 * 1000) / 8) * 0.9,
    uploadBytesPerSec: ((1.5 * 1000 * 1000) / 8) * 0.9,
  },
  none: null,
} as const;

// DevTools' Performance panel defaults with JavaScript samples on and
// screenshots off: Trace.Types.Events.DefaultCategories plus
// OptionalCategories.JsSampling in front_end/models/trace/types/TraceEvents.ts.
const TRACE_CATEGORIES = [
  "blink.console",
  "blink.user_timing",
  "loading",
  "devtools.timeline",
  "disabled-by-default-devtools.target-rundown",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.v8-source-rundown-sources",
  "disabled-by-default-devtools.v8-source-rundown",
  "disabled-by-default-layout_shift.debug",
  "disabled-by-default-v8.inspector",
  "disabled-by-default-v8.cpu_profiler.hires",
  "disabled-by-default-lighthouse",
  "v8.execute",
  "v8",
  "cppgc",
  "navigation",
  "rail",
  "disabled-by-default-v8.cpu_profiler",
];

const VIEWPORT = { width: 1280, height: 720 };
const NAVIGATION_TIMEOUT_MS = 60_000;
const LOCATE_TIMEOUT_MS = 15_000;
const QUIET_MS = 500;
const SETTLE_MAX_MS = 10_000;
const TEXT_CAP = 40;
const BINDING = "__pkaLabReport";
const TIMELINE_PATH = "capture/timeline.jsonl";

/** A step that could not be replayed; it fails the run, not the command. */
class StepError extends Error {
  constructor(
    readonly step: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// --- Flow -----------------------------------------------------------------

/** Keeps the actions and navigations of a timeline, in seq order. */
export function flowFromTimeline(entries: TimelineEntry[]): FlowStep[] {
  const steps = entries
    .filter((entry): entry is FlowStep => entry.kind === "action" || entry.kind === "navigation")
    .sort((a, b) => a.seq - b.seq);
  if (!steps.some((step) => step.kind === "action")) {
    throw new PkaError("The flow has no actions; record a flow that clicks or types something.");
  }
  return steps;
}

export async function readFlowFile(file: string): Promise<FlowStep[]> {
  const text = await readFile(file, "utf8");
  const entries = text.split("\n").flatMap((line, index) => {
    if (line.trim() === "") return [];
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch (thrown) {
      throw new PkaError(`Invalid JSON in ${file}:${index + 1}`, { cause: thrown });
    }
    const parsed = TimelineEntry.safeParse(data);
    if (!parsed.success) {
      throw new PkaError(
        `Invalid timeline entry in ${file}:${index + 1}:\n${z.prettifyError(parsed.error)}`,
      );
    }
    return [parsed.data];
  });
  return flowFromTimeline(entries);
}

/** Reads the flow from an annotation's recorded capture/timeline.jsonl. */
export async function readAnnotationFlow(store: string, id: string): Promise<FlowStep[]> {
  const { annotation } = await get(store, { id, detail: "concise" });
  const timeline = annotation.attachments.find((item) => item.path === TIMELINE_PATH);
  if (timeline === undefined) {
    throw new PkaError(
      `Annotation ${id} has no ${TIMELINE_PATH}; record a flow in the overlay or pass a timeline file to --flow.`,
    );
  }
  const file = resolveInside(annotation.dir, timeline.path);
  return flowFromTimeline(await readJsonLines(store, file, TimelineEntry));
}

// --- Page script ----------------------------------------------------------

// Reported from the page through the binding: the latest value per document,
// navigation, and metric. Every string is page-derived.
const PageMetric = z.strictObject({
  doc: z.string(),
  navigation: z.string(),
  name: LabMetric,
  value: z.number(),
  url: z.string(),
  target: z.string().optional(),
  resource: z.string().optional(),
  breakdown: z.record(z.string(), z.number()),
  script: LoafScript.optional(),
});
type PageMetric = z.infer<typeof PageMetric>;

const PageReport = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: "custom", message: "the report is not JSON" });
      return z.NEVER;
    }
  })
  .pipe(PageMetric);

function webVitalsSource(): string {
  // The IIFE build is not in web-vitals' export map; it sits next to the UMD entry.
  const require = createRequire(import.meta.url);
  const entry = require.resolve("web-vitals/attribution");
  return path.join(path.dirname(entry), "web-vitals.attribution.iife.js");
}

async function pageScript(): Promise<string> {
  const iife = (await readFile(webVitalsSource(), "utf8")).replace(
    /\/\/# sourceMappingURL=.*$/m,
    "",
  );
  return `(() => {
if (window !== window.top) return;
${iife}
const doc = Math.random().toString(36).slice(2);
const describe = (node) => {
  if (!(node instanceof Element)) return undefined;
  const tag = node.localName;
  const testId = node.getAttribute("data-testid");
  if (testId) return tag + '[data-testid="' + testId + '"]';
  if (node.id) return tag + "#" + node.id;
  return undefined;
};
const send = (metric, extra) => {
  const report = window[${JSON.stringify(BINDING)}];
  if (typeof report !== "function") return;
  report(JSON.stringify({
    doc,
    navigation: String(metric.navigationId ?? ""),
    name: metric.name,
    value: metric.value,
    url: metric.navigationURL || location.href,
    ...extra,
  }));
};
const options = { reportAllChanges: true, reportSoftNavs: true, generateTarget: describe };
webVitals.onLCP((metric) => {
  const a = metric.attribution;
  send(metric, {
    target: a.target,
    resource: a.url,
    breakdown: {
      timeToFirstByte: a.timeToFirstByte,
      resourceLoadDelay: a.resourceLoadDelay,
      resourceLoadDuration: a.resourceLoadDuration,
      elementRenderDelay: a.elementRenderDelay,
    },
  });
}, options);
webVitals.onINP((metric) => {
  const a = metric.attribution;
  const longest = a.longestScript;
  send(metric, {
    target: a.interactionTarget,
    breakdown: {
      inputDelay: a.inputDelay,
      processingDuration: a.processingDuration,
      presentationDelay: a.presentationDelay,
    },
    script: longest && {
      url: longest.entry.sourceURL,
      function: longest.entry.sourceFunctionName,
      invoker: longest.entry.invoker,
      subpart: longest.subpart,
      durationMs: longest.intersectingDuration,
    },
  });
}, { ...options, durationThreshold: 16 });
webVitals.onCLS((metric) => {
  const a = metric.attribution;
  send(metric, {
    target: a.largestShiftTarget,
    breakdown: a.largestShiftValue === undefined ? {} : { largestShiftValue: a.largestShiftValue },
  });
}, options);
})();`;
}

// --- Replay ---------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Recorded text and labels are whitespace-normalized and cut at 40 characters.
function nameMatcher(text: string): RegExp {
  const escaped = escapeRegExp(text).replace(/ /g, "\\s+");
  return new RegExp(text.length >= TEXT_CAP ? `^\\s*${escaped}` : `^\\s*${escaped}\\s*$`);
}

type AriaRole = Parameters<Page["getByRole"]>[0];

const IMPLICIT_ROLES = new Map<string, AriaRole>([
  ["a", "link"],
  ["button", "button"],
  ["select", "combobox"],
  ["textarea", "textbox"],
  ["summary", "button"],
  ["h1", "heading"],
  ["h2", "heading"],
  ["h3", "heading"],
]);

function candidates(page: Page, target: ActionTarget): Array<[string, Locator]> {
  const found: Array<[string, Locator]> = [];
  if (target.testId !== undefined) found.push(["testId", page.getByTestId(target.testId)]);
  if (target.id !== undefined) {
    found.push(["id", page.locator(`[id="${target.id.replace(/["\\]/g, "\\$&")}"]`)]);
  }
  const name = target.text ?? target.label;
  // SAFETY: a recorded role attribute is any string; locate() treats a role
  // Playwright rejects as a strategy that found nothing.
  const role = (target.role as AriaRole | undefined) ?? IMPLICIT_ROLES.get(target.tag);
  if (role !== undefined && name !== undefined) {
    found.push(["role", page.getByRole(role, { name: nameMatcher(name) })]);
  }
  if (target.label !== undefined) found.push(["label", page.getByLabel(nameMatcher(target.label))]);
  if (target.text !== undefined) {
    found.push([
      "text",
      page.locator(target.tag).filter({ hasText: nameMatcher(target.text), visible: true }),
    ]);
  }
  return found;
}

/** Finds the one element a recorded descriptor names, waiting for it to render. */
async function locate(page: Page, target: ActionTarget, step: number): Promise<Locator> {
  const strategies = candidates(page, target);
  if (strategies.length === 0) {
    throw new StepError(
      step,
      `Step ${step}: the target ${JSON.stringify(target)} has no test id, id, role, label, or text to find it by`,
    );
  }
  const deadline = Date.now() + LOCATE_TIMEOUT_MS;
  let notes: string[] = [];
  for (;;) {
    notes = [];
    for (const [strategy, locator] of strategies) {
      let count: number;
      try {
        count = await locator.count();
      } catch (thrown) {
        if (page.isClosed()) throw thrown;
        notes.push(
          `${strategy} rejected: ${thrown instanceof Error ? thrown.message.split("\n")[0] : String(thrown)}`,
        );
        continue;
      }
      if (count === 1) return locator;
      if (count > 1) notes.push(`${strategy} matched ${count}`);
    }
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  const why = notes.length > 0 ? notes.join(", ") : "nothing matched";
  throw new StepError(step, `Step ${step}: cannot find ${JSON.stringify(target)} (${why})`);
}

function placeholder(type: string): string {
  if (type === "number" || type === "range") return "1";
  if (type === "email") return "lab@example.com";
  if (type === "url") return "https://example.com";
  if (type === "tel") return "5550100";
  return "pka lab";
}

function sameTarget(a: ActionTarget, b: ActionTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Tracker {
  /** True when no request is in flight and none started or ended in the last 500 ms after `since`. */
  quiet(since: number): boolean;
}

function trackRequests(page: Page): Tracker {
  const inflight = new Set<Request>();
  let lastChange = Date.now();
  page.on("request", (request) => {
    if (request.resourceType() === "eventsource" || request.resourceType() === "websocket") return;
    inflight.add(request);
    lastChange = Date.now();
  });
  const done = (request: Request): void => {
    if (inflight.delete(request)) lastChange = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return {
    quiet: (since) => inflight.size === 0 && Date.now() - Math.max(lastChange, since) >= QUIET_MS,
  };
}

// Waits until the step has been quiet for 500 ms, at most 10 s. The window
// starts when the step ends, not at the last request: a click that starts no
// request still needs time to paint, or its Event Timing entry (and so INP)
// never exists. A stream that never ends reaches the cap and the flow continues.
async function settle(page: Page, tracker: Tracker): Promise<void> {
  const since = Date.now();
  const deadline = since + SETTLE_MAX_MS;
  while (!tracker.quiet(since) && Date.now() < deadline) await sleep(50);
  await page.waitForLoadState("load", { timeout: NAVIGATION_TIMEOUT_MS });
}

function samePage(current: string, target: string): boolean {
  const a = new URL(current);
  const b = new URL(target);
  return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
}

interface Field {
  kind: "checkable" | "select" | "text";
  inputType: string;
}

async function fieldOf(locator: Locator): Promise<Field> {
  const { tag, inputType } = await locator.evaluate((element) => ({
    tag: element.localName,
    inputType: element instanceof HTMLInputElement ? element.type : "",
  }));
  if (inputType === "checkbox" || inputType === "radio") return { kind: "checkable", inputType };
  return { kind: tag === "select" ? "select" : "text", inputType };
}

// One user gesture on a checkbox or select records click, input, and change;
// the replayed gesture already produced the later events.
function alreadyCaused(step: ActionEntry, previous: FlowStep | undefined, field: Field): boolean {
  if (previous?.kind !== "action" || !sameTarget(previous.target, step.target)) return false;
  if (field.kind === "checkable") return step.type !== "click" && previous.type !== "change";
  return field.kind === "select" && step.type === "change" && previous.type === "input";
}

async function enterValue(locator: Locator, field: Field): Promise<void> {
  if (field.kind === "checkable") await locator.click({ timeout: LOCATE_TIMEOUT_MS });
  else if (field.kind === "select") await selectAnother(locator);
  else {
    await locator.fill("", { timeout: LOCATE_TIMEOUT_MS });
    await locator.pressSequentially(placeholder(field.inputType));
  }
}

async function replayAction(
  page: Page,
  step: ActionEntry,
  previous: FlowStep | undefined,
  index: number,
): Promise<void> {
  // A submit right after a click or Enter is that gesture's consequence.
  if (step.type === "submit" && previous?.kind === "action") {
    if (previous.type === "click" || (previous.type === "keydown" && previous.key === "Enter"))
      return;
  }
  const locator = await locate(page, step.target, index);
  const field = await fieldOf(locator);
  if (alreadyCaused(step, previous, field)) return;
  switch (step.type) {
    case "click":
      await locator.click({ timeout: LOCATE_TIMEOUT_MS });
      return;
    case "input":
      await enterValue(locator, field);
      return;
    case "change":
      if (field.kind === "text") await locator.blur();
      else await enterValue(locator, field);
      return;
    case "submit":
      await locator.evaluate((element) => {
        if (!(element instanceof HTMLFormElement))
          throw new Error(`submit target is <${element.localName}>, not a form`);
        element.requestSubmit();
      });
      return;
    case "keydown":
      if (step.key === undefined)
        throw new StepError(index, `Step ${index}: keydown without Enter or Escape`);
      await locator.press(step.key, { timeout: LOCATE_TIMEOUT_MS });
      return;
  }
}

async function selectAnother(locator: Locator): Promise<void> {
  const next = await locator.evaluate((element) => {
    if (!(element instanceof HTMLSelectElement)) throw new Error("not a select");
    const options = [...element.options].filter((option) => !option.disabled);
    const other = options.find((option) => option.index !== element.selectedIndex);
    if (other === undefined) throw new Error("the select has no other enabled option");
    return other.value;
  });
  await locator.selectOption(next);
}

/** Maps a recorded URL onto the build under test when it points at the recorded app. */
function rebase(recorded: string, appOrigin: string | undefined, base: URL): string {
  const url = new URL(recorded, base);
  if (appOrigin !== undefined && url.origin !== appOrigin) return url.href;
  return new URL(url.pathname + url.search + url.hash, base).href;
}

async function replay(page: Page, tracker: Tracker, steps: FlowStep[], base: URL): Promise<void> {
  const first = steps.find((step) => step.kind === "navigation");
  const appOrigin = first === undefined ? undefined : new URL(first.to, base).origin;
  if (steps[0]?.kind !== "navigation") {
    await page.goto(base.href, { timeout: NAVIGATION_TIMEOUT_MS });
    await settle(page, tracker);
  }
  for (const [index, step] of steps.entries()) {
    try {
      if (step.kind === "navigation") {
        const target = rebase(step.to, appOrigin, base);
        if (step.type === "reload") {
          await flushVitals(page);
          await page.reload({ timeout: NAVIGATION_TIMEOUT_MS });
          // A push, replace, or traverse the previous action already caused is skipped.
        } else if (step.type === "load" || !samePage(page.url(), target)) {
          await flushVitals(page);
          await page.goto(target, { timeout: NAVIGATION_TIMEOUT_MS });
        }
      } else {
        await replayAction(page, step, steps[index - 1], index);
      }
      await settle(page, tracker);
    } catch (thrown) {
      if (thrown instanceof StepError) throw thrown;
      const descriptor =
        step.kind === "action"
          ? `${step.type} ${JSON.stringify(step.target)}`
          : `${step.type} ${step.to}`;
      const reason = thrown instanceof Error ? thrown.message.split("\n")[0] : String(thrown);
      throw new StepError(index, `Step ${index} (${descriptor}) failed: ${reason}`, {
        cause: thrown,
      });
    }
  }
  await flushVitals(page);
}

// web-vitals processes Event Timing entries in a requestIdleCallback with a
// 1 s timeout (lib/whenIdleOrHidden.js), so under CPU throttling the INP of a
// page's last interaction arrives up to a second after it. Leaving the page or
// ending the trace first loses it; leaving did not trigger web-vitals' hidden
// path here. An idle callback queued now runs after the pending one, and its
// binding report reaches Node before this evaluate resolves.
async function flushVitals(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestIdleCallback(() => resolve(), { timeout: 2000 });
      }),
  );
}

// --- Tracing --------------------------------------------------------------

async function startTrace(cdp: CDPSession): Promise<void> {
  await cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: { includedCategories: TRACE_CATEGORIES, excludedCategories: ["*"] },
  });
}

async function endTrace(cdp: CDPSession): Promise<string> {
  const complete = new Promise<string>((resolve, reject) => {
    cdp.once("Tracing.tracingComplete", (event) => {
      if (event.stream === undefined) reject(new Error("Chrome returned no trace stream"));
      else resolve(event.stream);
    });
  });
  await cdp.send("Tracing.end");
  const handle = await complete;
  const chunks: Buffer[] = [];
  for (;;) {
    const read = await cdp.send("IO.read", { handle });
    chunks.push(Buffer.from(read.data, read.base64Encoded === true ? "base64" : "utf8"));
    if (read.eof) break;
  }
  await cdp.send("IO.close", { handle });
  return Buffer.concat(chunks).toString("utf8");
}

// Chrome streams either a bare event array or an object with traceEvents and metadata.
const TraceFile = z.union([
  z.array(z.unknown()),
  z.looseObject({ traceEvents: z.array(z.unknown()) }).transform((file) => file.traceEvents),
]);

// --- Runs -----------------------------------------------------------------

function worstPerMetric(reports: Map<string, PageMetric>): RunResult["metrics"] {
  const metrics: RunResult["metrics"] = {};
  for (const report of reports.values()) {
    const current = metrics[report.name];
    if (current !== undefined && current.value >= report.value) continue;
    const measured: RunMetric = {
      value: report.value,
      page: report.url,
      element: report.target,
      resource: report.resource,
      breakdown: report.breakdown,
      script: report.script,
    };
    metrics[report.name] = measured;
  }
  return metrics;
}

interface RunContext {
  context: BrowserContext;
  steps: FlowStep[];
  base: URL;
  cpuRate: number;
  network: NetworkPreset;
  tracePath: string;
}

async function runOnce(run: number, options: RunContext): Promise<RunResult> {
  const { context } = options;
  const reports = new Map<string, PageMetric>();
  const invalid: string[] = [];
  await context.exposeBinding(BINDING, (_source, report: string) => {
    const parsed = PageReport.safeParse(report);
    if (!parsed.success) {
      invalid.push(z.prettifyError(parsed.error));
      return;
    }
    const metric = parsed.data;
    reports.set(`${metric.doc}:${metric.navigation}:${metric.name}`, metric);
  });
  await context.addInitScript({ content: await pageScript() });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpuRate });
  const network = NETWORK_PRESETS[options.network];
  await cdp.send("Network.enable");
  if (network !== null) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: network.latencyMs,
      downloadThroughput: network.downloadBytesPerSec,
      uploadThroughput: network.uploadBytesPerSec,
    });
  }
  const tracker = trackRequests(page);
  await startTrace(cdp);
  try {
    await replay(page, tracker, options.steps, options.base);
  } catch (thrown) {
    // The run already failed; a trace that cannot be ended (target closed,
    // renderer crashed) is dropped so the step error stays the reported cause.
    const traceError = await endTrace(cdp).then(
      () => undefined,
      (failure: Error) => failure.message,
    );
    if (thrown instanceof StepError && traceError !== undefined) {
      throw new StepError(thrown.step, `${thrown.message} (trace discarded: ${traceError})`, {
        cause: thrown,
      });
    }
    throw thrown;
  }
  const trace = await endTrace(cdp);
  if (invalid.length > 0) {
    throw new Error(`Run ${run}: the page script sent an invalid metric report:\n${invalid[0]}`);
  }
  await writeFile(options.tracePath, await promisify(gzip)(trace));
  const analysis = await analyzeTrace(TraceFile.parse(JSON.parse(trace)));
  return { run, metrics: worstPerMetric(reports), trace: options.tracePath, analysis };
}

export interface LabOptions {
  url: string;
  flow: FlowStep[];
  flowLabel: string;
  runs: number;
  cpuRate: number;
  network: NetworkPreset;
  budgets: Budgets;
  out: string;
  /** Called after each run with its number, for progress on stderr. */
  onRun: (run: number, failure: RunFailure | undefined) => void;
}

async function loadPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch (thrown) {
    if (thrown instanceof Error && "code" in thrown && thrown.code === "ERR_MODULE_NOT_FOUND") {
      throw new PkaError(
        "pka lab needs Playwright, an optional peer dependency: pnpm add -D playwright && pnpm exec playwright install chromium",
        { cause: thrown },
      );
    }
    throw thrown;
  }
}

/** Replays the flow `runs` times in fresh contexts and writes <out>/verdict.json. */
export async function runLab(options: LabOptions): Promise<{ verdict: Verdict; file: string }> {
  const { chromium } = await loadPlaywright();
  const base = new URL(options.url);
  const out = path.resolve(options.out);
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({
    channel: "chromium",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const results: RunResult[] = [];
  const failures: RunFailure[] = [];
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      const context = await browser.newContext({ viewport: VIEWPORT });
      try {
        results.push(
          await runOnce(run, {
            context,
            steps: options.flow,
            base,
            cpuRate: options.cpuRate,
            network: options.network,
            tracePath: path.join(out, `trace-${run}.json.gz`),
          }),
        );
        options.onRun(run, undefined);
      } catch (thrown) {
        if (!(thrown instanceof StepError)) throw thrown;
        const failure = { run, step: thrown.step, message: thrown.message };
        failures.push(failure);
        options.onRun(run, failure);
      } finally {
        await context.close();
      }
    }
    const network = NETWORK_PRESETS[options.network];
    const verdict = Verdict.parse(
      computeVerdict({
        createdAt: new Date().toISOString(),
        conditions: {
          url: base.href,
          flow: options.flowLabel,
          steps: options.flow.length,
          runs: options.runs,
          cpuRate: options.cpuRate,
          network: options.network,
          networkConditions: network === null ? null : { ...network },
          cache: "cold",
          chromium: browser.version(),
          viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
        },
        budgets: options.budgets,
        runs: results,
        failures,
      }),
    );
    const file = path.join(out, "verdict.json");
    await writeFile(file, `${JSON.stringify(verdict, null, 2)}\n`);
    return { verdict, file };
  } finally {
    await browser.close();
  }
}
