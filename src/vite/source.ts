import { posix } from "node:path";

import MagicString from "magic-string";
import {
  Visitor,
  normalizePath,
  parseSync,
  searchForWorkspaceRoot,
  type ESTree,
  type Plugin,
} from "vite";

const ATTRIBUTE = "data-pka-src";

function isHostElement(name: ESTree.JSXElementName): boolean {
  return name.type === "JSXIdentifier" && /^[a-z]/.test(name.name);
}

function lineStarts(code: string): number[] {
  const starts = [0];
  for (let index = 0; index < code.length; index++) {
    if (code.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function location(starts: number[], offset: number): string {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? Infinity) <= offset) low = middle;
    else high = middle - 1;
  }
  return `${low + 1}:${offset - (starts[low] ?? 0) + 1}`;
}

/** Adds data-pka-src="<relativePath>:<line>:<column>" (1-based) to every host JSX element. */
export function stampSource(
  code: string,
  file: string,
  relativePath: string,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  const result = parseSync(file, code, { sourceType: "module" });
  // A file that does not parse is left for the next transform to report.
  if (result.errors.length > 0) return null;
  const starts = lineStarts(code);
  const output = new MagicString(code);
  const escaped = relativePath.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  new Visitor({
    JSXOpeningElement(node) {
      if (!isHostElement(node.name)) return;
      const stamped = node.attributes.some(
        (attribute) =>
          attribute.type === "JSXAttribute" &&
          attribute.name.type === "JSXIdentifier" &&
          attribute.name.name === ATTRIBUTE,
      );
      if (stamped) return;
      output.appendLeft(
        node.name.end,
        ` ${ATTRIBUTE}="${escaped}:${location(starts, node.start)}"`,
      );
    },
  }).visit(result.program);
  if (!output.hasChanged()) return null;
  return { code: output.toString(), map: output.generateMap({ hires: "boundary" }) };
}

/**
 * Runs before every other transform (hook order "pre") in every environment,
 * so client, route-split client chunks (?tsr-split=…), and SSR stamp the
 * untouched source and hydrate with identical attributes.
 */
export function sourcePlugin(): Plugin {
  let workspaceRoot = "";
  return {
    name: "pk-annotator:source",
    apply: "serve",
    enforce: "pre",
    configResolved(config) {
      workspaceRoot = normalizePath(searchForWorkspaceRoot(config.root));
    },
    transform: {
      order: "pre",
      filter: { id: { include: /\.[jt]sx(?:\?|$)/, exclude: /\/node_modules\// } },
      handler(code, id) {
        const file = id.split("?", 1)[0] ?? id;
        if (!file.startsWith(`${workspaceRoot}/`)) return null;
        return stampSource(code, file, posix.relative(workspaceRoot, file));
      },
    },
  };
}
