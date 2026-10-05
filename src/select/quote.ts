import type { Quote } from "../shared/schema.ts";
import { isMenu, isTextField } from "./pick.ts";

const CONTEXT = 32;

export type TextPickHandlers = {
  select(element: Element, quote: Quote, range: Range): void;
  escape(): void;
  enter(): void;
};

/** The quote of `range` inside `element`, which contains it. */
export function quoteOf(range: Range, element: Element): Quote {
  const before = document.createRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(element);
  after.setStart(range.endContainer, range.endOffset);
  return {
    exact: range.toString(),
    prefix: before.toString().slice(-CONTEXT),
    suffix: after.toString().slice(0, CONTEXT),
  };
}

/**
 * Finds the quote in `element`'s text again, after a render replaced the text nodes the
 * selection was made in. Of several matches, the one whose surrounding text matches most wins.
 */
export function findQuote(element: Element, quote: Quote): Range | null {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) nodes.push(node);
  }
  const text = nodes.map((node) => node.data).join("");
  let best: { at: number; score: number } | undefined;
  for (let at = text.indexOf(quote.exact); at !== -1; at = text.indexOf(quote.exact, at + 1)) {
    const score =
      Number(text.slice(0, at).endsWith(quote.prefix)) +
      Number(text.slice(at + quote.exact.length).startsWith(quote.suffix));
    if (best === undefined || score > best.score) best = { at, score };
    if (score === 2) break;
  }
  if (best === undefined) return null;
  const start = position(nodes, best.at, false);
  const end = position(nodes, best.at + quote.exact.length, true);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

// An offset on a boundary between two text nodes is the end of the first for a range's end
// and the start of the second for its start, so the range never takes in an empty node.
function position(nodes: readonly Text[], offset: number, end: boolean) {
  let passed = 0;
  for (const node of nodes) {
    const length = node.data.length;
    if (end ? offset <= passed + length : offset < passed + length) {
      return { node, offset: offset - passed };
    }
    passed += length;
  }
  throw new Error(`Offset ${offset} is outside the element's ${passed} characters of text`);
}

/**
 * Takes each text selection made on the page while the Text tool is on. Pointer events
 * reach the page, so it selects and stays usable as usual. A selection is read when the
 * pointer or Shift is released, not on selectionchange, which fires for every step of a drag.
 */
export function startTextPicking(host: Element, handlers: TextPickHandlers): () => void {
  let frame = 0;
  const read = () => {
    frame = 0;
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (range.toString().trim() === "") return;
    const container = range.commonAncestorContainer;
    const element = container instanceof Element ? container : container.parentElement;
    if (element === null || element === document.documentElement || element.contains(host)) {
      return;
    }
    const quote = quoteOf(range, element);
    const kept = range.cloneRange();
    selection.removeAllRanges();
    handlers.select(element, quote, kept);
  };
  const schedule = (event: Event) => {
    if (event.composedPath().includes(host)) return;
    if (frame === 0) frame = requestAnimationFrame(read);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Shift") schedule(event);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.composedPath().some(isMenu)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      handlers.escape();
    } else if (event.key === "Enter" && !event.composedPath().some(isTextField)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      handlers.enter();
    }
  };

  const listening = new AbortController();
  const options = { capture: true, signal: listening.signal };
  window.addEventListener("pointerup", schedule, options);
  window.addEventListener("keyup", onKeyUp, options);
  window.addEventListener("keydown", onKeyDown, options);
  return () => {
    listening.abort();
    if (frame !== 0) cancelAnimationFrame(frame);
  };
}
