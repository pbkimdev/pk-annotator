import type { Box, Selector } from "../shared/schema.ts";

export type Description = {
  selector: Selector;
  html: string;
  box: Box;
  text?: string;
};

const HTML_LIMIT = 2048;
const TEXT_LIMIT = 300;
const NAME_LIMIT = 120;

/** Selector, trimmed outerHTML, viewport box, and visible text of a page element. */
export function describe(element: Element): Description {
  const testId = element.getAttribute("data-testid") ?? undefined;
  const role = roleOf(element);
  const name = role === undefined ? undefined : accessibleName(element, role);
  const text = FORM_FIELDS.has(element.localName) ? undefined : visibleText(element);
  const rect = element.getBoundingClientRect();
  const selector: Selector = { css: cssSelector(element) };
  if (role !== undefined) selector.role = role;
  if (name !== undefined) selector.name = name;
  if (testId !== undefined) selector.testId = testId;
  const description: Description = {
    selector,
    html: trimmedHtml(element),
    box: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
  };
  if (text !== undefined) description.text = text;
  return description;
}

/** The locator an agent should try first: test id, stable id, role and name, text, then CSS. */
export function preferredLocator(description: Description): string {
  const { selector, text } = description;
  if (selector.testId !== undefined) return `[data-testid="${selector.testId}"]`;
  if (selector.css.startsWith("#") && !selector.css.includes(" ")) return selector.css;
  if (selector.role !== undefined && selector.name !== undefined) {
    return `role=${selector.role}[name="${selector.name}"]`;
  }
  const interactive = selector.role !== undefined && INTERACTIVE_ROLES.has(selector.role);
  if (!interactive && text !== undefined && text.length <= 80) return `text="${text}"`;
  return selector.css;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// React useId (:r1:, «r1», _r_1_), Radix (radix-:r1:), and hash- or counter-like ids
// change between renders and builds, so they make poor selectors.
const GENERATED_ID = /[:«»]|^_r_|\d{3,}|[a-f0-9]{8,}|^(?:radix|headlessui|mui|rc)-/i;

function stableId(element: Element): string | undefined {
  const id = element.id;
  return id !== "" && !GENERATED_ID.test(id) ? id : undefined;
}

function isUnique(selector: string, element: Element): boolean {
  const matches = element.ownerDocument.querySelectorAll(selector);
  return matches.length === 1 && matches[0] === element;
}

function cssSelector(element: Element): string {
  const testId = element.getAttribute("data-testid");
  if (testId !== null) {
    const selector = `[data-testid="${CSS.escape(testId)}"]`;
    if (isUnique(selector, element)) return selector;
  }
  const id = stableId(element);
  if (id !== undefined && isUnique(`#${CSS.escape(id)}`, element)) return `#${CSS.escape(id)}`;

  const segments: string[] = [];
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    const currentId = current === element ? undefined : stableId(current);
    if (currentId !== undefined && isUnique(`#${CSS.escape(currentId)}`, current)) {
      segments.unshift(`#${CSS.escape(currentId)}`);
    } else {
      segments.unshift(segment(current));
    }
    const selector = segments.join(" > ");
    if (isUnique(selector, element)) return selector;
    if (currentId !== undefined || current.localName === "html") break;
  }
  throw new Error(`No unique CSS selector for <${element.localName}>`);
}

function segment(element: Element): string {
  const tag = CSS.escape(element.localName);
  const parent = element.parentElement;
  if (parent === null) return tag;
  const sameTag = [...parent.children].filter((child) => child.localName === element.localName);
  return sameTag.length === 1 ? tag : `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`;
}

const FORM_FIELDS = new Set(["input", "textarea", "select"]);

const INPUT_ROLES = new Map([
  ["button", "button"],
  ["submit", "button"],
  ["reset", "button"],
  ["image", "button"],
  ["checkbox", "checkbox"],
  ["radio", "radio"],
  ["range", "slider"],
  ["number", "spinbutton"],
  ["search", "searchbox"],
]);

const TAG_ROLES = new Map([
  ["button", "button"],
  ["select", "combobox"],
  ["textarea", "textbox"],
  ["h1", "heading"],
  ["h2", "heading"],
  ["h3", "heading"],
  ["h4", "heading"],
  ["h5", "heading"],
  ["h6", "heading"],
  ["li", "listitem"],
  ["ul", "list"],
  ["ol", "list"],
  ["nav", "navigation"],
  ["main", "main"],
  ["dialog", "dialog"],
  ["table", "table"],
  ["tr", "row"],
  ["td", "cell"],
  ["th", "columnheader"],
  ["option", "option"],
  ["progress", "progressbar"],
  ["summary", "button"],
]);

function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = element.localName;
  if (tag === "a" || tag === "area") return element.hasAttribute("href") ? "link" : undefined;
  if (tag === "img") return element.getAttribute("alt") === "" ? "presentation" : "img";
  if (tag === "input") {
    return INPUT_ROLES.get((element.getAttribute("type") ?? "text").toLowerCase()) ?? "textbox";
  }
  return TAG_ROLES.get(tag);
}

// Roles whose accessible name comes from their content (WAI-ARIA "name from content").
const NAME_FROM_CONTENT = new Set([
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
]);

function accessibleName(element: Element, role: string): string | undefined {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
    const name = normalize(text, NAME_LIMIT);
    if (name !== undefined) return name;
  }
  const label = normalize(element.getAttribute("aria-label") ?? "", NAME_LIMIT);
  if (label !== undefined) return label;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const fromLabel = normalize(
      [...(element.labels ?? [])].map((labelElement) => labelElement.textContent).join(" "),
      NAME_LIMIT,
    );
    if (fromLabel !== undefined) return fromLabel;
    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type)
    ) {
      return normalize(element.value, NAME_LIMIT);
    }
  }
  if (element.localName === "img") return normalize(element.getAttribute("alt") ?? "", NAME_LIMIT);
  if (NAME_FROM_CONTENT.has(role)) {
    const fromContent = normalize(element.textContent ?? "", NAME_LIMIT);
    if (fromContent !== undefined) return fromContent;
  }
  return normalize(element.getAttribute("title") ?? "", NAME_LIMIT);
}

function visibleText(element: Element): string | undefined {
  const text = element instanceof HTMLElement ? element.innerText : element.textContent;
  return normalize(text ?? "", TEXT_LIMIT);
}

function normalize(value: string, limit: number): string | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function trimmedHtml(element: Element): string {
  const html = element.outerHTML
    .replace(/\sdata-pka-src="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return html.length <= HTML_LIMIT ? html : `${html.slice(0, HTML_LIMIT - 1)}…`;
}
