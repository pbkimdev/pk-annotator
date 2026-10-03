import { GaugeIcon } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";

import { registerPanel } from "../registry.ts";
import { Spinner } from "../ui/spinner.tsx";

type Panel = typeof import("./perf-panel.tsx");

// web-vitals lives in the panel's own chunk, loaded when the panel first opens. The panel
// may close before the chunk arrives, so this module, not the lazy body, starts and stops
// the observers: web-vitals starts one as the chunk evaluates.
let shown = false;
let panel: Panel | undefined;
let loaded: Promise<Panel> | undefined;
const load = () =>
  import("./perf-panel.tsx").then((module) => {
    panel = module;
    if (shown) module.open();
    else module.close();
    return module;
  });
const Body = lazy(() => (loaded ??= load()));

function PerfPanel() {
  useEffect(() => {
    shown = true;
    panel?.open();
    return () => {
      shown = false;
      panel?.close();
    };
  }, []);
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
      (module) => module.stopAll(),
      () => undefined,
    );
  };
}
