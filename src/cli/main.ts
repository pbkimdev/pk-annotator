#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { readAnnotationFlow, readFlowFile, runLab, type FlowStep } from "../lab/lab.ts";
import { BudgetOption, summarizeVerdict } from "../lab/verdict.ts";
import {
  attach,
  ErrorsInput,
  GetInput,
  ListInput,
  ReplyInput,
  SetStatusInput,
  errors,
  get,
  list,
  prune,
  reply,
  setStatus,
  validateAttachTarget,
  wait,
  type ErrorsResult,
  type PruneResult,
  type ReplyResult,
  type SetStatusResult,
  type GetResult,
  type ListResult,
} from "../ops/ops.ts";
import type { AnnotationView } from "../ops/views.ts";
import { ID_PATTERN, Id } from "../shared/schema.ts";
import { LabMetric, NetworkPreset, type Verdict } from "../shared/verdict.ts";
import { PkaError, findStore, isErrno } from "../store/store.ts";

const USAGE = `Usage: pka [--root DIR] [--json] <command>

  list [--status pending|acknowledged|resolved|dismissed|all] [--limit N] [--cursor ID] [--detail concise|full]
  get <id> [--detail concise|full]
  watch [--once] [--timeout SECONDS]    one line per new pending annotation
  status <id> <acknowledged|resolved|dismissed> [--note TEXT]
  reply <id> <text>
  errors [--since ISO-TIME] [--limit N] [--detail concise|full]
  prune                                 remove resolved and dismissed annotations older than 7 days
  lab --url URL --flow FILE|ID [--runs 5] [--cpu 4] [--network slow4g|fast4g|none]
      [--budget lcp=2500,inp=200,cls=0.1] [--attach ID] [--out DIR]
                                        replay a recorded flow against a production build
                                        and write <out>/verdict.json (needs playwright)

The store is <root>/_interim/annotations. Without --root or PKA_ROOT, pka uses
CLAUDE_PROJECT_DIR, then the nearest parent of the working directory that has one.
status acknowledged claims an annotation as $PKA_CLAIMANT (default pka-cli); later
status changes, replies, and lab --attach must come from the same claimant.
pka lab: --flow is a timeline.jsonl file or an annotation id with a recording
(its timeline.jsonl sits beside capture/summary.md). Budgets left out use the Core Web Vitals "good"
thresholds. --out defaults to $TMPDIR/pka-lab/<time>. --attach adds the
verdict to that annotation as a perf attachment.
Exit codes: 0 ok, 1 operation error, 2 usage error, 3 lab verdict is fail or incomplete.`;

const COMMAND_OPTIONS = {
  list: ["status", "limit", "cursor", "detail"],
  get: ["detail"],
  watch: ["once", "timeout"],
  status: ["note"],
  reply: [],
  errors: ["since", "limit", "detail"],
  prune: [],
  lab: ["url", "flow", "runs", "cpu", "network", "budget", "attach", "out"],
} as const;
const POSITIONALS = {
  list: 0,
  get: 1,
  watch: 0,
  status: 2,
  reply: 2,
  errors: 0,
  prune: 0,
  lab: 0,
} as const;
const Command = z.enum(["list", "get", "watch", "status", "reply", "errors", "prune", "lab"]);
type Command = z.infer<typeof Command>;

const WatchInput = z.strictObject({
  once: z.boolean(),
  timeout: z.number().positive().max(86_400).optional(),
});

const LabInput = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  flow: z.string().min(1),
  runs: z.number().int().min(1).max(50).default(5),
  cpu: z.number().min(1).max(20).default(4),
  network: NetworkPreset.default("slow4g"),
  budget: BudgetOption,
  attach: Id.optional(),
  out: z.string().min(1).optional(),
});

class UsageError extends Error {
  override name = "UsageError";
}

// Each shell call is a new process, so the claimant cannot be a pid.
function cliClaimant(): string {
  const parsed = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .safeParse(process.env.PKA_CLAIMANT ?? "pka-cli");
  if (!parsed.success) throw new UsageError("PKA_CLAIMANT must be 1 to 200 characters");
  return parsed.data;
}

type RawInput = Record<string, string | number | boolean | undefined>;

function parseInput<S extends z.ZodType>(schema: S, input: RawInput): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new UsageError(z.prettifyError(parsed.error));
  return parsed.data;
}

function numberOption(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function parseCommandLine(argv: string[]) {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    strict: true,
    options: {
      root: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      status: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      detail: { type: "string" },
      once: { type: "boolean", default: false },
      timeout: { type: "string" },
      note: { type: "string" },
      since: { type: "string" },
      url: { type: "string" },
      flow: { type: "string" },
      runs: { type: "string" },
      cpu: { type: "string" },
      network: { type: "string" },
      budget: { type: "string" },
      attach: { type: "string" },
      out: { type: "string" },
    },
  });
  const [name, ...rest] = positionals;
  const command = Command.safeParse(name);
  if (!command.success) {
    throw new UsageError(name === undefined ? "Missing command" : `Unknown command ${name}`);
  }
  const allowed = new Set<string>(["root", "json", "help", ...COMMAND_OPTIONS[command.data]]);
  const unexpected = tokens.flatMap((token) =>
    token.kind === "option" && !allowed.has(token.name) ? [token.name] : [],
  );
  if (unexpected.length > 0) {
    throw new UsageError(`${command.data} does not take --${unexpected.join(", --")}`);
  }
  if (rest.length !== POSITIONALS[command.data]) {
    throw new UsageError(
      `${command.data} takes ${POSITIONALS[command.data]} positional argument(s), got ${rest.length}`,
    );
  }
  return { command: command.data, args: rest, values };
}

type Values = ReturnType<typeof parseCommandLine>["values"];
type CliOutput =
  | ListResult
  | GetResult
  | SetStatusResult
  | ReplyResult
  | ErrorsResult
  | PruneResult;

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

function printAnnotation(view: AnnotationView): void {
  line(`${view.id}  ${view.status}${view.claimedBy === undefined ? "" : ` (${view.claimedBy})`}`);
  line(`route: ${view.route}`);
  line(`dir: ${view.dir}`);
  line(`prompt: ${view.prompt}`);
  for (const element of view.elements) {
    const label = [element.selector.role, element.selector.name].filter(Boolean).join(" ");
    line(
      `  [${element.n}] ${element.source ?? "(no source)"}${element.usedAt === undefined ? "" : ` usedAt ${element.usedAt}`}  ${element.owners.join(" > ")}  ${label || element.selector.css}`,
    );
  }
  for (const attachment of view.attachments) {
    line(
      `  ${attachment.kind}: ${attachment.path}${attachment.summary ? `  ${attachment.summary}` : ""}`,
    );
  }
  for (const entry of view.thread ?? []) line(`  ${entry.at} ${entry.from}: ${entry.text}`);
}

function printList(result: ListResult): void {
  if (result.items.length === 0) line("No annotations.");
  for (const item of result.items) {
    line(`${item.id}  ${item.status}  ${item.route}  ${firstLine(item.prompt)}`);
  }
  if (result.nextCursor !== undefined) line(`more: --cursor ${result.nextCursor}`);
}

function printErrors(result: ErrorsResult): void {
  if (result.updatedAt === null) line("No error snapshot yet.");
  else if (result.groups.length === 0) line("No open errors.");
  for (const group of result.groups) {
    line(`${group.count}x ${group.type}: ${firstLine(group.message)}  ${group.topFrame ?? ""}`);
    if (group.stack !== undefined) line(group.stack);
  }
}

async function watchCommand(store: string, values: Values, json: boolean): Promise<void> {
  const input = parseInput(WatchInput, {
    once: values.once,
    timeout: numberOption(values.timeout),
  });
  const deadline = input.timeout === undefined ? undefined : Date.now() + input.timeout * 1000;
  const delivered = new Set<string>();
  for (;;) {
    const timeoutMs = deadline === undefined ? undefined : deadline - Date.now();
    const result =
      timeoutMs !== undefined && timeoutMs <= 0
        ? { timedOut: true }
        : await wait(store, {
            timeoutMs,
            signal: undefined,
            onProgress: undefined,
            skip: delivered,
          });
    const annotation = "annotation" in result ? result.annotation : undefined;
    if (annotation === undefined) {
      line(json ? JSON.stringify({ timedOut: true }) : "Timed out.");
      return;
    }
    delivered.add(annotation.id);
    line(
      json
        ? JSON.stringify({ timedOut: false, annotation })
        : `${annotation.id}  ${annotation.route}  ${firstLine(annotation.prompt)}`,
    );
    if (input.once) return;
  }
}

function openStore(values: Values): Promise<string> {
  return findStore({
    explicit: values.root ?? (process.env.PKA_ROOT || undefined),
    claudeProjectDir: process.env.CLAUDE_PROJECT_DIR || undefined,
    cwd: process.cwd(),
  });
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (thrown) {
    if (isErrno(thrown, "ENOENT")) return false;
    throw thrown;
  }
}

function formatMetric(metric: LabMetric, value: number | null): string {
  if (value === null) return "-";
  return metric === "CLS" ? value.toFixed(3) : `${value} ms`;
}

function printVerdict(verdict: Verdict, file: string): void {
  line(summarizeVerdict(verdict));
  for (const metric of LabMetric.options) {
    const result = verdict.metrics[metric];
    line(
      `  ${metric}  ${formatMetric(metric, result.median)}  range ${formatMetric(metric, result.min)}..${formatMetric(metric, result.max)}  budget ${formatMetric(metric, result.budget)}  ${result.status}`,
    );
    const culprit = result.culprit;
    if (culprit !== undefined) {
      const where = [culprit.element, culprit.resource].filter(Boolean).join(" ");
      line(`      run ${culprit.run} ${culprit.page}${where === "" ? "" : `  ${where}`}`);
      if (culprit.script !== undefined) {
        const script = culprit.script;
        line(
          `      LoAF script ${script.durationMs} ms in ${script.subpart}: ${script.invoker} → ${script.function || "(anonymous)"} ${script.url}`,
        );
      }
      if (culprit.hotFunction !== undefined) {
        const hot = culprit.hotFunction;
        line(
          `      hot ${hot.function} ${hot.url}:${hot.line}:${hot.column} (${hot.selfMs} ms self)`,
        );
      }
      if (culprit.insight !== undefined) line(`      ${culprit.insight}`);
    }
    if (result.note !== undefined) line(`      ${result.note}`);
  }
  for (const insight of verdict.insights.filter((item) => item.state === "fail")) {
    line(
      `  insight ${insight.name} ${insight.page} (${insight.failed}/${insight.runs}): ${insight.summary}`,
    );
  }
  for (const missing of verdict.unavailable) line(`  no ${missing.name}: ${missing.reason}`);
  for (const failure of verdict.failures) line(`  run ${failure.run} failed: ${failure.message}`);
  line(`verdict: ${file}`);
}

async function labCommand(values: Values): Promise<number> {
  const input = parseInput(LabInput, {
    url: values.url,
    flow: values.flow,
    runs: numberOption(values.runs),
    cpu: numberOption(values.cpu),
    network: values.network,
    budget: values.budget,
    attach: values.attach,
    out: values.out,
  });
  let flow: FlowStep[];
  let flowLabel: string;
  if (await isFile(input.flow)) {
    flow = await readFlowFile(input.flow);
    flowLabel = path.resolve(input.flow);
  } else if (ID_PATTERN.test(input.flow)) {
    flow = await readAnnotationFlow(await openStore(values), input.flow);
    flowLabel = `annotation ${input.flow}`;
  } else {
    throw new UsageError(`--flow ${input.flow} is neither a timeline file nor an annotation id`);
  }
  const store = input.attach === undefined ? undefined : await openStore(values);
  const claimant = cliClaimant();
  if (store !== undefined && input.attach !== undefined) {
    await validateAttachTarget(store, input.attach, claimant);
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const { verdict, file } = await runLab({
    url: input.url,
    flow,
    flowLabel,
    runs: input.runs,
    cpuRate: input.cpu,
    network: input.network,
    budgets: input.budget,
    out: input.out ?? path.join(tmpdir(), "pka-lab", stamp),
    onRun: (run, failure) => {
      const phase = run === "trace" ? "diagnostic trace" : `run ${run}/${input.runs}`;
      process.stderr.write(
        `pka lab: ${phase} ${failure === undefined ? "done" : `failed: ${failure.message}`}\n`,
      );
    },
  });
  let attached: { id: string; path: string } | undefined;
  if (store !== undefined && input.attach !== undefined) {
    const attachment = {
      kind: "perf" as const,
      path: `capture/perf/lab-${stamp}.json`,
      summary: summarizeVerdict(verdict),
      data: Buffer.from(`${JSON.stringify(verdict, null, 2)}\n`),
    };
    try {
      await attach(store, input.attach, [attachment], claimant);
    } catch (cause) {
      const message = `Lab verdict written to ${file}; attachment failed`;
      if (!(cause instanceof PkaError)) throw new Error(message, { cause });
      throw new PkaError(`${message}: ${cause.message}`, { cause });
    }
    attached = { id: input.attach, path: attachment.path };
  }
  if (values.json) line(JSON.stringify({ file, attached, verdict }));
  else {
    printVerdict(verdict, file);
    if (attached !== undefined) line(`attached: ${attached.id} ${attached.path}`);
  }
  return verdict.status === "pass" ? 0 : 3;
}

async function run(command: Command, args: string[], values: Values): Promise<void> {
  const json = values.json;
  const store = await openStore(values);
  const output = <T extends CliOutput>(result: T, human: () => void): void => {
    if (json) line(JSON.stringify(result));
    else human();
  };
  switch (command) {
    case "list": {
      const input = parseInput(ListInput, {
        status: values.status,
        limit: numberOption(values.limit),
        cursor: values.cursor,
        detail: values.detail,
      });
      const result = await list(store, input);
      output(result, () => printList(result));
      return;
    }
    case "get": {
      const input = parseInput(GetInput, { id: args[0], detail: values.detail });
      const result: GetResult = await get(store, input);
      output(result, () => printAnnotation(result.annotation));
      return;
    }
    case "watch":
      return watchCommand(store, values, json);
    case "status": {
      const input = parseInput(SetStatusInput, { id: args[0], status: args[1], note: values.note });
      const result = await setStatus(store, input, cliClaimant());
      output(result, () =>
        line(`${result.id}  ${result.status}${result.changed ? "" : " (unchanged)"}`),
      );
      return;
    }
    case "reply": {
      const input = parseInput(ReplyInput, { id: args[0], text: args[1] });
      const result = await reply(store, input, cliClaimant());
      output(result, () => line(`Replied to ${result.id}.`));
      return;
    }
    case "errors": {
      const input = parseInput(ErrorsInput, {
        since: values.since,
        limit: numberOption(values.limit),
        detail: values.detail,
      });
      const result = await errors(store, input);
      output(result, () => printErrors(result));
      return;
    }
    case "prune": {
      const result = await prune(store);
      output(result, () => line(`Removed ${result.removed.length}: ${result.removed.join(" ")}`));
      return;
    }
    case "lab":
      throw new Error("lab is dispatched before run()");
  }
}

async function main(argv: string[]): Promise<number> {
  try {
    const { command, args, values } = parseCommandLine(argv);
    if (values.help) {
      line(USAGE);
      return 0;
    }
    if (command === "lab") return await labCommand(values);
    await run(command, args, values);
    return 0;
  } catch (cause) {
    if (argv.includes("--help") || argv.includes("-h")) {
      line(USAGE);
      return 0;
    }
    if (
      cause instanceof UsageError ||
      (cause instanceof Error && "code" in cause && String(cause.code).startsWith("ERR_PARSE_ARGS"))
    ) {
      process.stderr.write(`pka: ${cause.message}\n\n${USAGE}\n`);
      return 2;
    }
    if (cause instanceof PkaError) {
      process.stderr.write(`pka: ${cause.message}\n`);
      return 1;
    }
    throw cause;
  }
}

process.exitCode = await main(process.argv.slice(2));
