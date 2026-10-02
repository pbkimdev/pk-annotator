import path from "node:path";

import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import type { DevEnvironment, TransformResult } from "vite";

// "    at fn (http://host/src/a.tsx?t=1:12:7)", "    at http://host/src/a.tsx:12:7", "fn@http://host/src/a.tsx:12:7"
const FRAME =
  /^(?<head>.*?)(?<url>https?:\/\/[^\s()]+?):(?<line>\d+):(?<column>\d+)(?<tail>\)?\s*)$/;
const VENDOR = /\/node_modules\/|\/\.vite\/deps\/|\/@vite\//;

const traceMaps = new WeakMap<TransformResult, TraceMap>();

export interface Symbolicated {
  stack: string;
  /** workspace-relative file:line of the first in-app frame. */
  topFrame: string | undefined;
}

async function traceMapFor(
  environment: DevEnvironment,
  url: string,
): Promise<TraceMap | undefined> {
  const module = await environment.moduleGraph.getModuleByUrl(url);
  const result = module?.transformResult;
  if (module?.file == null || result == null || result.map == null) return undefined;
  if (result.map.mappings === "") return undefined;
  let map = traceMaps.get(result);
  if (map === undefined) {
    map = new TraceMap(JSON.stringify(result.map), module.file);
    traceMaps.set(result, map);
  }
  return map;
}

/**
 * Maps every frame of a browser stack whose URL is a module in the client
 * module graph back to its original file, line, and column, relative to the
 * workspace root. Dependency and Vite client frames stay as they are.
 */
export async function symbolicate(
  environment: DevEnvironment,
  workspaceRoot: string,
  stack: string,
): Promise<Symbolicated> {
  const base = environment.config.base;
  let topFrame: string | undefined;
  const lines: string[] = [];
  for (const line of stack.split("\n")) {
    const frame = FRAME.exec(line)?.groups;
    if (frame === undefined) {
      lines.push(line);
      continue;
    }
    const { head = "", url = "", tail = "" } = frame;
    const parsed = URL.parse(url);
    const requested = parsed === null ? "" : `${parsed.pathname}${parsed.search}`;
    if (!requested.startsWith(base) || VENDOR.test(requested)) {
      lines.push(line);
      continue;
    }
    const map = await traceMapFor(environment, `/${requested.slice(base.length)}`);
    const original =
      map === undefined
        ? undefined
        : originalPositionFor(map, {
            line: Number(frame["line"]),
            column: Number(frame["column"]) - 1,
          });
    if (original?.source == null) {
      lines.push(line);
      continue;
    }
    // Split route chunks name their source with the query, for example lab.tsx?tsr-split=component.
    const resolved = original.source.startsWith("file://")
      ? new URL(original.source).pathname
      : original.source;
    const source = resolved.split("?", 1)[0] ?? resolved;
    const relative = path.relative(workspaceRoot, source);
    const inWorkspace = !relative.startsWith("..") && !path.isAbsolute(relative);
    const file = inWorkspace ? relative.split(path.sep).join("/") : source;
    lines.push(`${head}${file}:${original.line}:${original.column + 1}${tail}`);
    if (topFrame === undefined && inWorkspace && !VENDOR.test(`/${file}`)) {
      topFrame = `${file}:${original.line}`;
    }
  }
  return { stack: lines.join("\n"), topFrame };
}
