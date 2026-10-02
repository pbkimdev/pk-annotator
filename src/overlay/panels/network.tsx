import { ArrowLeftIcon, BanIcon, PaperclipIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { RequestEntry } from "../../shared/timeline.ts";
import { getCapture } from "../capture.ts";
import { COMPOSE, useOverlay } from "../context.tsx";
import { cn } from "../lib/utils.ts";
import { addAttachment, attachments, SUMMARY_PATH, type PanelProps } from "../registry.ts";
import { Button } from "../ui/button.tsx";
import {
  clockTime,
  formatBytes,
  formatMs,
  isFailed,
  requestLine,
  shortUrl,
  statusText,
} from "./format.ts";

const ATTACHMENT_ID = "network";
const NETWORK_PATH = "capture/network.jsonl";

// Entries as they were when attached, so a later Clear does not drop them from the attachment.
let attached: ReadonlyMap<number, RequestEntry> = new Map();

function attach(requests: readonly RequestEntry[]): void {
  const present = attachments.get().some((attachment) => attachment.id === ATTACHMENT_ID);
  const chosen = new Map(present ? attached : []);
  for (const request of requests) chosen.set(request.seq, request);
  attached = chosen;
  addAttachment({
    id: ATTACHMENT_ID,
    kind: "network",
    label: chosen.size === 1 ? `1 request` : `${chosen.size} requests`,
    async collect() {
      const latest = new Map(
        getCapture()
          .snapshot()
          .requests.map((entry) => [entry.seq, entry]),
      );
      const entries = [...chosen.values()]
        .map((entry) => latest.get(entry.seq) ?? entry)
        .sort((left, right) => left.seq - right.seq);
      const summary = [
        `## Network`,
        "",
        `${NETWORK_PATH} has one request per line: redacted headers, timing, Server-Timing, and bodies where captured.`,
        "",
        ...entries.map((entry) => `- ${requestLine(entry)}`),
        "",
      ].join("\n");
      return {
        path: SUMMARY_PATH,
        summary: entries.map(requestLine).join("; ").slice(0, 300),
        files: [
          {
            path: NETWORK_PATH,
            data: new Blob(entries.map((entry) => `${JSON.stringify(entry)}\n`)),
          },
          { path: SUMMARY_PATH, data: new Blob([summary]) },
        ],
      };
    },
  });
}

function useRequests(): readonly RequestEntry[] {
  const capture = getCapture();
  return useSyncExternalStore(capture.subscribe, capture.snapshot).requests;
}

function StatusCell({ request }: { request: RequestEntry }) {
  return (
    <span
      className={cn(
        "text-right tabular-nums",
        isFailed(request) && "text-destructive",
        (request.state === "pending" || request.state === "open") && "text-muted-foreground",
      )}
    >
      {statusText(request)}
    </span>
  );
}

const ROW =
  "grid grid-cols-[1rem_2.75rem_minmax(0,1fr)_2.25rem_3.25rem_3.5rem] items-center gap-x-1.5";

type ListState = { failedOnly: boolean; selected: ReadonlySet<number>; focus: number | null };

function RequestList({
  state,
  setState,
  open,
}: {
  state: ListState;
  setState(patch: Partial<ListState>): void;
  open(seq: number): void;
}) {
  const { ui } = useOverlay();
  const requests = useRequests();
  const { failedOnly, selected } = state;
  const setSelected = (next: ReadonlySet<number>) => setState({ selected: next });
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (state.focus === null) return;
    list.current?.querySelector<HTMLElement>(`[data-seq="${state.focus}"]`)?.focus();
    setState({ focus: null });
  }, [state.focus, setState]);
  const failed = requests.filter(isFailed).length;
  const shown = (failedOnly ? requests.filter(isFailed) : requests).toReversed();
  const chosen = requests.filter((request) => selected.has(request.seq));

  const toggle = (seq: number) => {
    const next = new Set(selected);
    if (!next.delete(seq)) next.add(seq);
    setSelected(next);
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 border-b bg-popover">
        <div className="flex h-9 items-center gap-1 px-2">
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={failedOnly}
            className="aria-pressed:bg-destructive/10 aria-pressed:text-destructive"
            onClick={() => setState({ failedOnly: !failedOnly })}
          >
            Failed
            <span className="tabular-nums opacity-70">{failed}</span>
          </Button>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {requests.length} {requests.length === 1 ? "request" : "requests"}
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={chosen.length === 0}
            onClick={() => {
              attach(chosen);
              setSelected(new Set());
              ui.set({ panel: COMPOSE });
            }}
          >
            <PaperclipIcon />
            Attach{chosen.length > 0 && ` ${chosen.length}`}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear requests"
            title="Clear requests"
            onClick={() => {
              getCapture().clear("network");
              setSelected(new Set());
            }}
          >
            <BanIcon />
          </Button>
        </div>
        <div
          aria-hidden="true"
          className={cn(
            ROW,
            "h-6 border-t px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase",
          )}
        >
          <span />
          <span>Method</span>
          <span>Path</span>
          <span className="text-right">Status</span>
          <span className="text-right">Time</span>
          <span className="text-right">Size</span>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="m-auto py-8 text-xs text-muted-foreground">
          {failedOnly ? "No failed requests" : "No requests yet"}
        </p>
      ) : (
        <ul ref={list} data-testid="pka-network-list" className="py-0.5">
          {shown.map((request) => (
            <li
              key={request.seq}
              data-testid="pka-request"
              className={cn(ROW, "h-7 px-2 font-mono text-[11px] hover:bg-muted/60")}
            >
              <input
                type="checkbox"
                aria-label={`Select ${request.method} ${shortUrl(request.url)}`}
                checked={selected.has(request.seq)}
                onChange={() => toggle(request.seq)}
                className="size-3.5 accent-primary dark:scheme-dark"
              />
              <button
                type="button"
                data-seq={request.seq}
                onClick={() => open(request.seq)}
                className="col-span-5 grid grid-cols-subgrid items-center rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className="truncate text-muted-foreground">{request.method}</span>
                <span className="truncate" title={request.url}>
                  {shortUrl(request.url)}
                </span>
                <StatusCell request={request} />
                <span className="text-right text-muted-foreground tabular-nums">
                  {request.state === "open" ? "open" : formatMs(request.durationMs)}
                </span>
                <span className="text-right text-muted-foreground tabular-nums">
                  {formatBytes(request.responseSize)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5 border-t px-3 py-2.5 first:border-t-0">
      <h3 className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Pairs({ pairs }: { pairs: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]">
      {pairs.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="wrap-anywhere">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Headers({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">None</p>;
  return <Pairs pairs={entries} />;
}

function Body({ text }: { text: string }) {
  let shown = text;
  try {
    shown = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not JSON: shown as captured.
  }
  return (
    <pre className="max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap wrap-anywhere">
      {shown}
    </pre>
  );
}

function RequestDetail({ seq, back }: { seq: number; back(): void }) {
  const { ui } = useOverlay();
  const request = useRequests().find((entry) => entry.seq === seq);
  if (request === undefined) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-xs text-muted-foreground">
        <p>This request was cleared.</p>
        <Button variant="outline" size="xs" onClick={back}>
          Back to requests
        </Button>
      </div>
    );
  }
  const maxTiming = Math.max(...(request.serverTiming ?? []).map((timing) => timing.duration), 1);
  const pairs: [string, ReactNode][] = [
    ["url", request.url],
    [
      "status",
      <span className={cn(isFailed(request) && "text-destructive")}>
        {[request.status, request.state, request.error].filter(Boolean).join(" · ")}
      </span>,
    ],
    ["via", `${request.initiator}${request.stream ? " · event stream" : ""}`],
    ["started", clockTime(request.at)],
    ["duration", request.state === "open" ? "streaming" : formatMs(request.durationMs) || "…"],
  ];
  if (request.requestSize !== undefined) pairs.push(["sent", formatBytes(request.requestSize)]);
  if (request.responseSize !== undefined) {
    pairs.push(["received", formatBytes(request.responseSize)]);
  }
  if (request.transferSize !== undefined) {
    pairs.push(["transfer", formatBytes(request.transferSize)]);
  }
  if (request.contentType !== undefined) pairs.push(["type", request.contentType]);
  if (request.traceparent !== undefined) pairs.push(["traceparent", request.traceparent]);

  return (
    <div data-testid="pka-request-detail">
      <div className="sticky top-0 flex h-9 items-center gap-1 border-b bg-popover px-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Back to requests"
          autoFocus
          onClick={back}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="truncate font-mono text-[11px]">
          <span className="text-muted-foreground">{request.method}</span> {shortUrl(request.url)}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          onClick={() => {
            attach([request]);
            ui.set({ panel: COMPOSE });
          }}
        >
          <PaperclipIcon />
          Attach
        </Button>
      </div>
      <Section title="Request">
        <Pairs pairs={pairs} />
      </Section>
      {request.serverTiming !== undefined && request.serverTiming.length > 0 && (
        <Section title="Server-Timing">
          <ul className="space-y-1 font-mono text-[11px]">
            {request.serverTiming.map((timing, index) => (
              <li
                key={`${timing.name}-${index}`}
                className="grid grid-cols-[6rem_minmax(0,1fr)_3.5rem] items-center gap-2"
              >
                <span className="truncate" title={timing.description || timing.name}>
                  {timing.name}
                </span>
                <span className="h-1.5 rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-primary/70"
                    style={{ width: `${(timing.duration / maxTiming) * 100}%` }}
                  />
                </span>
                <span className="text-right tabular-nums">{formatMs(timing.duration)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Response headers">
        <Headers headers={request.responseHeaders} />
      </Section>
      <Section title="Request headers">
        <Headers headers={request.requestHeaders} />
      </Section>
      {request.requestBody !== undefined && (
        <Section title="Request body">
          <Body text={request.requestBody} />
        </Section>
      )}
      {request.responseBody !== undefined && (
        <Section title="Response body">
          <Body text={request.responseBody} />
        </Section>
      )}
    </div>
  );
}

export function NetworkPanel(_props: PanelProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [list, setList] = useState<ListState>({
    failedOnly: false,
    selected: new Set(),
    focus: null,
  });
  const setState = useCallback(
    (patch: Partial<ListState>) => setList((current) => ({ ...current, ...patch })),
    [],
  );
  if (open !== null) {
    return (
      <RequestDetail
        seq={open}
        back={() => {
          setState({ focus: open });
          setOpen(null);
        }}
      />
    );
  }
  return <RequestList state={list} setState={setState} open={setOpen} />;
}
