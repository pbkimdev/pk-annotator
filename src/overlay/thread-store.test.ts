// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViteHotContext } from "vite/types/hot.d.ts";

import { SyncMessage, type SyncedMessage } from "../shared/channel.ts";
import { connectThread } from "./thread-store.ts";

const createdAt = "2026-10-03T00:00:00.000Z";
const record = (id: string) => ({ id, prompt: "p", createdAt, elements: 0 });

function fakeHot() {
  const handlers = new Map<string, Parameters<ViteHotContext["on"]>[1]>();
  const sent: SyncMessage[] = [];
  const hot: ViteHotContext = {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
    off() {},
    send(_event, payload) {
      sent.push(SyncMessage.parse(payload));
    },
  };
  const reply = (ids: readonly string[]) => {
    const message: SyncedMessage = {
      annotations: ids.map((id) => ({
        id,
        state: { status: "pending", history: [{ status: "pending", at: createdAt }] },
        thread: [],
      })),
    };
    handlers.get("pka:synced")?.(message);
  };
  return { hot, sent, reply };
}

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("connectThread", () => {
  it("reports unreadable History entries, keeps readable ones, and still connects", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: [string, number][] = [
      ["{not json", 0],
      [JSON.stringify([record("kept-0001"), { ...record("extra-0001"), extra: true }]), 1],
    ];
    for (const [stored, kept] of cases) {
      sessionStorage.setItem("pka:sent", stored);
      const { hot } = fakeHot();
      const store = connectThread(hot);
      expect(store.get().sent).toHaveLength(kept);
      expect(store.get().discarded).toMatch(/Discarded unreadable History entries/);
      expect(JSON.parse(sessionStorage.getItem("pka:sent") ?? "")).toHaveLength(kept);
      store.disconnect();
    }
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("syncs more than 200 ids in batches and drops only missing ids of the answered batch", () => {
    const ids = Array.from({ length: 450 }, (_, index) => `id-${String(index).padStart(6, "0")}`);
    sessionStorage.setItem("pka:sent", JSON.stringify(ids.map(record)));
    const { hot, sent, reply } = fakeHot();
    const store = connectThread(hot);
    for (const size of [200, 200, 50]) {
      const batch = sent.at(-1)?.ids ?? [];
      expect(batch).toHaveLength(size);
      reply(batch.filter((id) => id !== "id-000005"));
    }
    expect(sent).toHaveLength(3);
    expect(store.get().sent).toHaveLength(449);
    expect(store.get().discarded).toBeNull();
    store.disconnect();
  });
});
