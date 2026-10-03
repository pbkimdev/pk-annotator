// The overlay build injects this class for every free `PerformanceObserver` reference
// (tsdown.config.ts), so the observers web-vitals creates, including the ones it creates
// late from callbacks, can be paused when the Perf panel closes. web-vitals has no stop
// API, and starting it again would add listeners it never removes, so Perf starts it once
// and pauses and resumes its observers.
//
// Capture's request-timing observer is built from this class too and must outlive the
// panel. Capture observes only "resource" entries, so Perf owns every observer of another
// entry type, plus the resource observer web-vitals creates as its module evaluates,
// which the collector claims.

const NativePerformanceObserver = globalThis.PerformanceObserver;
const live = new Set<TrackedPerformanceObserver>();
const paused = new Set<TrackedPerformanceObserver>();
const perfOwned = new WeakSet<PerformanceObserver>();
const observed = new WeakMap<PerformanceObserver, PerformanceObserverInit[]>();
// Observers created since the last microtask checkpoint; module evaluation has none.
let recent: TrackedPerformanceObserver[] = [];

function entryList(entries: PerformanceEntryList): PerformanceObserverEntryList {
  return {
    getEntries: () => entries,
    getEntriesByType: (type) => entries.filter((entry) => entry.entryType === type),
    getEntriesByName: (name, type) =>
      entries.filter(
        (entry) => entry.name === name && (type === undefined || entry.entryType === type),
      ),
  };
}

export class TrackedPerformanceObserver extends NativePerformanceObserver {
  // A resumed observer asks for buffered entries again, and the browser returns the same
  // entry objects, so a Perf observer skips the ones it already delivered: web-vitals
  // counts each layout shift and interaction once.
  readonly #delivered: WeakSet<PerformanceEntry>;

  constructor(callback: PerformanceObserverCallback) {
    const delivered = new WeakSet<PerformanceEntry>();
    super((list, observer) => {
      if (!perfOwned.has(observer)) {
        callback(list, observer);
        return;
      }
      const entries = list.getEntries().filter((entry) => !delivered.has(entry));
      for (const entry of entries) delivered.add(entry);
      if (entries.length > 0) callback(entryList(entries), observer);
    });
    this.#delivered = delivered;
    if (recent.length === 0) {
      queueMicrotask(() => {
        recent = [];
      });
    }
    recent.push(this);
  }

  override observe(options: PerformanceObserverInit = {}): void {
    const types = options.entryTypes ?? (options.type === undefined ? [] : [options.type]);
    if (types.some((type) => type !== "resource")) perfOwned.add(this);
    observed.set(this, [...(observed.get(this) ?? []), options]);
    live.add(this);
    super.observe(options);
  }

  override takeRecords(): PerformanceEntryList {
    const entries = super.takeRecords();
    if (!perfOwned.has(this)) return entries;
    const fresh = entries.filter((entry) => !this.#delivered.has(entry));
    for (const entry of fresh) this.#delivered.add(entry);
    return fresh;
  }

  override disconnect(): void {
    live.delete(this);
    paused.delete(this);
    super.disconnect();
  }
}

/** Marks the observers created in this synchronous run, such as during module evaluation, as Perf's. */
export function claimRecent(): void {
  for (const observer of recent) perfOwned.add(observer);
}

/** Disconnects every Perf observer, remembering what each observed. */
export function pausePerf(): void {
  for (const observer of live) {
    if (!perfOwned.has(observer)) continue;
    NativePerformanceObserver.prototype.disconnect.call(observer);
    live.delete(observer);
    paused.add(observer);
  }
}

/** Observes again what each paused observer observed; buffered entries cover the pause. */
export function resumePerf(): void {
  for (const observer of paused) {
    for (const options of observed.get(observer) ?? []) {
      NativePerformanceObserver.prototype.observe.call(observer, options);
    }
    live.add(observer);
  }
  paused.clear();
}
