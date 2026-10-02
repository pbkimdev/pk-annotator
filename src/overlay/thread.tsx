import { CornerDownLeftIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import type { Status } from "../shared/schema.ts";
import { useOverlay } from "./context.tsx";
import { cn } from "./lib/utils.ts";
import { useStore } from "./store.ts";
import type { SentRecord } from "./thread-store.ts";
import { Button } from "./ui/button.tsx";

const STATUS_STYLE = {
  pending: "bg-amber-500",
  acknowledged: "bg-sky-500",
  resolved: "bg-emerald-500",
  dismissed: "bg-muted-foreground",
} satisfies Record<Status, string>;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function ThreadItem({ record }: { record: SentRecord }) {
  const { thread } = useOverlay();
  const state = useStore(thread, (current) => current.states.get(record.id));
  const entries = useStore(thread, (current) => current.entries.get(record.id));
  const outgoing = useStore(thread, (current) => current.outgoing.get(record.id));
  const [draft, setDraft] = useState("");
  const status = state?.status ?? "pending";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "") return;
    thread.reply(record.id, text);
    setDraft("");
  };

  return (
    <li data-testid="pka-thread-item" className="space-y-2 px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_STYLE[status])} />
        <span className="font-medium text-foreground capitalize">{status}</span>
        <span>·</span>
        <time dateTime={record.createdAt}>{timeFormat.format(new Date(record.createdAt))}</time>
        <span>·</span>
        <span>
          {record.elements} {record.elements === 1 ? "element" : "elements"}
        </span>
        <span className="ml-auto font-mono text-[10px]">{record.id.slice(0, 8)}</span>
      </div>
      <p className="line-clamp-3 text-sm whitespace-pre-wrap">
        {record.prompt === "" ? (
          <span className="text-muted-foreground">No prompt</span>
        ) : (
          record.prompt
        )}
      </p>
      {(entries?.length ?? 0) + (outgoing?.length ?? 0) > 0 && (
        <ol className="space-y-1.5 border-l-2 pl-2.5">
          {entries?.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="text-sm">
              <span className="mr-1.5 text-xs font-medium text-muted-foreground">
                {entry.from === "agent" ? "Agent" : "You"}
              </span>
              <span className="whitespace-pre-wrap">{entry.text}</span>
            </li>
          ))}
          {outgoing?.map((text, index) => (
            <li key={`outgoing-${index}`} className="text-sm opacity-60">
              <span className="mr-1.5 text-xs font-medium text-muted-foreground">You</span>
              <span className="whitespace-pre-wrap">{text}</span>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={submit} className="flex items-center gap-1">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`Reply to annotation ${record.id.slice(0, 8)}`}
          placeholder="Reply"
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          aria-label="Send reply"
          disabled={draft.trim() === ""}
        >
          <CornerDownLeftIcon />
        </Button>
      </form>
    </li>
  );
}

export function Thread() {
  const { thread } = useOverlay();
  const sent = useStore(thread, (state) => state.sent);
  if (sent.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
        Nothing sent from this tab yet.
      </p>
    );
  }
  return (
    <ol className="divide-y" data-testid="pka-thread">
      {sent.map((record) => (
        <ThreadItem key={record.id} record={record} />
      ))}
    </ol>
  );
}
