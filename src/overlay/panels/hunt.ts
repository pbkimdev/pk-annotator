import type { ViteHotContext } from "vite/types/hot.d.ts";

import type { HuntContext } from "../../core/index.ts";
import {
  CHANNEL,
  MAX_SYMBOLICATE_STACKS,
  StateMessage,
  SymbolicatedMessage,
} from "../../shared/channel.ts";
import { getCapture } from "../capture.ts";
import { listen, send } from "../channel-client.ts";
import {
  addAttachment,
  attachments,
  SUMMARY_PATH,
  type CollectedAttachment,
  type ComposerAttachment,
} from "../registry.ts";
import { actionLine, clockTime, requestLine } from "./format.ts";

const ATTACHMENT_ID = "errors";
const ERRORS_PATH = "capture/errors.json";
const WINDOW_MS = 20_000;
const SUMMARY_FRAMES = 4;
const SUMMARY_BEFORE = 8;
const SUMMARY_MESSAGE = 300;
const SYMBOLICATE_TIMEOUT_MS = 10_000;

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

const VENDOR = /\/node_modules\/|\/@vite\//;

// The summary shows project frames; errors.json keeps the whole stack.
function appFrames(stack: string): string[] {
  const frames = stack.split("\n").filter((line) => /^\s*at |@/.test(line));
  const app = frames.filter((frame) => !VENDOR.test(frame));
  return (app.length > 0 ? app : frames).slice(0, SUMMARY_FRAMES);
}

// Owner and component stacks are mostly framework wrappers; keep the components.
function withoutVendor(stack: string): string {
  return stack
    .split("\n")
    .filter((line) => line.trim() !== "" && !VENDOR.test(line))
    .join("\n");
}

type Stacks = { stack: string; ownerStack?: string; componentStack?: string };
export type Hunted = HuntContext & Stacks;

function groupSection(hunted: Hunted, index: number): string {
  const { group, error, actions, requests, stack } = hunted;
  const before = [
    ...actions.map((entry) => ({ seq: entry.seq, at: entry.at, text: actionLine(entry) })),
    ...requests.map((entry) => ({ seq: entry.seq, at: entry.at, text: requestLine(entry) })),
  ]
    .sort((left, right) => left.seq - right.seq)
    .slice(-SUMMARY_BEFORE);
  const lines = [
    `### ${index + 1}. ${group.type}: ${oneLine(group.message, SUMMARY_MESSAGE)}`,
    "",
    [
      `${group.count}×`,
      `from ${error.source}`,
      `first ${clockTime(group.firstSeen)}`,
      group.topFrame === undefined ? undefined : `at ${group.topFrame}`,
    ]
      .filter((part) => part !== undefined)
      .join(" · "),
  ];
  const frames = appFrames(stack);
  if (frames.length > 0) lines.push("", "```", ...frames.map((frame) => frame.trim()), "```");
  if (before.length > 0) {
    lines.push("", `Before it (${actions.length} actions, ${requests.length} requests in 20 s):`);
    lines.push(...before.map((entry) => `- ${clockTime(entry.at)} ${entry.text}`));
  }
  return lines.join("\n");
}

function summaryLine(hunted: readonly Hunted[]): string {
  const [first] = hunted;
  if (first === undefined) throw new Error("A hunt needs at least one error group");
  if (hunted.length > 1) {
    return oneLine(
      `${hunted.length} error groups: ${hunted.map(({ group }) => group.message).join("; ")}`,
      SUMMARY_MESSAGE,
    );
  }
  const { group, actions, requests } = first;
  const where = group.topFrame === undefined ? "" : ` at ${group.topFrame}`;
  return oneLine(
    `${group.type}: ${group.message}${where}; ${actions.length} actions and ${requests.length} requests before it`,
    SUMMARY_MESSAGE,
  );
}

// The plugin maps each frame to its source through the dev server's module graph.
function symbolicate(hot: ViteHotContext, stacks: string[]): Promise<string[]> {
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      stop();
      reject(new Error("No reply from the dev server within 10 s while symbolicating stacks"));
    }, SYMBOLICATE_TIMEOUT_MS);
    const stop = listen(hot, CHANNEL.symbolicated, SymbolicatedMessage, (message) => {
      if (message.requestId !== requestId) return;
      window.clearTimeout(timer);
      stop();
      if (message.stacks.length === stacks.length) resolve(message.stacks);
      else {
        reject(
          new Error(`Asked to symbolicate ${stacks.length} stacks, got ${message.stacks.length}`),
        );
      }
    });
    send(hot, CHANNEL.symbolicate, { requestId, stacks });
  });
}

async function huntGroups(hot: ViteHotContext, fingerprints: readonly string[]) {
  if (fingerprints.length === 0) return [];
  const capture = getCapture();
  const contexts = fingerprints.map((fingerprint) => capture.huntContext(fingerprint, WINDOW_MS));
  const raw = contexts.flatMap(({ group, error }) => [
    error.stack ?? group.stack,
    error.ownerStack ?? "",
    error.componentStack ?? "",
  ]);
  const mapped: string[] = [];
  for (let start = 0; start < raw.length; start += MAX_SYMBOLICATE_STACKS) {
    mapped.push(...(await symbolicate(hot, raw.slice(start, start + MAX_SYMBOLICATE_STACKS))));
  }
  const hunted: Hunted[] = contexts.map((context, index) => {
    const [stack = "", ownerStack = "", componentStack = ""] = mapped.slice(index * 3);
    const stacks: Stacks = { stack };
    if (ownerStack !== "") stacks.ownerStack = withoutVendor(ownerStack);
    if (componentStack !== "") stacks.componentStack = withoutVendor(componentStack);
    return { ...context, ...stacks };
  });
  return hunted;
}

function collect(hunted: readonly Hunted[]): CollectedAttachment {
  const errors = {
    windowMs: WINDOW_MS,
    groups: hunted.map(({ group, error, actions, requests, ...stacks }) => ({
      fingerprint: group.fingerprint,
      type: group.type,
      message: group.message,
      count: group.count,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      topFrame: group.topFrame,
      source: error.source,
      at: error.at,
      ...stacks,
      resource: error.resource,
      before: { actions, requests },
    })),
  };
  const summary = [
    `## Errors`,
    "",
    `${ERRORS_PATH} has each group's full stack, owner stack, and the actions and requests (headers, timing, captured bodies) in the 20 s before it.`,
    "",
    ...hunted.map((entry, index) => `${groupSection(entry, index)}\n`),
  ].join("\n");
  return {
    path: SUMMARY_PATH,
    summary: summaryLine(hunted),
    files: [
      { path: ERRORS_PATH, data: new Blob([JSON.stringify(errors, null, 2)]) },
      { path: SUMMARY_PATH, data: new Blob([summary]) },
    ],
  };
}

/**
 * Adds the given groups to the composer's errors attachment, keeping groups hunted
 * earlier while that attachment is still in the composer.
 */
export function hunt(hot: ViteHotContext, fingerprints: readonly string[]): void {
  const present = attachments.get().find((attachment) => attachment.id === ATTACHMENT_ID);
  const kept = present?.keptGroups ?? [];
  // A group Save already fixed stays as saved, even after the capture evicts it.
  const live = [...new Set([...(present?.fingerprints ?? []), ...fingerprints])].filter(
    (fingerprint) => !kept.some(({ group }) => group.fingerprint === fingerprint),
  );
  addAttachment(huntAttachment(hot, kept, live));
}

/** `kept` are groups fixed by Save; `live` fingerprints are collected from the capture. */
function huntAttachment(
  hot: ViteHotContext,
  kept: readonly Hunted[],
  live: readonly string[],
): ComposerAttachment {
  const all = [...kept.map(({ group }) => group.fingerprint), ...live];
  const only =
    kept.length === 1 && live.length === 0
      ? kept[0]?.group
      : kept.length === 0 && live.length === 1
        ? getCapture()
            .snapshot()
            .groups.find((group) => group.fingerprint === live[0])
        : undefined;
  const resolve = async () => [...kept, ...(await huntGroups(hot, live))];
  return {
    id: ATTACHMENT_ID,
    kind: "errors",
    label: only === undefined ? `${all.length} errors` : oneLine(only.message, 60),
    fingerprints: live,
    keptGroups: kept,
    freeze: async () => huntAttachment(hot, structuredClone(await resolve()), []),
    collect: async () => collect(await resolve()),
    sent(id) {
      getCapture().markSent(all);
      track(hot, id, all);
    },
  };
}

// After a hunt is sent, its groups wait for two things: the agent resolving the
// annotation and a hot update of the page. Listeners exist only while a hunt waits.

type Waiting = { fingerprints: readonly string[]; resolved: boolean; updatedAt?: number };

const waiting = new Map<string, Waiting>();
let stopListening: (() => void) | undefined;

function settle(id: string, entry: Waiting): void {
  if (!entry.resolved || entry.updatedAt === undefined) return;
  getCapture().markResolved(entry.fingerprints, entry.updatedAt);
  forget(id);
}

function forget(id: string): void {
  waiting.delete(id);
  if (waiting.size > 0) return;
  stopListening?.();
  stopListening = undefined;
}

function track(hot: ViteHotContext, id: string, fingerprints: readonly string[]): void {
  waiting.set(id, { fingerprints, resolved: false });
  if (stopListening !== undefined) return;
  const stopState = listen(hot, CHANNEL.state, StateMessage, ({ id: changed, state }) => {
    const entry = waiting.get(changed);
    if (entry === undefined) return;
    if (state.status === "dismissed") return forget(changed);
    if (state.status !== "resolved") return;
    entry.resolved = true;
    settle(changed, entry);
  });
  const onUpdate = () => {
    const updatedAt = Date.now();
    for (const [key, entry] of waiting) {
      entry.updatedAt = updatedAt;
      settle(key, entry);
    }
  };
  hot.on("vite:afterUpdate", onUpdate);
  stopListening = () => {
    stopState();
    hot.off("vite:afterUpdate", onUpdate);
  };
}

/** Drops waiting hunts and their listeners; called when the overlay unmounts. */
export function stopHuntTracking(): void {
  waiting.clear();
  stopListening?.();
  stopListening = undefined;
}
