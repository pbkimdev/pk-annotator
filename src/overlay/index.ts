import { captureOwnerStack } from "react";
import type { HydrationOptions } from "react-dom/client";
import type { ViteHotContext } from "vite/types/hot.d.ts";

import { createCapture, type Capture } from "../core/index.ts";
import type { CHANNEL } from "../shared/channel.ts";
import { setAgentConnected } from "./agent-presence.ts";
import { getActive, setActive } from "./capture.ts";
import { send } from "./channel-client.ts";
import { createLauncher, type Launcher, type ThemeSetting } from "./launcher.ts";
import { setBadge } from "./registry.ts";

const ERRORS_ACK: typeof CHANNEL.errorsAck = "pka:errors-ack";
const AGENT: typeof CHANNEL.agent = "pka:agent";
/** Set by Exit; until Alt+Shift+A clears it, the overlay stays unmounted in this tab. */
const EXITED_KEY = "pka:exited";
type AckListener = Parameters<ViteHotContext["on"]>[1];

declare global {
  // Defined by the Vite plugin from its `bodies` option.
  var __PKA_BODIES__: string[] | undefined;
}

export type MountOptions = { hot: ViteHotContext; theme?: ThemeSetting };

export type Mounted = {
  reactRootOptions: Pick<
    HydrationOptions,
    "onCaughtError" | "onUncaughtError" | "onRecoverableError"
  >;
  /** Switches the launcher and the open UI to a theme; "system" follows prefers-color-scheme. */
  setTheme(theme: ThemeSetting): void;
  unmount(): void;
};

function isShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === "KeyA" && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey
  );
}

/**
 * Starts capture and mounts the launcher in its own shadow root. The UI chunk and its
 * stylesheet load on first open. Under automation (navigator.webdriver) nothing mounts.
 * After Exit, nothing but one keydown listener runs in this tab until Alt+Shift+A.
 */
export function mount(options: MountOptions): Mounted {
  if (navigator.webdriver) return { reactRootOptions: {}, setTheme() {}, unmount() {} };
  const active = getActive();
  if (active !== undefined) return active.mounted;

  let theme = options.theme ?? "system";
  let live: { capture: Capture; launcher: Launcher; stop(): void } | undefined;

  const start = () => {
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
    // The plugin sends pka:agent only while a session is or was connected, so a page that
    // never had one loads no schema for it.
    const receiveAgent: AckListener = (payload) => {
      void import("../shared/channel.ts").then(({ AgentMessage }) => {
        const parsed = AgentMessage.safeParse(payload);
        if (parsed.success) setAgentConnected(parsed.data.agent !== null);
        else console.error(`[pk-annotator] dropped an invalid ${AGENT} message`, parsed.error);
      });
    };
    options.hot.on(AGENT, receiveAgent);
    let open = 0;
    const stopBadge = capture.subscribe(() => {
      const count = capture.snapshot().groups.filter((group) => group.status === "open").length;
      if (count === open) return;
      open = count;
      setBadge(count);
    });
    const launcher = createLauncher(options.hot, theme, exit);
    live = {
      capture,
      launcher,
      stop() {
        stopBadge();
        options.hot.off(ERRORS_ACK, receiveAck);
        options.hot.off(AGENT, receiveAgent);
        setAgentConnected(false);
        capture.stop();
        launcher.unmount();
        setBadge(0);
      },
    };
    setActive({ mounted, capture });
  };

  const onShortcut = (event: KeyboardEvent) => {
    if (!isShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    window.removeEventListener("keydown", onShortcut, { capture: true });
    sessionStorage.removeItem(EXITED_KEY);
    start();
  };
  const sleep = () => {
    window.addEventListener("keydown", onShortcut, { capture: true });
    setActive({ mounted, capture: undefined });
  };
  function exit() {
    live?.stop();
    live = undefined;
    sessionStorage.setItem(EXITED_KEY, "1");
    sleep();
  }

  // The consumer passes these to its React root once, so they forward to whichever
  // capture is running; while exited, React's errors are only logged, as React would.
  const reactRootOptions: Mounted["reactRootOptions"] = {
    onCaughtError(error, info) {
      const handler = live?.capture.reactRootOptions.onCaughtError;
      if (handler === undefined)
        console.error("React caught an error:", error, info.componentStack ?? "");
      else handler(error, info);
    },
    onUncaughtError(error, info) {
      const handler = live?.capture.reactRootOptions.onUncaughtError;
      if (handler === undefined)
        console.error("Uncaught error in React:", error, info.componentStack ?? "");
      else handler(error, info);
    },
    onRecoverableError(error, info) {
      const handler = live?.capture.reactRootOptions.onRecoverableError;
      if (handler === undefined) {
        console.error("React recovered from an error:", error, info.componentStack ?? "");
      } else handler(error, info);
    },
  };

  const mounted: Mounted = {
    reactRootOptions,
    setTheme(next) {
      if (next !== "light" && next !== "dark" && next !== "system") {
        throw new Error(`setTheme expects "light", "dark", or "system", got ${String(next)}`);
      }
      theme = next;
      live?.launcher.setTheme(next);
    },
    unmount() {
      live?.stop();
      live = undefined;
      window.removeEventListener("keydown", onShortcut, { capture: true });
      setActive(undefined);
    },
  };
  if (sessionStorage.getItem(EXITED_KEY) === "1") sleep();
  else start();
  return mounted;
}
