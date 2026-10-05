import type { ViteHotContext } from "vite/types/hot.d.ts";
import { z } from "zod";

import { CHANNEL, StateMessage, SyncedMessage, ThreadMessage } from "../shared/channel.ts";
import { Id, Timestamp, type State, type ThreadEntry } from "../shared/schema.ts";
import { listen, send } from "./channel-client.ts";
import { agentReacted, setAgentWorking } from "./hub-state.ts";
import { SENT_KEY } from "./launcher.ts";
import { createStore, type Store } from "./store.ts";

/** SyncMessage's limit. */
const MAX_SYNC_IDS = 200;

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
  /** Why unreadable History entries in sessionStorage were discarded at load, for History. */
  discarded: string | null;
  persistenceError: string | null;
};

export type ThreadStore = Store<ThreadState> & {
  added(record: SentRecord): void;
  disconnect(): void;
};

function persistSent(sent: readonly SentRecord[]): string | null {
  try {
    sessionStorage.setItem(SENT_KEY, JSON.stringify(sent));
    return null;
  } catch (cause) {
    const message = `History could not be saved in this tab. Annotations are saved on the server; new History entries will be lost on reload. ${cause instanceof Error ? cause.message : String(cause)}`;
    console.error(`[pk-annotator] ${message}`);
    return message;
  }
}

/**
 * Reads this tab's sent annotations. Unreadable entries are dropped from sessionStorage and
 * reported, so one bad entry neither hides the readable ones nor stops the overlay.
 */
function readSent(): Pick<ThreadState, "sent" | "discarded" | "persistenceError"> {
  const raw = sessionStorage.getItem(SENT_KEY);
  if (raw === null) return { sent: [], discarded: null, persistenceError: null };
  const sent: SentRecord[] = [];
  let problem: string | null = null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch (cause) {
    problem = `it is not JSON (${cause instanceof Error ? cause.message : String(cause)})`;
  }
  if (problem === null && !Array.isArray(stored)) problem = "it is not a list";
  if (Array.isArray(stored)) {
    for (const [index, record] of stored.entries()) {
      const parsed = SentRecord.safeParse(record);
      if (parsed.success) sent.push(parsed.data);
      else problem ??= `entry ${index + 1}: ${z.prettifyError(parsed.error)}`;
    }
  }
  if (problem === null) return { sent, discarded: null, persistenceError: null };
  const discarded = `Discarded unreadable History entries in sessionStorage ${SENT_KEY}; ${problem}`;
  console.error(`[pk-annotator] ${discarded}`);
  return { sent, discarded, persistenceError: persistSent(sent) };
}

/** Tracks annotations sent from this tab and follows their status and replies over HMR. */
export function connectThread(hot: ViteHotContext): ThreadStore {
  const store = createStore<ThreadState>({
    ...readSent(),
    states: new Map(),
    entries: new Map(),
    unread: false,
  });
  const isOurs = (id: string) => store.get().sent.some((record) => record.id === id);
  // pka:sync carries at most MAX_SYNC_IDS ids, so the list syncs newest first, one batch at a
  // time: each pka:synced answers the batch sent before it, which says which ids are gone.
  const unsynced = store.get().sent.map((record) => record.id);
  let batch: ReadonlySet<string> = new Set();
  const syncNext = () => {
    batch = new Set(unsynced.splice(0, MAX_SYNC_IDS));
    if (batch.size > 0) send(hot, CHANNEL.sync, { ids: [...batch] });
  };

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
      // Annotations of this batch removed from the store (pka prune) leave the tab's list.
      const known = new Set(message.annotations.map((annotation) => annotation.id));
      const sent = store
        .get()
        .sent.filter((record) => !batch.has(record.id) || known.has(record.id));
      store.set({ sent, states, entries, persistenceError: persistSent(sent) });
      syncNext();
    }),
  ];
  // The hub shows an agent at work while one of this tab's annotations is claimed and open.
  const stopWorking = store.subscribe(() => {
    const { sent, states } = store.get();
    setAgentWorking(sent.some((record) => states.get(record.id)?.status === "acknowledged"));
  });
  syncNext();

  return {
    ...store,
    added(record) {
      const sent = [record, ...store.get().sent.filter((existing) => existing.id !== record.id)];
      store.set({
        sent,
        persistenceError: persistSent(sent),
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
