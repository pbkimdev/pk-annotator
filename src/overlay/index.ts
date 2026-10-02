import type { HydrationOptions } from "react-dom/client";
import type { ViteHotContext } from "vite/types/hot.d.ts";

export type MountOptions = { hot: ViteHotContext; theme?: "light" | "dark" | "system" };

export type Mounted = {
  reactRootOptions: Pick<
    HydrationOptions,
    "onCaughtError" | "onUncaughtError" | "onRecoverableError"
  >;
  unmount(): void;
};

export function mount(_options: MountOptions): Mounted {
  return { reactRootOptions: {}, unmount() {} };
}
