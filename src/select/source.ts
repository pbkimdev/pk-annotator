import {
  getDisplayName,
  getFiberFromHostInstance,
  isCompositeFiber,
  isFiber,
  isHostFiber,
} from "bippy";
import type { Fiber } from "bippy";
import { formatOwnerStack, parseStack, symbolicateStack, type StackFrame } from "bippy/source";

import { untrackedFetch } from "../overlay/untracked-fetch.ts";

export const SOURCE_ATTRIBUTE = "data-pka-src";

export type Location = {
  /** The component the element belongs to: its owner, or the component at `usedAt`. */
  component?: string;
  /** The host element's own JSX, `file:line:col`. */
  source?: string;
  /** Call site of the nearest owner in project code, `file:line:col`, when it differs from source. */
  usedAt?: string;
  /** Owner component names, nearest first, without frames from node_modules. */
  owners: string[];
};

type Step = { fiber: Fiber; owner: Fiber | undefined; site: StackFrame | undefined };

const LOCATIONS = new WeakMap<Element, Promise<Location>>();

/** Resolves an element's source locations; cached per element. */
export function locate(element: Element): Promise<Location> {
  let location = LOCATIONS.get(element);
  if (location === undefined) {
    location = resolve(element);
    LOCATIONS.set(element, location);
  }
  return location;
}

/** The nearest owner component name, without waiting for source maps. */
export function ownerName(element: Element): string | undefined {
  const steps = ownerSteps(element);
  if (steps.length === 0) return undefined;
  const index = usedAtIndex(element, steps);
  const fiber = index === undefined ? steps[0]?.owner : steps[index]?.fiber;
  return fiber === undefined ? undefined : (getDisplayName(fiber.type) ?? undefined);
}

/** True when the element is the outermost host element a component renders. */
export function isComponentRoot(element: Element): boolean {
  const fiber = getFiberFromHostInstance(element);
  for (let parent = fiber?.return ?? null; parent !== null; parent = parent.return) {
    if (isHostFiber(parent)) return false;
    if (isCompositeFiber(parent)) return true;
  }
  return false;
}

/** Loads the source maps behind an element's owner stack so the first hover is fast. */
export function prewarm(elements: Iterable<Element>): void {
  for (const element of elements) void locate(element);
}

function ownerSteps(element: Element): Step[] {
  const steps: Step[] = [];
  let fiber: Fiber | null = getFiberFromHostInstance(element);
  while (fiber !== null) {
    const owner = isFiber(fiber._debugOwner) ? fiber._debugOwner : undefined;
    const stack = fiber._debugStack?.stack;
    const site = stack === undefined ? undefined : parseStack(formatOwnerStack(stack))[0];
    steps.push({ fiber, owner, site });
    fiber = owner ?? null;
  }
  return steps;
}

function isProjectFrame(frame: StackFrame | undefined): frame is StackFrame {
  const fileName = frame?.fileName;
  if (fileName === undefined || !URL.canParse(fileName)) return false;
  const url = new URL(fileName);
  if (url.origin !== location.origin || url.pathname.includes("/node_modules/")) return false;
  return !url.pathname.startsWith("/@") || url.pathname.startsWith("/@fs/");
}

// steps[i].site is where fiber i's JSX was created, inside the body of steps[i].owner.
// With the element's own JSX in project code, usedAt is where its owner component is
// used (steps[1]) when that is project code too. Otherwise (Radix content, portals,
// library elements) it is the first project frame up the owner stack.
function usedAtIndex(element: Element, steps: Step[]): number | undefined {
  const ownJsx = element.hasAttribute(SOURCE_ATTRIBUTE) || isProjectFrame(steps[0]?.site);
  if (ownJsx) return isProjectFrame(steps[1]?.site) ? 1 : undefined;
  const index = steps.findIndex((step, position) => position > 0 && isProjectFrame(step.site));
  return index < 0 ? undefined : index;
}

// Owner names, nearest first, from the owners whose JSX runs in project code.
function ownerNames(steps: readonly Step[]): string[] {
  const owners: string[] = [];
  for (const step of steps) {
    if (step.owner === undefined || !isProjectFrame(step.site)) continue;
    const name = getDisplayName(step.owner.type);
    if (name !== null && owners.at(-1) !== name) owners.push(name);
  }
  return owners;
}

async function resolve(element: Element): Promise<Location> {
  const attribute = element.getAttribute(SOURCE_ATTRIBUTE) ?? undefined;
  const steps = ownerSteps(element);
  const index = usedAtIndex(element, steps);
  const ownSite = steps[0]?.site;
  const usedAtSite = index === undefined ? undefined : steps[index]?.site;
  if (attribute !== undefined && isProjectFrame(ownSite)) calibrate(attribute, ownSite);

  const [source, usedAt] = await Promise.all([
    attribute === undefined && isProjectFrame(ownSite) ? symbolicate(ownSite) : attribute,
    usedAtSite === undefined ? undefined : symbolicate(usedAtSite),
  ]);

  const location: Location = { owners: ownerNames(steps.slice(index ?? 0)) };
  const component = ownerName(element);
  if (component !== undefined) location.component = component;
  if (source !== undefined) location.source = source;
  if (usedAt !== undefined && usedAt !== source) location.usedAt = usedAt;
  return location;
}

/** A frame as workspace `file:line:col` through its source map, or undefined when unmapped. */
export async function symbolicate(frame: StackFrame): Promise<string | undefined> {
  // bippy reads globalThis.fetch, which the free-fetch injection does not reach.
  const [resolved] = await symbolicateStack([frame], true, untrackedFetch);
  if (
    resolved?.isSymbolicated !== true ||
    resolved.fileName === undefined ||
    resolved.lineNumber === undefined ||
    resolved.columnNumber === undefined ||
    frame.fileName === undefined
  ) {
    return undefined;
  }
  // Vite source maps name the file by basename; resolve it against the module URL.
  const file = projectPath(new URL(resolved.fileName, frame.fileName).pathname);
  return `${file}:${resolved.lineNumber}:${resolved.columnNumber + 1}`;
}

// The plugin stamps workspace-relative paths, while module URLs are relative to the
// Vite root (or /@fs/<absolute path> outside it). One stamped element tells the
// difference, so bippy locations print in the same form as data-pka-src.
let rootPrefix: string | undefined;
let workspaceRoot: string | undefined;

function calibrate(attribute: string, frame: StackFrame): void {
  if (frame.fileName === undefined) return;
  const file = attribute.replace(/:\d+:\d+$/, "");
  const pathname = new URL(frame.fileName).pathname;
  if (pathname.startsWith("/@fs/")) {
    const absolute = pathname.slice("/@fs".length);
    if (absolute.endsWith(`/${file}`)) workspaceRoot = absolute.slice(0, -file.length);
  } else if (file.endsWith(pathname.slice(1))) {
    rootPrefix = file.slice(0, file.length - pathname.length + 1);
  }
}

function projectPath(pathname: string): string {
  if (pathname.startsWith("/@fs/")) {
    const absolute = pathname.slice("/@fs".length);
    return workspaceRoot !== undefined && absolute.startsWith(workspaceRoot)
      ? absolute.slice(workspaceRoot.length)
      : absolute;
  }
  return `${rootPrefix ?? ""}${pathname.slice(1)}`;
}

/** Calibrates paths from the first stamped element so early lookups print workspace paths. */
export function calibrateFromDocument(): void {
  if (rootPrefix !== undefined) return;
  const stamped = document.querySelector(`[${SOURCE_ATTRIBUTE}]`);
  if (stamped === null) return;
  const site = ownerSteps(stamped)[0]?.site;
  const attribute = stamped.getAttribute(SOURCE_ATTRIBUTE);
  if (attribute !== null && isProjectFrame(site)) calibrate(attribute, site);
}
