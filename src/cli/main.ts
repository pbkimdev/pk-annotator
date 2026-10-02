#!/usr/bin/env node
import { parseArgs } from "node:util";

import { z } from "zod";

import {
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
  wait,
  type ErrorsResult,
  type PruneResult,
  type ReplyResult,
  type SetStatusResult,
  type GetResult,
  type ListResult,
} from "../ops/ops.ts";
import type { AnnotationView } from "../ops/views.ts";
import { PkaError, findStore } from "../store/store.ts";

const USAGE = `Usage: pka [--root DIR] [--json] <command>

  list [--status pending|acknowledged|resolved|dismissed|all] [--limit N] [--cursor ID] [--detail concise|full]
  get <id> [--detail concise|full]
  watch [--once] [--timeout SECONDS]    one line per new pending annotation
  status <id> <acknowledged|resolved|dismissed> [--note TEXT]
  reply <id> <text>
  errors [--since ISO-TIME] [--limit N] [--detail concise|full]
  prune                                 remove resolved and dismissed annotations older than 7 days

The store is <root>/_interim/annotations. Without --root or PKA_ROOT, pka uses
CLAUDE_PROJECT_DIR, then the nearest parent of the working directory that has one.
Exit codes: 0 ok, 1 operation error, 2 usage error.`;

const COMMAND_OPTIONS = {
  list: ["status", "limit", "cursor", "detail"],
  get: ["detail"],
  watch: ["once", "timeout"],
  status: ["note"],
  reply: [],
  errors: ["since", "limit", "detail"],
  prune: [],
} as const;
const POSITIONALS = {
  list: 0,
  get: 1,
  watch: 0,
  status: 2,
  reply: 2,
  errors: 0,
  prune: 0,
} as const;
const Command = z.enum(["list", "get", "watch", "status", "reply", "errors", "prune"]);
type Command = z.infer<typeof Command>;

const WatchInput = z.strictObject({
  once: z.boolean(),
  timeout: z.number().positive().max(86_400).optional(),
});

class UsageError extends Error {
  override name = "UsageError";
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
      `  [${element.n}] ${element.source ?? "(no source)"}  ${element.owners.join(" > ")}  ${label || element.selector.css}`,
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

async function run(command: Command, args: string[], values: Values): Promise<void> {
  const json = values.json;
  const store = await findStore({
    explicit: values.root ?? (process.env.PKA_ROOT || undefined),
    claudeProjectDir: process.env.CLAUDE_PROJECT_DIR || undefined,
    cwd: process.cwd(),
  });
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
      const result = await setStatus(store, input, `pka-cli:${process.ppid}`);
      output(result, () =>
        line(`${result.id}  ${result.status}${result.changed ? "" : " (unchanged)"}`),
      );
      return;
    }
    case "reply": {
      const input = parseInput(ReplyInput, { id: args[0], text: args[1] });
      const result = await reply(store, input, "agent");
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
  }
}

async function main(argv: string[]): Promise<number> {
  try {
    const { command, args, values } = parseCommandLine(argv);
    if (values.help) {
      line(USAGE);
      return 0;
    }
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
