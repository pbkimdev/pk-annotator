import { useSyncExternalStore } from "react";

export type Store<T> = {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(listener: () => void): () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T, S>(store: Store<T>, select: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

export function useList<T>(list: {
  get(): readonly T[];
  subscribe(listener: () => void): () => void;
}): readonly T[] {
  return useSyncExternalStore(list.subscribe, list.get);
}
