// The overlay build injects this class for every free `PerformanceObserver` reference
// (tsdown.config.ts), so the observers web-vitals creates, including the ones it creates
// late from callbacks, can be disconnected when the overlay unmounts. web-vitals has no
// stop API of its own.

const live = new Set<PerformanceObserver>();

export class TrackedPerformanceObserver extends globalThis.PerformanceObserver {
  constructor(callback: PerformanceObserverCallback) {
    super(callback);
    live.add(this);
  }

  override disconnect(): void {
    live.delete(this);
    super.disconnect();
  }
}

export function disconnectAll(): void {
  for (const observer of live) observer.disconnect();
}
