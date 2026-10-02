import {
  RECORDING,
  RecordingManifestDraft,
  type NetworkLine,
  type RecordingErrors,
  type RecordingFrame,
  type RecordingVideo,
} from "../../shared/recording.ts";
import type { ErrorGroup, Viewport } from "../../shared/schema.ts";
import type {
  ActionEntry,
  ActionTarget,
  ErrorEntry,
  NavigationEntry,
  RequestEntry,
  TimelineEntry,
} from "../../shared/timeline.ts";
import type { AttachmentFile, CollectedAttachment } from "../registry.ts";

const SLOW_REQUEST_MS = 1000;
const SUMMARY_STEPS_HEAD = 8;
const SUMMARY_STEPS_TAIL = 12;
const SUMMARY_ERRORS = 5;
const SUMMARY_REQUESTS = 5;
const TEXT_CAP = 60;

export type RecordedFrame = RecordingFrame & { data: Blob };

export type RecordedVideo =
  | { data: Blob; meta: Extract<RecordingVideo, { path: string }> }
  | { data: undefined; meta: Extract<RecordingVideo, { path: null }> };

export type RecordingInput = {
  url: string;
  endUrl: string;
  viewport: Viewport;
  startedAt: string;
  endedAt: string;
  /** Copies of the recorded entries in seq order. */
  entries: TimelineEntry[];
  entryLimit: number;
  entriesDropped: number;
  frames: RecordedFrame[];
  frameLimit: number;
  framesDropped: number;
  framesFailed: number;
  bodyLimit: number;
  bodiesDropped: number;
  video: RecordedVideo;
  /** The capture's current groups, for symbolicated top frames and status. */
  groups: readonly ErrorGroup[];
  bodies: string[];
};

type Step = ActionEntry | NavigationEntry;

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function clip(text: string, max = TEXT_CAP): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function relative(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === location.origin
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : url;
  } catch {
    return url;
  }
}

function seconds(from: string, to: string): string {
  return `${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(1)}s`;
}

function describeTarget(target: ActionTarget): string {
  const parts = [target.tag];
  if (target.role !== undefined) parts.push(`role=${target.role}`);
  const name = target.label ?? target.text;
  if (name !== undefined) parts.push(`"${clip(name)}"`);
  if (target.testId !== undefined) parts.push(`[data-testid=${target.testId}]`);
  else if (target.id !== undefined) parts.push(`#${target.id}`);
  if (target.src !== undefined) parts.push(`at ${target.src}`);
  return parts.join(" ");
}

const VERB = {
  click: "click",
  input: "type in",
  change: "change",
  submit: "submit",
  keydown: "press",
} satisfies Record<ActionEntry["type"], string>;

function describeStep(step: Step): string {
  if (step.kind === "navigation") {
    const from = step.from === undefined ? "" : `${relative(step.from)} → `;
    return `navigate (${step.type}) ${from}${relative(step.to)}`;
  }
  const key = step.key === undefined ? "" : `${step.key} in `;
  return `${VERB[step.type]} ${key}${describeTarget(step.target)}`;
}

function frameAfter(frames: readonly RecordingFrame[], seq: number): string | undefined {
  return frames.find((frame) => frame.seq >= seq)?.path.replace(/^capture\//, "");
}

function stepBefore(steps: readonly Step[], seq: number): number {
  let index = 0;
  for (const [position, step] of steps.entries()) {
    if (step.seq < seq) index = position + 1;
  }
  return index;
}

function recordedGroups(entries: readonly TimelineEntry[], current: readonly ErrorGroup[]) {
  const byFingerprint = new Map<string, ErrorGroup>();
  for (const entry of entries) {
    if (entry.kind !== "error") continue;
    const existing = byFingerprint.get(entry.fingerprint);
    if (existing !== undefined) {
      existing.count += 1;
      existing.lastSeen = entry.at;
      existing.lastSeq = entry.seq;
      continue;
    }
    const known = current.find((group) => group.fingerprint === entry.fingerprint);
    const group: ErrorGroup = {
      fingerprint: entry.fingerprint,
      message: entry.message,
      type: entry.type,
      count: 1,
      firstSeen: entry.at,
      lastSeen: entry.at,
      lastSeq: entry.seq,
      // The browser stack; the plugin symbolicates errors.json when it stores the annotation.
      stack: entry.stack ?? "",
      status: known?.status ?? "open",
    };
    byFingerprint.set(entry.fingerprint, group);
  }
  return [...byFingerprint.values()];
}

function headerList(headers: Record<string, string>): NetworkLine["request"]["headers"] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

export function networkLine(entry: RequestEntry): NetworkLine {
  const line: NetworkLine = {
    seq: entry.seq,
    startedDateTime: entry.at,
    time: entry.durationMs ?? null,
    state: entry.state,
    initiator: entry.initiator,
    request: {
      method: entry.method,
      url: entry.url,
      headers: headerList(entry.requestHeaders),
      bodySize: entry.requestSize ?? -1,
    },
    response: {
      status: entry.status ?? 0,
      headers: headerList(entry.responseHeaders),
      content: { size: entry.responseSize ?? -1, mimeType: entry.contentType ?? "" },
      transferSize: entry.transferSize ?? -1,
    },
    stream: entry.stream,
    serverFn: entry.serverFn,
  };
  if (entry.requestBody !== undefined) {
    line.request.postData = {
      mimeType: entry.requestHeaders["content-type"] ?? "",
      text: entry.requestBody,
    };
  }
  if (entry.responseBody !== undefined) line.response.content.text = entry.responseBody;
  if (entry.error !== undefined) line.error = entry.error;
  if (entry.traceparent !== undefined) line.traceparent = entry.traceparent;
  if (entry.serverTiming !== undefined) line.serverTiming = entry.serverTiming;
  return line;
}

// Aborted requests were cancelled by the page and are listed only in network.jsonl.
function isProblem(request: RequestEntry): boolean {
  return (
    request.state !== "aborted" &&
    (request.state === "failed" ||
      (request.status ?? 0) >= 400 ||
      (request.durationMs ?? 0) >= SLOW_REQUEST_MS)
  );
}

function describeRequest(request: RequestEntry): string {
  const outcome =
    request.state === "failed"
      ? `${request.state}${request.error === undefined ? "" : ` (${clip(request.error)})`}`
      : request.status === undefined
        ? request.state
        : String(request.status);
  const time = request.durationMs === undefined ? "" : ` in ${request.durationMs} ms`;
  return `${request.method} ${clip(relative(request.url), 80)} → ${outcome}${time}`;
}

function jsonLines(values: readonly (TimelineEntry | NetworkLine)[]): Blob {
  return new Blob(
    values.map((value) => `${JSON.stringify(value)}\n`),
    { type: "application/jsonl" },
  );
}

function json(value: RecordingManifestDraft | RecordingErrors): Blob {
  return new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
}

type Digest = {
  steps: Step[];
  requests: RequestEntry[];
  problems: RequestEntry[];
  groups: ErrorGroup[];
  frames: RecordingFrame[];
};

function digest(input: RecordingInput): Digest {
  const requests = input.entries.filter((entry): entry is RequestEntry => entry.kind === "request");
  return {
    steps: input.entries.filter(
      (entry): entry is Step => entry.kind === "action" || entry.kind === "navigation",
    ),
    requests,
    problems: requests.filter(isProblem),
    groups: recordedGroups(input.entries, input.groups),
    frames: input.frames.map(({ data: _data, ...frame }) => frame),
  };
}

function manifestOf(input: RecordingInput, frames: RecordingFrame[]): RecordingManifestDraft {
  const first = input.entries.at(0);
  const last = input.entries.at(-1);
  return RecordingManifestDraft.parse({
    url: input.url,
    endUrl: input.endUrl,
    viewport: input.viewport,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    seq: first === undefined || last === undefined ? null : { first: first.seq, last: last.seq },
    entries: {
      recorded: input.entries.length,
      limit: input.entryLimit,
      dropped: input.entriesDropped,
    },
    bodies: { limitBytes: input.bodyLimit, dropped: input.bodiesDropped },
    frames: {
      items: frames,
      limit: input.frameLimit,
      dropped: input.framesDropped,
      failed: input.framesFailed,
    },
    video: input.video.meta,
    redaction: {
      inputs: "values never recorded; masked in keyframes",
      headers: "credential headers dropped",
      urlParams: "credential-like values replaced with REDACTED",
      bodies: input.bodies,
      storage: "not read",
      video: "not redacted; shows what the tab showed, typed values included",
    },
  } satisfies RecordingManifestDraft);
}

function withFrame(line: string, frame: string | undefined): string {
  return frame === undefined ? line : `${line} · ${frame}`;
}

function stepLines(input: RecordingInput, { steps, frames }: Digest): string[] {
  const lines = ["", `## Steps (${steps.length})`];
  if (steps.length === 0) lines.push("No actions or navigations.");
  const hidden = steps.length - SUMMARY_STEPS_HEAD - SUMMARY_STEPS_TAIL;
  for (const [index, step] of steps.entries()) {
    if (hidden > 0 && index === SUMMARY_STEPS_HEAD) {
      lines.push(`… ${hidden} more steps in timeline.jsonl`);
    }
    if (hidden > 0 && index >= SUMMARY_STEPS_HEAD && index < SUMMARY_STEPS_HEAD + hidden) continue;
    const line = `${index + 1}. +${seconds(input.startedAt, step.at)} ${describeStep(step)}`;
    lines.push(withFrame(line, frameAfter(frames, step.seq)));
  }
  return lines;
}

function errorLines(input: RecordingInput, { steps, groups, frames }: Digest): string[] {
  const lines = ["", `## Errors (${count(groups.length, "group")}, errors.json)`];
  if (groups.length === 0) lines.push("None.");
  for (const group of groups.slice(0, SUMMARY_ERRORS)) {
    const known = input.groups.find((candidate) => candidate.fingerprint === group.fingerprint);
    const firstSeq =
      input.entries.find(
        (entry): entry is ErrorEntry =>
          entry.kind === "error" && entry.fingerprint === group.fingerprint,
      )?.seq ?? group.lastSeq;
    const where = known?.topFrame === undefined ? "" : ` · ${known.topFrame}`;
    const line = `- ${group.count}x ${group.type}: ${clip(group.message, 100)}${where} · first after step ${stepBefore(steps, firstSeq)}`;
    lines.push(withFrame(line, frameAfter(frames, firstSeq)));
  }
  if (groups.length > SUMMARY_ERRORS) lines.push(`… ${groups.length - SUMMARY_ERRORS} more`);
  return lines;
}

function requestLines({ steps, requests, problems }: Digest): string[] {
  const lines = ["", `## Failed or slow requests (${problems.length} of ${requests.length})`];
  if (problems.length === 0) lines.push("None.");
  for (const request of problems.slice(0, SUMMARY_REQUESTS)) {
    lines.push(`- ${describeRequest(request)} · after step ${stepBefore(steps, request.seq)}`);
  }
  if (problems.length > SUMMARY_REQUESTS) {
    lines.push(`… ${problems.length - SUMMARY_REQUESTS} more in network.jsonl`);
  }
  return lines;
}

function fileLines(input: RecordingInput, { requests, frames }: Digest): string[] {
  const lines = [
    "",
    "## Files",
    `- timeline.jsonl: ${input.entries.length} entries by seq (actions, navigations, console, errors, requests)`,
    `- network.jsonl: ${count(requests.length, "request")}, HAR-like, with allowlisted bodies`,
    `- frames/: ${count(frames.length, "keyframe")}, listed with their seq in manifest.json`,
  ];
  if (input.framesDropped > 0) {
    lines.push(
      `- **Keyframes truncated:** stopped at ${input.frameLimit}; ${input.framesDropped} later keyframes were skipped`,
    );
  }
  if (input.bodiesDropped > 0) {
    lines.push(
      `- **Bodies truncated:** ${count(input.bodiesDropped, "request")} past the ${Math.round(input.bodyLimit / 1024 / 1024)} MB body budget kept no body`,
    );
  }
  if (input.framesFailed > 0) lines.push(`- ${input.framesFailed} keyframes failed to render`);
  const video = input.video.meta;
  lines.push(
    video.path === null
      ? `- No video: ${video.reason}`
      : `- video.webm: ${Math.round(video.bytes / 1024)} KB from ${video.startedAt}, not redacted${video.truncated ? ", **truncated** at the size cap" : ""}`,
  );
  return lines;
}

function summaryOf(input: RecordingInput, parts: Digest): string {
  const lines = [
    `# Recording, ${seconds(input.startedAt, input.endedAt)}`,
    "",
    `${relative(input.url)} → ${relative(input.endUrl)} · ${input.viewport.w}x${input.viewport.h}@${Number(input.viewport.dpr.toFixed(2))} · started ${input.startedAt}`,
    "Input values are not recorded and are masked in keyframes. Git SHA, times, and redaction: manifest.json.",
  ];
  if (input.entriesDropped > 0) {
    lines.push(
      "",
      `**Truncated:** the recording kept its first ${input.entryLimit} entries (through seq ${input.entries.at(-1)?.seq}); ${input.entriesDropped} later entries were dropped.`,
    );
  }
  lines.push(
    ...stepLines(input, parts),
    ...errorLines(input, parts),
    ...requestLines(parts),
    ...fileLines(input, parts),
  );
  return `${lines.join("\n")}\n`;
}

/** Builds the recording attachment: summary.md first, then the files it points to. */
export function buildRecording(input: RecordingInput): CollectedAttachment {
  const parts = digest(input);
  const files: AttachmentFile[] = [
    {
      path: RECORDING.summary,
      data: new Blob([summaryOf(input, parts)], { type: "text/markdown" }),
    },
    { path: RECORDING.manifest, data: json(manifestOf(input, parts.frames)) },
    {
      // Bodies live in network.jsonl, joined by seq.
      path: RECORDING.timeline,
      data: jsonLines(
        input.entries.map((entry) => {
          if (entry.kind !== "request") return entry;
          const { requestBody: _request, responseBody: _response, ...rest } = entry;
          return rest;
        }),
      ),
    },
    { path: RECORDING.network, data: jsonLines(parts.requests.map(networkLine)) },
    { path: RECORDING.errors, data: json({ groups: parts.groups }) },
    ...input.frames.map((frame) => ({ path: frame.path, data: frame.data })),
  ];
  if (input.video.data !== undefined) files.push({ path: RECORDING.video, data: input.video.data });

  const { steps, groups, problems, frames } = parts;
  const failed =
    problems.length === 0 ? "" : `, ${count(problems.length, "failed or slow request")}`;
  const video = input.video.meta.path === null ? "" : ", video";
  return {
    path: RECORDING.summary,
    summary: `${seconds(input.startedAt, input.endedAt)}: ${count(steps.length, "step")}, ${count(groups.length, "error group")}${failed}, ${count(frames.length, "keyframe")}${video}`,
    files,
  };
}
