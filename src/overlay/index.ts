import { captureOwnerStack } from "react";
import type { HydrationOptions } from "react-dom/client";
import type { ViteHotContext } from "vite/types/hot.d.ts";

import { createCapture } from "../core/index.ts";
import type { CHANNEL } from "../shared/channel.ts";
import { getActive, setActive } from "./capture.ts";
import { send } from "./channel-client.ts";
import { createLauncher } from "./launcher.ts";
import { setBadge } from "./registry.ts";

const ERRORS_ACK: typeof CHANNEL.errorsAck = "pka:errors-ack";
type AckListener = Parameters<ViteHotContext["on"]>[1];

declare global {
  // Defined by the Vite plugin from its `bodies` option.
  var __PKA_BODIES__: string[] | undefined;
}

export type MountOptions = { hot: ViteHotContext; theme?: "light" | "dark" | "system" };

export type Mounted = {
  reactRootOptions: Pick<
    HydrationOptions,
    "onCaughtError" | "onUncaughtError" | "onRecoverableError"
  >;
  unmount(): void;
};

/**
 * Starts capture and mounts the launcher in its own shadow root. The UI chunk and its
 * stylesheet load on first open. Under automation (navigator.webdriver) nothing mounts.
 */
export function mount(options: MountOptions): Mounted {
  if (navigator.webdriver) return { reactRootOptions: {}, unmount() {} };
  const active = getActive();
  if (active !== undefined) return active.mounted;

  const capture = createCapture({
    send: (event, payload) => send(options.hot, event, payload),
    bodies: globalThis.__PKA_BODIES__ ?? [],
    captureOwnerStack,
  });
  // The schema module carries Zod, so it loads with the first ack instead of with the page.
  const receiveAck: AckListener = (payload) => {
    void import("../shared/channel.ts").then(({ ErrorsAckMessage }) => {
      const parsed = ErrorsAckMessage.safeParse(payload);
      if (parsed.success) capture.applySymbolicated(parsed.data);
      else console.error(`[pk-annotator] dropped an invalid ${ERRORS_ACK} message`, parsed.error);
    });
  };
  options.hot.on(ERRORS_ACK, receiveAck);
  const stopAck = () => options.hot.off(ERRORS_ACK, receiveAck);
  let open = 0;
  const stopBadge = capture.subscribe(() => {
    const count = capture.snapshot().groups.filter((group) => group.status === "open").length;
    if (count === open) return;
    open = count;
    setBadge(count);
  });
  const launcher = createLauncher(options.hot, options.theme ?? "system");

  const mounted: Mounted = {
    reactRootOptions: capture.reactRootOptions,
    unmount() {
      stopBadge();
      stopAck();
      capture.stop();
      launcher.unmount();
      setBadge(0);
      setActive(undefined);
    },
  };
  setActive({ mounted, capture });
  return mounted;
}
