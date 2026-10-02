import type { HydrationOptions } from "react-dom/client";
import type { ViteHotContext } from "vite/types/hot.d.ts";

import { createLauncher } from "./launcher.ts";

export type MountOptions = { hot: ViteHotContext; theme?: "light" | "dark" | "system" };

export type Mounted = {
  reactRootOptions: Pick<
    HydrationOptions,
    "onCaughtError" | "onUncaughtError" | "onRecoverableError"
  >;
  unmount(): void;
};

/**
 * Mounts the launcher in its own shadow root. React, the UI, and the stylesheet load
 * on first open. Under automation (navigator.webdriver) nothing mounts.
 */
export function mount(options: MountOptions): Mounted {
  if (navigator.webdriver) return { reactRootOptions: {}, unmount() {} };
  const launcher = createLauncher(options.hot, options.theme ?? "system");
  return {
    // These keep React's default reporting until the capture lane records the errors.
    reactRootOptions: {
      onUncaughtError(error) {
        reportError(error);
      },
      onCaughtError(error, info) {
        console.error(error, info.componentStack);
      },
      onRecoverableError(error) {
        reportError(error);
      },
    },
    unmount: launcher.unmount,
  };
}
