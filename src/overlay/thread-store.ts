import type { ViteHotContext } from "vite/types/hot.d.ts";
import { z } from "zod";

import { CHANNEL, StateMessage, SyncedMessage, ThreadMessage } from "../shared/channel.ts";
import { Id, Timestamp, type State, type ThreadEntry } from "../shared/schema.ts";
import { listen, send } from "./channel-client.ts";
import { agentReacted, setAgentWorking } from "./hub-state.ts";
import { createStore, type Store } from "./store.ts";

const SENT_KEY = "pka:sent";

const SentRecord = z.strictObject({
  id: Id,
  prompt: z.string(),
  createdAt: Timestamp,
  elements: z.number().int().nonnegative(),
});
export type SentRecord = z.infer<typeof SentRecord>;

export type ThreadState = {
  /** Annotations sent from this tab, newest first. */
  sent: readonly SentRecord[];
  states: ReadonlyMap<string, State>;
  entries: ReadonlyMap<string, readonly ThreadEntry[]>;
  unread: boolean;
};

export type ThreadStore = Store<ThreadState> & {
  added(record: SentRecord): void;
  disconnect(): void;
};

function readSent(): SentRecord[] {
  const raw = sessionStorage.getItem(SENT_KEY);
  if (raw === null) return [];
  const parsed = z.array(SentRecord).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    sessionStorage.removeItem(SENT_KEY);
    throw new Error(`Discarded unreadable ${SENT_KEY} in sessionStorage: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Tracks annotations sent from this tab and follows their status and replies over HMR. */
export function connectThread(hot: ViteHotContext): ThreadStore {
  const store = createStore<ThreadState>({
    sent: readSent(),
    states: new Map(),
    entries: new Map(),
    unread: false,
  });
  const isOurs = (id: string) => store.get().sent.some((record) => record.id === id);

  const stops = [
    listen(hot, CHANNEL.state, StateMessage, (message) => {
      if (!isOurs(message.id)) return;
      const before = store.get().states.get(message.id)?.status;
      store.set({ states: new Map(store.get().states).set(message.id, message.state) });
      const closed = message.state.status === "resolved" || message.state.status === "dismissed";
      if (closed && before !== message.state.status) agentReacted();
    }),
    listen(hot, CHANNEL.thread, ThreadMessage, ({ id, entry }) => {
      if (!isOurs(id)) return;
      const { entries, unread } = store.get();
      store.set({
        entries: new Map(entries).set(id, [...(entries.get(id) ?? []), entry]),
        unread: unread || entry.from === "agent",
      });
      if (entry.from === "agent") agentReacted();
    }),
    listen(hot, CHANNEL.synced, SyncedMessage, (message) => {
      const states = new Map(store.get().states);
      const entries = new Map(store.get().entries);
      for (const annotation of message.annotations) {
        states.set(annotation.id, annotation.state);
        entries.set(annotation.id, annotation.thread);
      }
      // Annotations removed from the store (pka prune) leave the tab's list.
      const known = new Set(message.annotations.map((annotation) => annotation.id));
      const sent = store.get().sent.filter((record) => known.has(record.id));
      sessionStorage.setItem(SENT_KEY, JSON.stringify(sent));
      store.set({ sent, states, entries });
    }),
  ];
  // The hub shows an agent at work while one of this tab's annotations is claimed and open.
  const stopWorking = store.subscribe(() => {
    const { sent, states } = store.get();
    setAgentWorking(sent.some((record) => states.get(record.id)?.status === "acknowledged"));
  });
  const ids = store.get().sent.map((record) => record.id);
  if (ids.length > 0) send(hot, CHANNEL.sync, { ids });

  return {
    ...store,
    added(record) {
      const sent = [record, ...store.get().sent.filter((existing) => existing.id !== record.id)];
      sessionStorage.setItem(SENT_KEY, JSON.stringify(sent));
      store.set({
        sent,
        states: new Map(store.get().states).set(record.id, {
          status: "pending",
          history: [{ status: "pending", at: record.createdAt }],
        }),
      });
    },
    disconnect() {
      for (const stop of stops) stop();
      stopWorking();
      setAgentWorking(false);
    },
  };
}
