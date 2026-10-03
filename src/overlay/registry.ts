import type { ComponentType } from "react";

import type { AttachmentKind } from "../shared/schema.ts";

// Extension points for later lanes. This module is part of the launcher chunk, so it
// holds plain data and listeners only; components are rendered by the UI chunk.

export type PanelProps = { close(): void };

export type PanelDefinition = {
  /** Stable id, for example "network", "console", "record", "perf". */
  id: string;
  /** Accessible name of the menu item and title of the panel. */
  label: string;
  icon: ComponentType<{ className?: string }>;
  component: ComponentType<PanelProps>;
};

/** The file the agent reads first. Each attachment may add a section to it. */
export const SUMMARY_PATH = "capture/summary.md";

/**
 * One file written under the annotation directory, for example `capture/network.jsonl`.
 * Files at SUMMARY_PATH from several attachments are joined into one summary.
 */
export type AttachmentFile = { path: string; data: Blob };

export type CollectedAttachment = {
  /** The file the agent reads first, relative to the annotation directory. */
  path: string;
  summary: string;
  files: AttachmentFile[];
};

export type ComposerAttachment = {
  /** Unique among attachments in the composer; adding an existing id replaces it. */
  id: string;
  kind: AttachmentKind;
  label: string;
  /** Runs once when the annotation is sent. */
  collect(): Promise<CollectedAttachment>;
  /** Runs after the dev server has stored the annotation. */
  sent?(id: string): void;
};

type Listener = () => void;

function createList<T extends { id: string }>() {
  let items: readonly T[] = [];
  const listeners = new Set<Listener>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => items,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add(item: T) {
      items = [...items.filter((existing) => existing.id !== item.id), item];
      notify();
      return () => {
        items = items.filter((existing) => existing !== item);
        notify();
      };
    },
    remove(id: string) {
      items = items.filter((existing) => existing.id !== id);
      notify();
    },
    clear() {
      items = [];
      notify();
    },
  };
}

export const panels = createList<PanelDefinition>();
export const attachments = createList<ComposerAttachment>();

/** Adds a menu item and its panel; returns a function that removes both. */
export function registerPanel(panel: PanelDefinition): () => void {
  return panels.add(panel);
}

/** Adds an attachment chip to the composer; returns a function that removes it. */
export function addAttachment(attachment: ComposerAttachment): () => void {
  return attachments.add(attachment);
}

let badgeCount = 0;
const badgeListeners = new Set<Listener>();

/** Shows a count on the launcher (0 hides it), for example the number of open error groups. */
export function setBadge(count: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`setBadge expects a non-negative integer, got ${count}`);
  }
  badgeCount = count;
  for (const listener of badgeListeners) listener();
}

export function getBadge(): number {
  return badgeCount;
}

export function subscribeBadge(listener: Listener): () => void {
  badgeListeners.add(listener);
  return () => badgeListeners.delete(listener);
}

type IconSet = Readonly<Record<string, string>>;
let iconSet: IconSet | null = null;
const iconListeners = new Set<Listener>();

/**
 * The connected agent's icons, keyed by menu item, panel, or control id; each value is the
 * inside of a 256-unit SVG. The agent theme chunk sets it; null draws the lucide icons.
 */
export const agentIcons = {
  get: (): IconSet | null => iconSet,
  set(next: IconSet | null): void {
    if (next === iconSet) return;
    iconSet = next;
    for (const listener of iconListeners) listener();
  },
  subscribe(listener: Listener): () => void {
    iconListeners.add(listener);
    return () => iconListeners.delete(listener);
  },
};
