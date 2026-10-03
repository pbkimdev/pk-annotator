import { z } from "zod";

import {
  AttachmentKind,
  Box,
  ErrorGroupStatus,
  Id,
  Status,
  StatusEvent,
  ThreadEntry,
  Timestamp,
  Viewport,
  type Annotation,
  type Claim,
  type ElementRef,
  type ErrorGroup,
  type State,
} from "../shared/schema.ts";

export const Detail = z.enum(["concise", "full"]);
export type Detail = z.infer<typeof Detail>;

const CAP = {
  short: 300,
  label: 500,
  text: 1000,
  html: 4000,
  stack: 8000,
  owners: 12,
} as const;

/**
 * UTF-8 bytes of a concise annotation or list page, so it stays well under Claude Code's
 * 10k-token warning. detail full has no budget.
 */
export const CONCISE_BYTES = 20_000;

export function jsonBytes(
  value:
    | AnnotationView
    | ElementView
    | AnnotationView["attachments"][number]
    | ListItem
    | { items: ListItem[]; nextCursor: string | undefined },
): number {
  return Buffer.byteLength(JSON.stringify(value));
}

const CONTROL = /(?![\t\n])\p{Cc}/gu;
const BIDI = /\p{Bidi_Control}/gu;

/** Strips control and bidirectional-override characters from page-derived text and caps its length. */
export function pageText(value: string, max: number): string {
  const clean = value.replace(CONTROL, "").replace(BIDI, "");
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}… [${clean.length - max} more characters]`;
}

function optionalPageText(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : pageText(value, max);
}

export const ElementView = z.strictObject({
  n: z.number(),
  source: z.string().optional(),
  usedAt: z.string().optional(),
  owners: z.array(z.string()),
  selector: z.strictObject({
    role: z.string().optional(),
    name: z.string().optional(),
    testId: z.string().optional(),
    css: z.string(),
  }),
  crop: z.string().optional(),
  text: z.string().optional(),
  nearbyText: z.string().optional(),
  html: z.string().optional(),
  box: Box.optional(),
});
export type ElementView = z.infer<typeof ElementView>;

export const AnnotationView = z.strictObject({
  id: Id,
  createdAt: Timestamp,
  status: Status,
  claimedBy: z.string().optional(),
  dir: z
    .string()
    .describe("Absolute annotation directory; attachment and crop paths are relative to it"),
  url: z.string(),
  route: z.string(),
  viewport: Viewport.optional(),
  prompt: z.string().describe("The human's request"),
  elements: z.array(ElementView),
  attachments: z.array(
    z.strictObject({ kind: AttachmentKind, path: z.string(), summary: z.string().optional() }),
  ),
  threadCount: z.number(),
  omitted: z
    .strictObject({ elements: z.number(), attachments: z.number(), note: z.string() })
    .optional()
    .describe("Elements and attachments left out of a concise response"),
  history: z.array(StatusEvent).optional(),
  thread: z.array(ThreadEntry).optional(),
});
export type AnnotationView = z.infer<typeof AnnotationView>;

export const ListItem = z.strictObject({
  id: Id,
  createdAt: Timestamp,
  status: Status,
  claimedBy: z.string().optional(),
  route: z.string(),
  prompt: z.string(),
  elementCount: z.number(),
  attachmentCount: z.number(),
});
export type ListItem = z.infer<typeof ListItem>;

export const ErrorGroupView = z.strictObject({
  fingerprint: z.string(),
  type: z.string(),
  message: z.string(),
  count: z.number(),
  lastSeen: Timestamp,
  topFrame: z.string().optional(),
  status: ErrorGroupStatus,
  firstSeen: Timestamp.optional(),
  lastSeq: z.number().optional(),
  stack: z.string().optional(),
});
export type ErrorGroupView = z.infer<typeof ErrorGroupView>;

export interface AnnotationRecord {
  dir: string;
  annotation: Annotation;
  state: State;
  claim: Claim | undefined;
  thread: ThreadEntry[];
}

function elementView(element: ElementRef, detail: Detail): ElementView {
  const full = detail === "full";
  const view: ElementView = {
    n: element.n,
    source: optionalPageText(element.source, CAP.label),
    usedAt: optionalPageText(element.usedAt, CAP.label),
    owners: element.owners.slice(0, CAP.owners).map((owner) => pageText(owner, CAP.short)),
    selector: {
      role: optionalPageText(element.selector.role, CAP.short),
      name: optionalPageText(element.selector.name, CAP.short),
      testId: optionalPageText(element.selector.testId, CAP.short),
      css: pageText(element.selector.css, CAP.label),
    },
    crop: element.crop,
    text: optionalPageText(element.text, full ? CAP.text : CAP.short),
  };
  if (full) {
    view.nearbyText = optionalPageText(element.nearbyText, CAP.text);
    view.html = pageText(element.html, CAP.html);
    view.box = element.box;
  }
  return view;
}

export function annotationView(record: AnnotationRecord, detail: Detail): AnnotationView {
  const { annotation, state } = record;
  const full = detail === "full";
  const view: AnnotationView = {
    id: annotation.id,
    createdAt: annotation.createdAt,
    status: state.status,
    claimedBy: record.claim?.by,
    dir: record.dir,
    url: pageText(annotation.url, CAP.label),
    route: pageText(annotation.route, CAP.label),
    prompt: annotation.prompt,
    elements: annotation.elements.map((element) => elementView(element, detail)),
    attachments: annotation.attachments.map((attachment) => ({
      kind: attachment.kind,
      path: attachment.path,
      summary: pageText(attachment.summary, full ? CAP.text : CAP.short),
    })),
    threadCount: record.thread.length,
  };
  if (full) {
    view.viewport = annotation.viewport;
    view.history = state.history;
    view.thread = record.thread;
    return view;
  }
  return withinBudget(view);
}

/**
 * Keeps the leading elements, then the leading attachments, that fit CONCISE_BYTES, so
 * `[element n]` and `[attachment n]` keep their numbers, and says how many were left out.
 */
function withinBudget(view: AnnotationView): AnnotationView {
  const { elements, attachments } = view;
  // The counts can only shrink, so this overestimates the final omitted record.
  let used = jsonBytes({
    ...view,
    elements: [],
    attachments: [],
    omitted: { elements: elements.length, attachments: attachments.length, note: OMITTED_NOTE },
  });
  const fit = <T extends ElementView | AnnotationView["attachments"][number]>(items: T[]): T[] => {
    const kept: T[] = [];
    for (const item of items) {
      const bytes = jsonBytes(item) + 1;
      if (used + bytes > CONCISE_BYTES) break;
      used += bytes;
      kept.push(item);
    }
    return kept;
  };
  const keptElements = fit(elements);
  const keptAttachments = fit(attachments);
  if (keptElements.length === elements.length && keptAttachments.length === attachments.length) {
    return view;
  }
  return {
    ...view,
    elements: keptElements,
    attachments: keptAttachments,
    omitted: {
      elements: elements.length - keptElements.length,
      attachments: attachments.length - keptAttachments.length,
      note: OMITTED_NOTE,
    },
  };
}

const OMITTED_NOTE =
  "Left out to keep this response small. get_annotation (pka get) with detail full returns all of them.";

export function listItem(record: AnnotationRecord): ListItem {
  const { annotation } = record;
  return {
    id: annotation.id,
    createdAt: annotation.createdAt,
    status: record.state.status,
    claimedBy: record.claim?.by,
    route: pageText(annotation.route, CAP.label),
    prompt:
      annotation.prompt.length > CAP.short
        ? `${annotation.prompt.slice(0, CAP.short)}…`
        : annotation.prompt,
    elementCount: annotation.elements.length,
    attachmentCount: annotation.attachments.length,
  };
}

export function errorGroupView(group: ErrorGroup, detail: Detail): ErrorGroupView {
  const full = detail === "full";
  const view: ErrorGroupView = {
    fingerprint: pageText(group.fingerprint, CAP.short),
    type: pageText(group.type, CAP.short),
    message: pageText(group.message, full ? CAP.text : CAP.short),
    count: group.count,
    lastSeen: group.lastSeen,
    topFrame: optionalPageText(group.topFrame, CAP.label),
    status: group.status,
  };
  if (full) {
    view.firstSeen = group.firstSeen;
    view.lastSeq = group.lastSeq;
    view.stack = pageText(group.stack, CAP.stack);
  }
  return view;
}
