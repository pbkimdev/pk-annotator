import { createContext, useContext } from "react";
import type { ViteHotContext } from "vite/types/hot.d.ts";

import type { Containment, Point } from "../select/marquee.ts";
import type { PickMode, SelectHow } from "../select/pick.ts";
import type { Box } from "../shared/schema.ts";
import type { Corner, ThemeSignal } from "./launcher.ts";
import type { ComposerAttachment } from "./registry.ts";
import type { Store } from "./store.ts";
import type { ThreadStore } from "./thread-store.ts";

export const COMPOSE = "compose";
export const THREAD = "thread";
export const NOTE = "note";
export const SETTINGS = "settings";

export type SavedMark = {
  id: string;
  prompt: string;
  elements: readonly Element[];
  attachments: readonly ComposerAttachment[];
  bytes: number;
};

export type UiState = {
  visible: boolean;
  prompt: string;
  globalPrompt: string;
  marks: readonly SavedMark[];
  editing: string | null;
  busy: boolean;
  recording: boolean;
  gesture: "screenshot" | "record-area" | "rectangle" | "ellipse" | "freehand" | null;
  recordRegion: Box | null;
  language: "en" | "ko";
  picking: PickMode | null;
  /** The open panel: COMPOSE, THREAD, or a registered panel id. */
  panel: string | null;
  selection: readonly Element[];
  hover: Element | null;
  lasso: readonly Point[] | null;
  marquee: { box: Box; containment: Containment } | null;
  corner: Corner;
};

export type Overlay = {
  host: HTMLElement;
  hot: ViteHotContext;
  theme: ThemeSignal;
  ui: Store<UiState>;
  thread: ThreadStore;
  hide(): void;
  exit(): void;
};

export const OverlayContext = createContext<Overlay | null>(null);

export function useOverlay(): Overlay {
  const overlay = useContext(OverlayContext);
  if (overlay === null) throw new Error("OverlayContext is missing; render inside the overlay");
  return overlay;
}

export function nextSelection(
  current: readonly Element[],
  elements: readonly Element[],
  how: SelectHow,
): Element[] {
  if (how === "replace") return [...elements];
  if (how === "add")
    return [...current, ...elements.filter((element) => !current.includes(element))];
  const toggled = current.filter((element) => !elements.includes(element));
  return [...toggled, ...elements.filter((element) => !current.includes(element))];
}

const keys = new WeakMap<Element, number>();
let nextKey = 1;

/** A stable React key for a page element. */
export function elementKey(element: Element): number {
  let key = keys.get(element);
  if (key === undefined) {
    key = nextKey++;
    keys.set(element, key);
  }
  return key;
}
