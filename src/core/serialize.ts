import type { ConsoleEntry } from "../shared/timeline.ts";

export type Json = ConsoleEntry["args"][number];

export const MAX_STRING = 2000;
const MAX_DEPTH = 3;
const MAX_ARGS = 50;
const MAX_ITEMS = 50;
const MAX_KEYS = 50;
// The per-value caps alone allow 50^3 nodes per argument; this bounds one call.
const MAX_NODES = 1000;
// Bounds JSON.stringify of one call's arguments, escapes and overflow notes included.
export const MAX_CALL_CHARS = 8000;
// Kept free in every open array or object for its closing brackets and its overflow note.
const NOTE_ROOM = 40;
// Kept free while a key is cut, so a short or cut value can still follow it.
const VALUE_ROOM = 24;

// A value that does not fit what is left of the call's budget; none of it was charged.
const NO_FIT = Symbol("no fit");
type Fit = Json | typeof NO_FIT;

interface Walk {
  ancestors: unknown[];
  nodes: number;
  // JSON characters written so far, and those promised to the open arrays and objects.
  used: number;
  reserved: number;
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
  const walk: Walk = { ancestors: [], nodes: 0, used: 0, reserved: 0 };
  const out = serializeList(args, args.length, MAX_ARGS, 0, walk, "[", "]", "args");
  if (out === NO_FIT) throw new Error("The console budget cannot hold an empty argument list");
  return out;
}

function room(walk: Walk): number {
  return MAX_CALL_CHARS - walk.used - walk.reserved;
}

function charge(walk: Walk, length: number, value: Json): Fit {
  if (length > room(walk)) return NO_FIT;
  walk.used += length;
  return value;
}

// The JSON.stringify length and the UTF-16 length of the character at `index`: quotes,
// backslashes, controls, and lone surrogates are escaped.
function escaped(text: string, index: number): [length: number, units: number] {
  const code = text.charCodeAt(index);
  if (code === 0x22 || code === 0x5c) return [2, 1];
  if (code < 0x20)
    return [code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6, 1];
  if (code < 0xd800 || code > 0xdfff) return [1, 1];
  const next = text.charCodeAt(index + 1);
  return code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? [2, 2] : [6, 1];
}

// Charges a string with its quotes and escapes. One that does not fit is cut to what is
// left, ending in a note of how much was cut.
function fitString(walk: Walk, text: string): string | typeof NO_FIT {
  const available = room(walk);
  const limit = Math.min(text.length, MAX_STRING);
  // "…[+N chars]" needs no escapes, and N has at most as many digits as the length.
  const noteLength = 10 + String(text.length).length;
  let length = 2;
  let end = 0;
  let cut = -1;
  let cutLength = 0;
  for (;;) {
    if (length + noteLength <= available) {
      cut = end;
      cutLength = length;
    }
    if (end >= limit || length > available) break;
    const [cost, units] = escaped(text, end);
    length += cost;
    end += units;
  }
  if (end >= text.length && length <= available) {
    walk.used += length;
    return detach(text);
  }
  if (cut < 0) return NO_FIT;
  const note = `…[+${text.length - cut} chars]`;
  walk.used += cutLength + note.length;
  return detach(`${text.slice(0, cut)}${note}`);
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

function serialize<Value>(value: Value, depth: number, walk: Walk): Fit {
  if (walk.nodes >= MAX_NODES) return NO_FIT;
  walk.nodes += 1;
  if (value === null) return charge(walk, 4, null);
  let tag: string;
  try {
    tag = Object.prototype.toString.call(value);
  } catch (cause) {
    return fitString(walk, `[Unserializable: ${String(cause)}]`);
  }
  switch (tag) {
    case "[object Undefined]":
      return fitString(walk, "[undefined]");
    case "[object String]":
      return fitString(walk, String(value));
    case "[object Number]": {
      const number = Number(value);
      return Number.isFinite(number)
        ? charge(walk, String(number).length, number)
        : fitString(walk, `[${number}]`);
    }
    case "[object Boolean]": {
      const flag = String(value) === "true";
      return charge(walk, flag ? 4 : 5, flag);
    }
    case "[object BigInt]":
      return fitString(walk, `${String(value)}n`);
    case "[object Symbol]":
      return fitString(walk, String(value));
  }
  if (value instanceof Function) {
    return fitString(walk, `[Function ${value.name || "(anonymous)"}]`);
  }
  return serializeObject(value, depth, walk);
}

function serializeObject<Value>(value: Value, depth: number, walk: Walk): Fit {
  const leaf = describeLeaf(value);
  if (leaf !== undefined) return fitString(walk, leaf);
  if (walk.ancestors.includes(value)) return fitString(walk, "[Circular]");
  if (depth >= MAX_DEPTH) return fitString(walk, describeCollapsed(value));
  const { used, reserved } = walk;
  walk.ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      return serializeList(value, value.length, MAX_ITEMS, depth + 1, walk, "[", "]", "items");
    }
    if (value instanceof Map || value instanceof Set) {
      const name = value instanceof Map ? "[Map]" : "[Set]";
      const items = [...value.entries()].slice(0, MAX_ITEMS);
      const list = serializeList(
        value instanceof Map ? items : items.map(([item]) => item),
        value.size,
        MAX_ITEMS,
        depth + 1,
        walk,
        `{"${name}":[`,
        "]}",
        "items",
      );
      return list === NO_FIT ? NO_FIT : { [name]: list };
    }
    return serializeKeys(value, depth, walk);
  } catch (cause) {
    // A proxy or getter-free accessor can throw midway; nothing of the value is kept.
    walk.used = used;
    walk.reserved = reserved;
    return fitString(walk, `[Unserializable: ${String(cause)}]`);
  } finally {
    walk.ancestors.pop();
  }
}

// Writes as many items as the caps and the budget allow, then a note counting the rest.
function serializeList(
  items: readonly unknown[],
  total: number,
  max: number,
  depth: number,
  walk: Walk,
  open: string,
  close: string,
  noun: string,
): Json[] | typeof NO_FIT {
  if (open.length + close.length + NOTE_ROOM > room(walk)) return NO_FIT;
  walk.used += open.length;
  walk.reserved += close.length + NOTE_ROOM;
  const out: Json[] = [];
  const count = Math.min(items.length, max);
  while (out.length < count) {
    const comma = out.length === 0 ? 0 : 1;
    if (comma > room(walk)) break;
    walk.used += comma;
    const item = serialize(items[out.length], depth, walk);
    if (item === NO_FIT) {
      walk.used -= comma;
      break;
    }
    out.push(item);
  }
  walk.reserved -= close.length + NOTE_ROOM;
  walk.used += close.length;
  if (total > out.length) {
    const note = `[+${total - out.length} ${noun}]`;
    walk.used += (out.length === 0 ? 0 : 1) + note.length + 2;
    out.push(note);
  }
  return out;
}

function serializeKeys<Value>(value: Value, depth: number, walk: Walk): Fit {
  if (2 + NOTE_ROOM > room(walk)) return NO_FIT;
  const target = Object(value);
  const keys = Object.keys(target);
  walk.used += 1;
  walk.reserved += 1 + NOTE_ROOM;
  const out: Record<string, Json> = {};
  let written = 0;
  for (const key of keys) {
    if (written === MAX_KEYS) break;
    const before = walk.used;
    // The comma before a later member and the colon after the key.
    const syntax = written === 0 ? 1 : 2;
    if (syntax > room(walk)) break;
    walk.used += syntax;
    walk.reserved += VALUE_ROOM;
    const name = fitString(walk, key);
    walk.reserved -= VALUE_ROOM;
    let item: Fit = NO_FIT;
    if (name !== NO_FIT) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      item =
        descriptor === undefined || !("value" in descriptor)
          ? fitString(walk, "[Getter]")
          : serialize(descriptor.value, depth + 1, walk);
    }
    if (name === NO_FIT || item === NO_FIT) {
      walk.used = before;
      break;
    }
    out[name] = item;
    written += 1;
  }
  walk.reserved -= 1 + NOTE_ROOM;
  walk.used += 1;
  if (keys.length > written) {
    const note = `[+${keys.length - written} keys]`;
    walk.used += (written === 0 ? 0 : 1) + 4 + note.length + 2;
    out["…"] = note;
  }
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
