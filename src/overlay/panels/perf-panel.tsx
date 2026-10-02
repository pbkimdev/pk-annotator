import { CheckIcon, CopyIcon, PaperclipIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { getCapture } from "../capture.ts";
import { cn } from "../lib/utils.ts";
import { shortPath } from "../pick-layer.tsx";
import {
  perf,
  startObservers,
  startScan,
  stopAll as stopCollector,
  stopScan,
  type Target,
} from "../perf/collector.ts";
import { frameCause, slowRequests, type Cause, type HotSpot } from "../perf/join.ts";
import {
  clearSources,
  collected,
  hotSpotSource,
  LAB_COMMAND,
  SUSPECT,
  takeSnapshot,
} from "../perf/snapshot.ts";
import { addAttachment } from "../registry.ts";
import { useStore } from "../store.ts";
import { Button } from "../ui/button.tsx";

const SHOWN = 5;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function duration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

function sameOrigin(url: string): string {
  return url.startsWith(`${location.origin}/`) ? url.slice(location.origin.length) : url;
}

function Value({ suspect, children }: { suspect: boolean; children: ReactNode }) {
  return (
    <span
      data-suspect={suspect || undefined}
      className={cn(
        "font-mono whitespace-nowrap tabular-nums",
        suspect && "font-semibold text-amber-700 dark:text-amber-400",
      )}
    >
      {children}
    </span>
  );
}

function Source({ source }: { source: string | undefined }) {
  if (source === undefined) return null;
  return (
    <span className="font-mono text-[11px] text-muted-foreground" title={source}>
      {shortPath(source)}
    </span>
  );
}

function TargetLine({ target, empty }: { target: Target | undefined; empty: string }) {
  if (target === undefined) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs">
      <span className="truncate font-mono" title={target.selector}>
        {target.selector}
      </span>
      <Source source={target.source} />
    </p>
  );
}

function Parts({ parts }: { parts: [string, number][] }) {
  return (
    <p className="text-xs text-muted-foreground">
      {parts.map(([name, value], index) => (
        <span key={name}>
          {index > 0 && " · "}
          {name} <span className="font-mono text-foreground tabular-nums">{value}</span>
        </span>
      ))}
    </p>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5 px-3 py-2.5">
      <h3 className="flex items-center justify-between text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

function Vitals() {
  const lcp = useStore(perf, (state) => state.lcp);
  const inp = useStore(perf, (state) => state.inp);
  const cls = useStore(perf, (state) => state.cls);
  return (
    <Section title="Web vitals">
      <div className="space-y-2" data-testid="pka-perf-vitals">
        <div data-testid="pka-perf-lcp">
          <p className="text-sm">
            LCP{" "}
            {lcp === undefined ? (
              <span className="text-muted-foreground">waiting</span>
            ) : (
              <Value suspect={lcp.value > SUSPECT.lcpMs}>{duration(lcp.value)}</Value>
            )}
          </p>
          {lcp !== undefined && (
            <>
              <TargetLine target={lcp.target} empty="No element" />
              <Parts
                parts={[
                  ["TTFB", lcp.timeToFirstByte],
                  ["load delay", lcp.resourceLoadDelay],
                  ["load", lcp.resourceLoadDuration],
                  ["render delay", lcp.elementRenderDelay],
                ]}
              />
            </>
          )}
        </div>
        <div data-testid="pka-perf-inp">
          <p className="text-sm">
            INP{" "}
            {inp === undefined ? (
              <span className="text-muted-foreground">no interaction yet</span>
            ) : (
              <Value suspect={inp.value > SUSPECT.inpMs}>{duration(inp.value)}</Value>
            )}
          </p>
          {inp !== undefined && (
            <>
              <TargetLine target={inp.target} empty="No element" />
              <Parts
                parts={[
                  ["input delay", inp.inputDelay],
                  ["processing", inp.processingDuration],
                  ["presentation", inp.presentationDelay],
                ]}
              />
            </>
          )}
        </div>
        <div data-testid="pka-perf-cls">
          <p className="text-sm">
            CLS{" "}
            {cls === undefined ? (
              <span className="text-muted-foreground">waiting</span>
            ) : (
              <Value suspect={cls.value > SUSPECT.cls}>{cls.value}</Value>
            )}
          </p>
          {cls !== undefined && cls.value > 0 && (
            <TargetLine target={cls.target} empty="No culprit" />
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          INP and CLS show current values; web-vitals reports final values when the page is hidden.
        </p>
      </div>
    </Section>
  );
}

function CauseLine({ cause, relation }: { cause: Cause | undefined; relation: "in" | "after" }) {
  if (cause === undefined) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs">
      <span className="text-muted-foreground">{relation}</span>
      <span className="font-mono">{cause.handler}</span>
      <span className="truncate font-mono" title={cause.target}>
        {cause.target}
      </span>
      <Source source={cause.source} />
      <span className="text-muted-foreground" title={`Capture action seq ${cause.seq}`}>
        #{cause.seq}
      </span>
    </p>
  );
}

function Frames() {
  const frames = useStore(perf, (state) => state.frames);
  const groups = useStore(perf, (state) => state.groups);
  const supported = useStore(perf, (state) => state.loafSupported);
  const { actions } = useSyncExternalStore(getCapture().subscribe, getCapture().snapshot);
  if (!supported) {
    return (
      <Section title="Long animation frames">
        <p className="text-xs text-muted-foreground">Not supported in this browser.</p>
      </Section>
    );
  }
  return (
    <Section title="Long animation frames">
      {frames.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      <ol className="space-y-1.5" data-testid="pka-perf-frames">
        {frames.slice(0, SHOWN).map((frame) => {
          const script = frame.scripts[0];
          return (
            <li key={frame.start} className="space-y-0.5">
              <p className="flex items-baseline gap-1.5 text-xs">
                <Value suspect={frame.blockingMs >= SUSPECT.frameBlockingMs}>
                  {duration(frame.blockingMs)}
                </Value>
                <span className="text-muted-foreground">
                  blocking of {duration(frame.durationMs)}
                </span>
                {frame.forcedLayoutMs > 0 && (
                  <span className="rounded bg-amber-500/15 px-1 text-[11px] text-amber-700 dark:text-amber-400">
                    forced layout {frame.forcedLayoutMs} ms
                  </span>
                )}
              </p>
              <CauseLine
                cause={frameCause(frame.start, frame.durationMs, actions, performance.timeOrigin)}
                relation="in"
              />
              {script !== undefined && (
                <p
                  className="truncate font-mono text-[11px] text-muted-foreground"
                  title={script.source}
                >
                  {script.functionName || script.invoker} · {script.source.split("/").at(-1)}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {groups.length > 0 && (
        <div className="space-y-0.5 pt-1 text-xs" data-testid="pka-perf-groups">
          <h4 className="text-[11px] text-muted-foreground">By script and function</h4>
          <ul>
            {groups.slice(0, SHOWN).map((group) => (
              <li
                key={`${group.source}|${group.functionName}|${group.invoker}`}
                className="flex items-baseline gap-2 py-0.5"
              >
                <span
                  className="min-w-0 flex-1 truncate font-mono"
                  title={`${group.invoker} ${group.source}`}
                >
                  {group.functionName || group.invoker}{" "}
                  <span className="text-muted-foreground">{group.source.split("/").at(-1)}</span>
                </span>
                <span className="shrink-0 font-mono whitespace-nowrap tabular-nums">
                  {group.frames}× {duration(group.durationMs)}
                  {group.forcedLayoutMs > 0 && (
                    <span
                      className="ml-1 text-amber-700 dark:text-amber-400"
                      title="Forced style and layout"
                    >
                      +{group.forcedLayoutMs} layout
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function Requests() {
  const { requests, actions } = useSyncExternalStore(getCapture().subscribe, getCapture().snapshot);
  const slow = slowRequests(requests, actions);
  return (
    <Section title="Requests by duration">
      {slow.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      <ol className="space-y-1.5" data-testid="pka-perf-requests">
        {slow.slice(0, SHOWN).map((request) => (
          <li key={request.seq} className="space-y-0.5">
            <p className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <Value suspect={request.durationMs >= SUSPECT.requestMs}>
                {duration(request.durationMs)}
              </Value>
              <span className="min-w-0 truncate font-mono" title={request.url}>
                {request.method} {sameOrigin(request.url)}
              </span>
              {request.status !== undefined && (
                <span className="ml-auto shrink-0 font-mono text-muted-foreground tabular-nums">
                  {request.status}
                </span>
              )}
            </p>
            {request.serverTiming.length > 0 && (
              <Parts
                parts={request.serverTiming.map((entry) => [
                  entry.name,
                  Math.round(entry.duration),
                ])}
              />
            )}
            <CauseLine cause={request.cause} relation="after" />
          </li>
        ))}
      </ol>
    </Section>
  );
}

function HotSpotSource({ spot }: { spot: HotSpot }) {
  const [source, setSource] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    hotSpotSource(spot).then(
      (resolved) => {
        if (current) setSource(resolved);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [spot]);
  if (failed) return <span className="text-[11px] text-muted-foreground">source map failed</span>;
  return <Source source={source} />;
}

function Renders() {
  const hotSpots = useStore(perf, (state) => state.hotSpots);
  const scanning = useStore(perf, (state) => state.scanning);
  return (
    <Section
      title="Re-renders while open"
      aside={!scanning && <span className="font-normal">React hook unavailable</span>}
    >
      {hotSpots.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      <ol className="space-y-1.5" data-testid="pka-perf-renders">
        {hotSpots.slice(0, SHOWN).map((spot) => (
          <li
            key={`${spot.name}@${spot.site.fileName}:${spot.site.lineNumber}`}
            className="space-y-0.5"
          >
            <p className="flex items-baseline gap-1.5 text-xs">
              <span className="font-mono">{spot.name}</span>
              <span className="font-mono tabular-nums">{spot.renders}×</span>
              <HotSpotSource spot={spot} />
            </p>
            <p className="text-xs text-muted-foreground">
              {[
                spot.props.length > 0 ? `props ${spot.props.join(", ")}` : undefined,
                spot.stateChanges > 0 ? `state ${spot.stateChanges}×` : undefined,
                spot.hookChanges > 0 ? `hooks ${spot.hookChanges}×` : undefined,
                spot.contextChanges > 0 ? `context ${spot.contextChanges}×` : undefined,
                spot.cascades > 0 ? `parent ${spot.cascades}×` : undefined,
              ]
                .filter((part) => part !== undefined)
                .join(" · ")}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Footer() {
  const [attached, setAttached] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  const attach = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const files = collected(await takeSnapshot());
      const time = timeFormat.format(new Date());
      addAttachment({
        id: "perf",
        kind: "perf",
        label: `Perf ${time}`,
        collect: async () => files,
      });
      setAttached(time);
    } catch (cause) {
      setError(`Snapshot failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(LAB_COMMAND);
      setCopied(true);
    } catch (cause) {
      setError(`Copy failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  return (
    <footer className="sticky bottom-0 space-y-2 border-t bg-popover px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void attach()} disabled={busy}>
          <PaperclipIcon />
          Attach snapshot
        </Button>
        {attached !== undefined && (
          <span className="text-xs text-muted-foreground" role="status">
            Attached {attached}
          </span>
        )}
      </div>
      {error !== undefined && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center gap-1">
        <code
          className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 font-mono text-[11px]"
          title={LAB_COMMAND}
        >
          {LAB_COMMAND}
        </code>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Copy lab command"
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </footer>
  );
}

/** Stops every perf observer and drops collected data; called when the overlay unmounts. */
export function stopAll(): void {
  stopCollector();
  clearSources();
}

export default function PerfPanel() {
  useEffect(() => {
    startObservers();
    startScan();
    return stopScan;
  }, []);
  return (
    <div data-testid="pka-perf" className="divide-y">
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Highlights are suspects; pass/fail comes from a lab run.
      </p>
      <Vitals />
      <Frames />
      <Requests />
      <Renders />
      <Footer />
    </div>
  );
}
