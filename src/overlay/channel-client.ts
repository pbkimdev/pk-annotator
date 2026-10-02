import type { ViteHotContext } from "vite/types/hot.d.ts";
import type { z } from "zod";

import type { ChannelEvents } from "../shared/channel.ts";

// Vite types custom event payloads as `any`; each listener parses them.
type Receive = Parameters<ViteHotContext["on"]>[1];

/**
 * Listens for one plugin event, parses every payload with its schema, and drops (and
 * reports) messages that do not match. Returns a function that stops listening.
 */
export function listen<E extends keyof ChannelEvents>(
  hot: ViteHotContext,
  event: E,
  schema: z.ZodType<ChannelEvents[E]>,
  handler: (message: ChannelEvents[E]) => void,
): () => void {
  const receive: Receive = (payload) => {
    const parsed = schema.safeParse(payload);
    if (parsed.success) handler(parsed.data);
    else console.error(`[pk-annotator] dropped an invalid ${event} message`, parsed.error);
  };
  hot.on(event, receive);
  return () => hot.off(event, receive);
}

/** Sends one overlay event; the payload type follows the channel contract. */
export function send<E extends keyof ChannelEvents>(
  hot: ViteHotContext,
  event: E,
  payload: ChannelEvents[E],
): void {
  hot.send<string>(event, payload);
}
