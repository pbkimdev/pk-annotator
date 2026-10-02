import type { AnnotationDraft, ElementRef } from "../shared/schema.ts";

export type LocatedElement = ElementRef & { locator: string };

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function attributes(pairs: [string, string | undefined][]): string {
  return pairs
    .filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== "")
    .map(([name, value]) => ` ${name}="${escape(value)}"`)
    .join("");
}

/**
 * The block from DESIGN.md "What the agent receives", without an id or binaries.
 * Page-derived values stay in attributes, apart from the human prompt.
 */
export function annotationBlock(
  draft: Pick<AnnotationDraft, "route" | "viewport" | "prompt">,
  elements: readonly LocatedElement[],
): string {
  const { w, h, dpr } = draft.viewport;
  return [
    `<annotation${attributes([
      ["route", draft.route],
      ["viewport", `${w}x${h}@${dpr}`],
    ])}>`,
    `<prompt>${escape(draft.prompt)}</prompt>`,
    ...elements.map(
      (ref) =>
        `<element${attributes([
          ["n", String(ref.n)],
          ["source", ref.source],
          ["usedAt", ref.usedAt],
          ["owners", ref.owners.join(" > ")],
          ["role", ref.selector.role],
          ["name", ref.selector.name],
          ["selector", ref.locator],
        ])}/>`,
    ),
    "</annotation>",
  ].join("\n");
}
