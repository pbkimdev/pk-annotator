// The package update the plugin offers, from its pka:update message. Part of the launcher
// chunk, like agent-presence.ts: plain data only, so the hub shows it without the UI.

export type UpdateState = {
  current: string;
  latest: string;
  status: "available" | "installing" | "failed" | "restart-manually";
};

let state: UpdateState | null = null;
const listeners = new Set<() => void>();

export function setUpdate(next: UpdateState | null): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getUpdate(): UpdateState | null {
  return state;
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
