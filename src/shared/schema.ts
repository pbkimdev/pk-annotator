import { z } from "zod";

export const ID_PATTERN = /^[a-z0-9-]{8,40}$/;
export const Id = z.string().regex(ID_PATTERN, "id must match ^[a-z0-9-]{8,40}$");

// A path relative to one annotation directory: slash-separated segments of
// [A-Za-z0-9._-], none of them "." or "..". The store re-checks the resolved path.
export const RelativePath = z
  .string()
  .max(200)
  .regex(
    /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/,
    "path must be relative to the annotation directory, without . or .. segments",
  );

export const Timestamp = z.iso.datetime({ offset: true });

export const Viewport = z.strictObject({
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  dpr: z.number().positive(),
  scrollX: z.number(),
  scrollY: z.number(),
});

export const Box = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});

export const Selector = z.strictObject({
  role: z.string().optional(),
  name: z.string().optional(),
  testId: z.string().optional(),
  css: z.string(),
});

// Every string except `n` and `crop` is page-derived and untrusted. The human
// prompt lives only on Annotation.prompt.
export const ElementRef = z.strictObject({
  n: z.number().int().positive(),
  // The page the element was picked on; older stored annotations lack it.
  url: z.string().optional(),
  source: z
    .string()
    .regex(/^.+:\d+:\d+$/, "source must be file:line:col")
    .optional(),
  // Call site of the nearest owner component in project code, when it differs from source.
  usedAt: z
    .string()
    .regex(/^.+:\d+:\d+$/, "usedAt must be file:line:col")
    .optional(),
  owners: z.array(z.string()),
  selector: Selector,
  html: z.string(),
  box: Box,
  crop: RelativePath.optional(),
  text: z.string().optional(),
  nearbyText: z.string().optional(),
});

export const AttachmentKind = z.enum(["recording", "errors", "network", "perf", "frame", "video"]);

export const Attachment = z.strictObject({
  kind: AttachmentKind,
  path: RelativePath,
  summary: z.string(),
});

// The page a saved mark of a batch Send was made on; `n` matches its "## Mark n" section.
export const MarkPage = z.strictObject({
  n: z.number().int().positive(),
  url: z.string(),
  route: z.string(),
});

export const Annotation = z.strictObject({
  id: Id,
  createdAt: Timestamp,
  url: z.string(),
  route: z.string(),
  viewport: Viewport,
  prompt: z.string(),
  elements: z.array(ElementRef),
  attachments: z.array(Attachment),
  marks: z.array(MarkPage).optional(),
});

export const AnnotationDraft = Annotation.omit({ id: true, createdAt: true });

export const Status = z.enum(["pending", "acknowledged", "resolved", "dismissed"]);

export const StatusEvent = z.strictObject({
  status: Status,
  at: Timestamp,
  by: z.string().optional(),
  note: z.string().optional(),
});

export const State = z.strictObject({
  status: Status,
  history: z.array(StatusEvent).min(1),
});

/**
 * The claiming process. A pid means something only inside its PID namespace, so `namespace`
 * names that namespace on its host; `startTime` (Linux) tells a reused pid apart.
 */
export const ClaimProcess = z.strictObject({
  pid: z.number().int().positive(),
  namespace: z.string().min(1).max(200),
  startTime: z.string().regex(/^\d+$/).optional(),
});

export const Claim = z.strictObject({
  by: z.string().min(1),
  at: Timestamp,
  process: ClaimProcess.optional(),
});

export const ThreadEntry = z.strictObject({
  at: Timestamp,
  // Stores written before the overlay dropped its reply field can hold human entries.
  from: z.enum(["agent", "human"]),
  text: z.string().min(1),
});

export const ErrorGroupStatus = z.enum(["open", "sent", "cleared"]);

export const ErrorGroup = z.strictObject({
  fingerprint: z.string().min(1).max(200),
  message: z.string(),
  type: z.string(),
  count: z.number().int().positive(),
  firstSeen: Timestamp,
  lastSeen: Timestamp,
  lastSeq: z.number().int().nonnegative(),
  topFrame: z
    .string()
    .regex(/^.+:\d+$/, "topFrame must be file:line")
    .optional(),
  stack: z.string(),
  status: ErrorGroupStatus,
});

export const LiveErrorsSnapshot = z.strictObject({
  updatedAt: Timestamp,
  groups: z.array(ErrorGroup),
});

export type Id = z.infer<typeof Id>;
export type Viewport = z.infer<typeof Viewport>;
export type Box = z.infer<typeof Box>;
export type Selector = z.infer<typeof Selector>;
export type ElementRef = z.infer<typeof ElementRef>;
export type MarkPage = z.infer<typeof MarkPage>;
export type AttachmentKind = z.infer<typeof AttachmentKind>;
export type Attachment = z.infer<typeof Attachment>;
export type Annotation = z.infer<typeof Annotation>;
export type AnnotationDraft = z.infer<typeof AnnotationDraft>;
export type Status = z.infer<typeof Status>;
export type StatusEvent = z.infer<typeof StatusEvent>;
export type State = z.infer<typeof State>;
export type ClaimProcess = z.infer<typeof ClaimProcess>;
export type Claim = z.infer<typeof Claim>;
export type ThreadEntry = z.infer<typeof ThreadEntry>;
export type ErrorGroupStatus = z.infer<typeof ErrorGroupStatus>;
export type ErrorGroup = z.infer<typeof ErrorGroup>;
export type LiveErrorsSnapshot = z.infer<typeof LiveErrorsSnapshot>;
