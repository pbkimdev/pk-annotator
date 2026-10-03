// The overlay build injects this class for every free `PerformanceObserver` reference
// (tsdown.config.ts), so the observers web-vitals creates, including the ones it creates
// late from callbacks, can be disconnected when the Perf panel closes. web-vitals has no
// stop API of its own.
//
// Capture's request-timing observer is built from this class too and must outlive the
// panel. Capture observes only "resource" entries, so Perf owns every observer of another
// entry type, plus the ones created while its chunk loads: web-vitals observes resource
// timing once, when its attribution module evaluates, so that one is resumed rather than
// recreated when the panel opens again.

const NativePerformanceObserver = globalThis.PerformanceObserver;
const live = new Set<TrackedPerformanceObserver>();
const perfOwned = new WeakSet<PerformanceObserver>();
const imported = new Map<TrackedPerformanceObserver, PerformanceObserverInit[]>();
let claiming = 0;

export class TrackedPerformanceObserver extends NativePerformanceObserver {
  constructor(callback: PerformanceObserverCallback) {
    super(callback);
    if (claiming > 0) {
      perfOwned.add(this);
      imported.set(this, []);
    }
  }

  override observe(options: PerformanceObserverInit = {}): void {
    const types = options.entryTypes ?? (options.type === undefined ? [] : [options.type]);
    if (types.some((type) => type !== "resource")) perfOwned.add(this);
    imported.get(this)?.push(options);
    live.add(this);
    super.observe(options);
  }

  override disconnect(): void {
    live.delete(this);
    super.disconnect();
  }
}

/** Loads the Perf chunk; observers its modules create while evaluating belong to Perf. */
export async function claimObservers<T>(load: () => Promise<T>): Promise<T> {
  claiming += 1;
  try {
    return await load();
  } finally {
    claiming -= 1;
  }
}

/**
 * Observes again what the Perf chunk's own observers observed before the panel closed.
 * Entries from while it was closed are not replayed: web-vitals already falls back to the
 * page's own resource timing buffer.
 */
export function resumeImported(): void {
  for (const [observer, calls] of imported) {
    if (live.has(observer)) continue;
    live.add(observer);
    for (const options of calls) {
      NativePerformanceObserver.prototype.observe.call(observer, { ...options, buffered: false });
    }
  }
}

export function disconnectPerf(): void {
  for (const observer of live) {
    if (perfOwned.has(observer)) observer.disconnect();
  }
}
