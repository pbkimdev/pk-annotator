import type { ConsoleEntry } from "../shared/timeline.ts";

export type Json = ConsoleEntry["args"][number];

export const MAX_STRING = 2000;
const MAX_DEPTH = 3;
const MAX_ITEMS = 50;
const MAX_KEYS = 50;
// The per-value caps alone allow 50^3 nodes per argument; this bounds one call.
const MAX_NODES = 1000;

interface Walk {
  ancestors: unknown[];
  nodes: number;
}

export function capString(text: string, max = MAX_STRING): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

// Converts console arguments to JSON at capture time so the buffer never
// holds a reference to an app object. Getters are reported, never invoked.
export function serializeArgs(args: readonly unknown[]): Json[] {
  const walk: Walk = { ancestors: [], nodes: 0 };
  return args.map((value) => serialize(value, 0, walk));
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
  walk.nodes += 1;
  if (walk.nodes > MAX_NODES) return "[…]";
  if (value === null) return null;
  let tag: string;
  try {
    tag = Object.prototype.toString.call(value);
  } catch (cause) {
    return `[Unserializable: ${String(cause)}]`;
  }
  switch (tag) {
    case "[object Undefined]":
      return "[undefined]";
    case "[object String]":
      return capString(String(value));
    case "[object Number]": {
      const number = Number(value);
      return Number.isFinite(number) ? number : `[${number}]`;
    }
    case "[object Boolean]":
      return String(value) === "true";
    case "[object BigInt]":
      return `${String(value)}n`;
    case "[object Symbol]":
      return String(value);
  }
  if (value instanceof Function) return `[Function ${value.name || "(anonymous)"}]`;
  return serializeObject(value, depth, walk);
}

function serializeObject<Value>(value: Value, depth: number, walk: Walk): Json {
  const leaf = describeLeaf(value);
  if (leaf !== undefined) return leaf;
  if (walk.ancestors.includes(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return describeCollapsed(value);
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
    return `[Unserializable: ${String(cause)}]`;
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
  for (let index = 0; index < count; index += 1) {
    out.push(serialize(items[index], depth + 1, walk));
  }
  if (total > count) out.push(`[+${total - count} items]`);
  return out;
}

function serializeKeys<Value>(value: Value, depth: number, walk: Walk): Json {
  const target = Object(value);
  const keys = Object.keys(target);
  const out: Record<string, Json> = {};
  for (const key of keys.slice(0, MAX_KEYS)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    out[key] =
      descriptor === undefined || !("value" in descriptor)
        ? "[Getter]"
        : serialize(descriptor.value, depth + 1, walk);
  }
  if (keys.length > MAX_KEYS) out["…"] = `[+${keys.length - MAX_KEYS} keys]`;
  return out;
}

function describeLeaf<Value>(value: Value): Json | undefined {
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
