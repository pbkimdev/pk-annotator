import { useText } from "./language.ts";

import { agentKind, claimantName } from "../shared/agent.ts";
import type { State, Status } from "../shared/schema.ts";
import { AGENT_LABEL, AGENT_MASCOT } from "./agent-art.ts";
import { useOverlay } from "./context.tsx";
import { cn } from "./lib/utils.ts";
import { useStore } from "./store.ts";
import type { SentRecord } from "./thread-store.ts";

const STATUS_STYLE = {
  pending: "bg-amber-500",
  acknowledged: "bg-sky-500",
  resolved: "bg-emerald-500",
  dismissed: "bg-muted-foreground",
} satisfies Record<Status, string>;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Agent replies come from the claimant, which names its client: `<client name>:<pid>`. */
function ReplyAuthor({ state }: { state: State | undefined }) {
  const t = useText();
  const claimant = state?.history.findLast((event) => event.status === "acknowledged")?.by;
  const kind = claimant === undefined ? null : agentKind(claimantName(claimant));
  if (kind === null) {
    return <span className="mr-1.5 text-xs font-medium text-muted-foreground">{t("Agent")}</span>;
  }
  return (
    <span className="mr-1.5 inline-flex items-center gap-1 align-[-3px] text-xs font-medium text-muted-foreground">
      <span
        className="pka-reply-mascot"
        data-kind={kind}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: AGENT_MASCOT[kind] }}
      />
      {AGENT_LABEL[kind]}
    </span>
  );
}

function ThreadItem({ record }: { record: SentRecord }) {
  const t = useText();
  const { thread } = useOverlay();
  const state = useStore(thread, (current) => current.states.get(record.id));
  const entries = useStore(thread, (current) => current.entries.get(record.id));
  const status = state?.status ?? "pending";

  return (
    <li data-testid="pka-thread-item" className="space-y-2 px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          data-status={status}
          className={cn("pka-status size-1.5 shrink-0 rounded-full", STATUS_STYLE[status])}
        />
        <span className="font-medium text-foreground capitalize">{t(status)}</span>
        <span>·</span>
        <time dateTime={record.createdAt}>{timeFormat.format(new Date(record.createdAt))}</time>
        <span>·</span>
        <span>
          {record.elements} {record.elements === 1 ? "element" : "elements"}
        </span>
        <span className="ml-auto font-mono text-[10px]">{record.id.slice(0, 8)}</span>
      </div>
      <p className="pka-prose line-clamp-3 text-sm whitespace-pre-wrap">
        {record.prompt === "" ? (
          <span className="text-muted-foreground">{t("No prompt")}</span>
        ) : (
          record.prompt
        )}
      </p>
      {entries !== undefined && entries.length > 0 && (
        <ol className="space-y-1.5 border-l-2 pl-2.5">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="text-sm">
              {entry.from === "agent" ? (
                <ReplyAuthor state={state} />
              ) : (
                <span className="mr-1.5 text-xs font-medium text-muted-foreground">{t("You")}</span>
              )}
              <span className="pka-prose whitespace-pre-wrap">{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function Thread() {
  const { thread } = useOverlay();
  const sent = useStore(thread, (state) => state.sent);
  return (
    <ol className="divide-y" data-testid="pka-thread">
      {sent.map((record) => (
        <ThreadItem key={record.id} record={record} />
      ))}
    </ol>
  );
}
