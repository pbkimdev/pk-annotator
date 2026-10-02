import {
  BanIcon,
  CircleCheckIcon,
  CircleXIcon,
  CrosshairIcon,
  SendIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { formatArgs } from "../../core/serialize.ts";
import type { ErrorGroup, ErrorGroupStatus } from "../../shared/schema.ts";
import type { ConsoleEntry } from "../../shared/timeline.ts";
import { getCapture } from "../capture.ts";
import { COMPOSE, useOverlay } from "../context.tsx";
import { cn } from "../lib/utils.ts";
import type { PanelProps } from "../registry.ts";
import { Button } from "../ui/button.tsx";
import { clockTime } from "./format.ts";
import { hunt } from "./hunt.ts";

const STATUS_ORDER = { open: 0, sent: 1, cleared: 2 } satisfies Record<ErrorGroupStatus, number>;
const LONG_TEXT = 160;

const STATUS_ICON = {
  open: <CircleXIcon className="size-3.5 text-destructive" />,
  sent: <SendIcon className="size-3.5 text-muted-foreground" />,
  cleared: <CircleCheckIcon className="size-3.5 text-muted-foreground" />,
} satisfies Record<ErrorGroupStatus, ReactNode>;

const LEVEL_STYLE = {
  error: "bg-destructive/5 text-destructive",
  warn: "bg-amber-500/5 text-amber-700 dark:text-amber-400",
  info: "",
  log: "",
  debug: "text-muted-foreground",
} satisfies Record<ConsoleEntry["level"], string>;

function Heading({ children, count }: { children: ReactNode; count: number }) {
  return (
    <h3 className="flex h-7 items-center gap-1.5 border-b px-3 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
      <span className="tabular-nums">{count}</span>
    </h3>
  );
}

function GroupRow({ group, onHunt }: { group: ErrorGroup; onHunt(): void }) {
  return (
    <li
      data-testid="pka-error-group"
      data-status={group.status}
      className={cn(
        "grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-start gap-x-2 px-3 py-2",
        group.status === "cleared" && "opacity-60",
      )}
    >
      <span className="mt-0.5" aria-hidden="true">
        {STATUS_ICON[group.status]}
      </span>
      <div className="min-w-0">
        <p className="line-clamp-2 text-xs break-words">
          <span className="font-medium">{group.type}</span>
          <span className="text-muted-foreground">: </span>
          {group.message}
        </p>
        <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <span className={cn(group.status === "open" && "text-destructive")}>{group.status}</span>
          {group.topFrame !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="pka-top-frame" className="truncate" title={group.topFrame}>
                {group.topFrame}
              </span>
            </>
          )}
        </p>
      </div>
      <span className="mt-px rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4 tabular-nums">
        {group.count}×
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="-mt-0.5"
        aria-label={`Hunt ${group.type}: ${group.message}`}
        title="Hunt: attach to a new annotation"
        onClick={onHunt}
      >
        <CrosshairIcon />
      </Button>
    </li>
  );
}

function ConsoleRow({ entry }: { entry: ConsoleEntry }) {
  const [expanded, setExpanded] = useState(false);
  const text = formatArgs(entry.args);
  const long = text.length > LONG_TEXT || text.includes("\n");
  const body = (
    <span
      className={cn(
        "block font-mono text-[11px] leading-4 whitespace-pre-wrap wrap-anywhere",
        long && !expanded && "line-clamp-2",
      )}
    >
      {text}
    </span>
  );
  return (
    <li
      data-testid="pka-console-entry"
      data-level={entry.level}
      className={cn(
        "grid grid-cols-[0.75rem_3.25rem_minmax(0,1fr)] items-start gap-x-1.5 border-b border-border/50 px-3 py-1",
        LEVEL_STYLE[entry.level],
      )}
    >
      <span className="flex h-4 items-center">
        {entry.level === "warn" && <TriangleAlertIcon aria-label="Warning" className="size-3" />}
        {entry.level === "error" && <CircleXIcon aria-label="Error" className="size-3" />}
      </span>
      <time
        dateTime={entry.at}
        className="font-mono text-[10px] leading-4 text-muted-foreground tabular-nums"
      >
        {clockTime(entry.at)}
      </time>
      {long ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}

export function ConsolePanel(_props: PanelProps) {
  const { hot, ui } = useOverlay();
  const capture = getCapture();
  const snapshot = useSyncExternalStore(capture.subscribe, capture.snapshot);
  const groups = snapshot.groups.toSorted(
    (left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || right.lastSeq - left.lastSeq,
  );
  const open = groups.filter((group) => group.status === "open");
  const entries = snapshot.console.toReversed();

  const huntAndCompose = (fingerprints: readonly string[]) => {
    hunt(hot, fingerprints);
    ui.set({ panel: COMPOSE });
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex h-9 items-center gap-1 border-b bg-popover px-2">
        <Button
          variant="ghost"
          size="xs"
          disabled={open.length === 0}
          onClick={() => huntAndCompose(open.map((group) => group.fingerprint))}
        >
          <CrosshairIcon />
          Hunt all
          <span className="tabular-nums opacity-70">{open.length}</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label="Clear console and errors"
          title="Clear console and errors"
          onClick={() => {
            capture.clear("errors");
            capture.clear("console");
          }}
        >
          <BanIcon />
        </Button>
      </div>
      <section aria-label="Error groups">
        <Heading count={groups.length}>Errors</Heading>
        {groups.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">No errors</p>
        ) : (
          <ul className="divide-y divide-border/50 border-b">
            {groups.map((group) => (
              <GroupRow
                key={group.fingerprint}
                group={group}
                onHunt={() => huntAndCompose([group.fingerprint])}
              />
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Console">
        <Heading count={entries.length}>Console</Heading>
        {entries.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">No console output</p>
        ) : (
          <ul>
            {entries.map((entry) => (
              <ConsoleRow key={entry.seq} entry={entry} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
