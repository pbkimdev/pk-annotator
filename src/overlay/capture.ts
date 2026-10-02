import type { Capture } from "../core/index.ts";
import type { Mounted } from "./index.ts";

export type Active = { mounted: Mounted; capture: Capture };

declare global {
  // Kept on globalThis so a re-executed overlay module (HMR) finds the instance that
  // already patched console, fetch, and history instead of patching them again.
  var __PKA_ACTIVE__: Active | undefined;
}

export function getActive(): Active | undefined {
  return globalThis.__PKA_ACTIVE__;
}

export function setActive(active: Active | undefined): void {
  globalThis.__PKA_ACTIVE__ = active;
}

/** The page's capture instance, started by mount(). */
export function getCapture(): Capture {
  const active = getActive();
  if (active === undefined) throw new Error("pk-annotator: getCapture() called before mount()");
  return active.capture;
}
