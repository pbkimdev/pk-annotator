import { GaugeIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { claimObservers } from "../perf/observer.ts";
import { registerPanel } from "../registry.ts";
import { Spinner } from "../ui/spinner.tsx";

// web-vitals lives in the panel's own chunk, loaded when the panel first opens.
const load = () => claimObservers(() => import("./perf-panel.tsx"));
let loaded: ReturnType<typeof load> | undefined;
const Body = lazy(() => (loaded ??= load()));

function PerfPanel() {
  return (
    <Suspense
      fallback={
        <div className="grid h-24 place-items-center">
          <Spinner />
        </div>
      }
    >
      <Body />
    </Suspense>
  );
}

/** Adds the Perf menu item; the returned function removes it and stops every perf observer. */
export function registerPerfPanel(): () => void {
  const remove = registerPanel({
    id: "perf",
    label: "Performance (dev build)",
    icon: GaugeIcon,
    component: PerfPanel,
  });
  return () => {
    remove();
    // A chunk that failed to load already surfaced through lazy() and started nothing.
    void loaded?.then(
      (panel) => panel.stopAll(),
      () => undefined,
    );
  };
}
