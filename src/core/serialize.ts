import type { ConsoleEntry } from "../shared/timeline.ts";

export type Json = ConsoleEntry["args"][number];

export const MAX_STRING = 2000;
const MAX_DEPTH = 3;
const MAX_ITEMS = 50;
const MAX_KEYS = 50;
// The per-value caps alone allow 50^3 nodes per argument; this bounds one call.
const MAX_NODES = 1000;
// Bounds the serialized JSON text of one call: strings, keys, descriptions, and syntax.
export const MAX_CALL_CHARS = 8000;
const EXHAUSTED = "[…]";

interface Walk {
  ancestors: unknown[];
  nodes: number;
  chars: number;
}

// V8 can keep a slice as a view of its whole source string, and a page string may
// itself be such a view, so a kept string is an independent copy.
export function detach(text: string): string {
  return structuredClone(text);
}

export function capString(text: string, max = MAX_STRING): string {
  return detach(text.length <= max ? text : `${text.slice(0, max)}…[+${text.length - max} chars]`);
}

// Converts console arguments to JSON at capture time so the buffer never
// holds a reference to an app object. Getters are reported, never invoked.
export function serializeArgs(args: readonly unknown[]): Json[] {
  const walk: Walk = { ancestors: [], nodes: 0, chars: 0 };
  return args.map((value) => serialize(value, 0, walk));
}

function exhausted(walk: Walk): boolean {
  return walk.nodes >= MAX_NODES || walk.chars >= MAX_CALL_CHARS;
}

// Charges a string, with its quotes, against the call's budget and cuts it to what is left.
function spend(walk: Walk, text: string): string {
  const kept = capString(text, Math.max(0, Math.min(MAX_STRING, MAX_CALL_CHARS - walk.chars)));
  walk.chars += kept.length + 2;
  return kept;
}

// Joins arguments the way a console line reads: strings verbatim, the rest as JSON.
export function formatArgs(args: readonly unknown[]): string {
  const text = serializeArgs(args)
    .map((value) =>
      Object.prototype.toString.call(value) === "[object String]"
        ? String(value)
        : JSON.stringify(value),
    )
    .join(" ");
  return capString(text);
}

export function errorText(error: Error): string {
  const head = `${error.name}: ${error.message}`;
  const stack = error.stack ?? "";
  if (stack === "") return capString(head);
  return capString(stack.startsWith(head) ? stack : `${head}\n${stack}`);
}

function serialize<Value>(value: Value, depth: number, walk: Walk): Json {
  if (exhausted(walk)) return EXHAUSTED;
  walk.nodes += 1;
  // The separator or bracket that each value adds to the JSON text.
  walk.chars += 1;
  if (value === null) {
    walk.chars += 4;
    return null;
  }
  let tag: string;
  try {
    tag = Object.prototype.toString.call(value);
  } catch (cause) {
    return spend(walk, `[Unserializable: ${String(cause)}]`);
  }
  switch (tag) {
    case "[object Undefined]":
      return spend(walk, "[undefined]");
    case "[object String]":
      return spend(walk, String(value));
    case "[object Number]": {
      const number = Number(value);
      if (!Number.isFinite(number)) return spend(walk, `[${number}]`);
      walk.chars += String(number).length;
      return number;
    }
    case "[object Boolean]":
      walk.chars += 5;
      return String(value) === "true";
    case "[object BigInt]":
      return spend(walk, `${String(value)}n`);
    case "[object Symbol]":
      return spend(walk, String(value));
  }
  if (value instanceof Function) return spend(walk, `[Function ${value.name || "(anonymous)"}]`);
  return serializeObject(value, depth, walk);
}

function serializeObject<Value>(value: Value, depth: number, walk: Walk): Json {
  const leaf = describeLeaf(value);
  if (leaf !== undefined) return spend(walk, leaf);
  if (walk.ancestors.includes(value)) return spend(walk, "[Circular]");
  if (depth >= MAX_DEPTH) return spend(walk, describeCollapsed(value));
  walk.ancestors.push(value);
  try {
    if (Array.isArray(value)) return serializeItems(value, value.length, depth, walk);
    if (value instanceof Map) {
      const pairs = [...value.entries()].slice(0, MAX_ITEMS).map(([key, item]) => [key, item]);
      return { "[Map]": serializeItems(pairs, value.size, depth, walk) };
    }
    if (value instanceof Set) {
      return { "[Set]": serializeItems([...value].slice(0, MAX_ITEMS), value.size, depth, walk) };
    }
    return serializeKeys(value, depth, walk);
  } catch (cause) {
    return spend(walk, `[Unserializable: ${String(cause)}]`);
  } finally {
    walk.ancestors.pop();
  }
}

function serializeItems(
  items: readonly unknown[],
  total: number,
  depth: number,
  walk: Walk,
): Json[] {
  const out: Json[] = [];
  const count = Math.min(items.length, MAX_ITEMS);
  while (out.length < count && !exhausted(walk)) {
    out.push(serialize(items[out.length], depth + 1, walk));
  }
  if (total > out.length) out.push(`[+${total - out.length} items]`);
  return out;
}

function serializeKeys<Value>(value: Value, depth: number, walk: Walk): Json {
  const target = Object(value);
  const keys = Object.keys(target);
  const out: Record<string, Json> = {};
  let written = 0;
  for (const key of keys) {
    if (written === MAX_KEYS || exhausted(walk)) break;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    // The colon after the quoted key.
    walk.chars += 1;
    out[spend(walk, key)] =
      descriptor === undefined || !("value" in descriptor)
        ? spend(walk, "[Getter]")
        : serialize(descriptor.value, depth + 1, walk);
    written += 1;
  }
  if (keys.length > written) out["…"] = `[+${keys.length - written} keys]`;
  return out;
}

function describeLeaf<Value>(value: Value): string | undefined {
  if (value instanceof Error) return errorText(value);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
  }
  if (value instanceof RegExp) return String(value);
  if (globalThis.Node !== undefined && value instanceof Node) return describeNode(value);
  if (globalThis.window !== undefined && value === globalThis.window) return "[Window]";
  if (value instanceof Promise) return "[Promise]";
  if (value instanceof WeakMap) return "[WeakMap]";
  if (value instanceof WeakSet) return "[WeakSet]";
  if (value instanceof ArrayBuffer) return `[ArrayBuffer(${value.byteLength})]`;
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name}(${value.byteLength} bytes)]`;
  return undefined;
}

function describeCollapsed<Value>(value: Value): string {
  if (Array.isArray(value)) return `[Array(${value.length})]`;
  if (value instanceof Map) return `[Map(${value.size})]`;
  if (value instanceof Set) return `[Set(${value.size})]`;
  return "[Object]";
}

function describeNode(node: Node): string {
  if (node instanceof Element) {
    const id = node.id === "" ? "" : `#${node.id}`;
    const classes = [...node.classList]
      .slice(0, 3)
      .map((name) => `.${name}`)
      .join("");
    return `[Element ${node.localName}${id}${classes}]`;
  }
  if (node instanceof Text) return `[Text ${JSON.stringify(capString(node.data, 40))}]`;
  return `[${node.nodeName}]`;
}
