import { z } from "zod";

import { Timestamp } from "./schema.ts";

// One line of capture/timeline.jsonl. `seq` is one counter across every kind,
// so sorting by seq reproduces the order in which the page saw the events.
// Every string here is page-derived and untrusted; URLs are already redacted.

const Seq = z.number().int().nonnegative();

// Console arguments are serialized when logged. Values that JSON cannot carry
// become bracketed strings: "[undefined]", "[Circular]", "[Function name]",
// "[Element button#save]", "[Object]" past the depth cap, "…[+N chars]".
export const ConsoleEntry = z.strictObject({
  kind: z.literal("console"),
  seq: Seq,
  at: Timestamp,
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  args: z.array(z.json()),
});

export const ErrorSource = z.enum([
  "window",
  "resource",
  "rejection",
  "console",
  "react-caught",
  "react-uncaught",
  "react-recoverable",
]);

export const ErrorEntry = z.strictObject({
  kind: z.literal("error"),
  seq: Seq,
  at: Timestamp,
  source: ErrorSource,
  fingerprint: z.string().min(1).max(200),
  type: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  componentStack: z.string().optional(),
  ownerStack: z.string().optional(),
  resource: z.strictObject({ tag: z.string(), url: z.string() }).optional(),
});

export const ServerTiming = z.strictObject({
  name: z.string(),
  duration: z.number(),
  description: z.string(),
});

// One entry per request, updated in place until it settles. `open` means the
// headers arrived and the body is still streaming; the entry is not read.
export const RequestEntry = z.strictObject({
  kind: z.literal("request"),
  seq: Seq,
  at: Timestamp,
  initiator: z.enum(["fetch", "xhr"]),
  method: z.string(),
  url: z.string(),
  state: z.enum(["pending", "open", "done", "failed", "aborted"]),
  status: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  requestSize: z.number().int().nonnegative().optional(),
  responseSize: z.number().int().nonnegative().optional(),
  transferSize: z.number().int().nonnegative().optional(),
  responseType: z.string().optional(),
  contentType: z.string().optional(),
  stream: z.boolean(),
  serverFn: z.boolean(),
  traceparent: z.string().optional(),
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()),
  requestBody: z.string().optional(),
  responseBody: z.string().optional(),
  serverTiming: z.array(ServerTiming).optional(),
});

export const ActionTarget = z.strictObject({
  tag: z.string(),
  id: z.string().optional(),
  testId: z.string().optional(),
  src: z.string().optional(),
  role: z.string().optional(),
  text: z.string().optional(),
  label: z.string().optional(),
});

export const ActionEntry = z.strictObject({
  kind: z.literal("action"),
  seq: Seq,
  at: Timestamp,
  type: z.enum(["click", "input", "change", "submit", "keydown"]),
  key: z.enum(["Enter", "Escape"]).optional(),
  target: ActionTarget,
});

export const NavigationEntry = z.strictObject({
  kind: z.literal("navigation"),
  seq: Seq,
  at: Timestamp,
  type: z.enum(["load", "push", "replace", "reload", "traverse"]),
  from: z.string().optional(),
  to: z.string(),
});

export const TimelineEntry = z.discriminatedUnion("kind", [
  ConsoleEntry,
  ErrorEntry,
  RequestEntry,
  ActionEntry,
  NavigationEntry,
]);

export type ConsoleEntry = z.infer<typeof ConsoleEntry>;
export type ErrorSource = z.infer<typeof ErrorSource>;
export type ErrorEntry = z.infer<typeof ErrorEntry>;
export type ServerTiming = z.infer<typeof ServerTiming>;
export type RequestEntry = z.infer<typeof RequestEntry>;
export type ActionTarget = z.infer<typeof ActionTarget>;
export type ActionEntry = z.infer<typeof ActionEntry>;
export type NavigationEntry = z.infer<typeof NavigationEntry>;
export type TimelineEntry = z.infer<typeof TimelineEntry>;
