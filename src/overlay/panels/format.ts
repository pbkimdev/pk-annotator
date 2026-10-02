import type { ActionEntry, NavigationEntry, RequestEntry } from "../../shared/timeline.ts";

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function clockTime(at: string): string {
  return clock.format(new Date(at));
}

/** Path and query for same-origin URLs, otherwise host and path. */
export function shortUrl(url: string): string {
  const parsed = new URL(url, location.href);
  const path = `${parsed.pathname}${parsed.search}`;
  return parsed.origin === location.origin ? path : `${parsed.host}${path}`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// An aborted request was cancelled by the page (AbortController, TanStack Query
// deduplication), so it is not a failure.
export function isFailed(request: RequestEntry): boolean {
  return (
    request.state !== "aborted" &&
    (request.state === "failed" || (request.status !== undefined && request.status >= 400))
  );
}

/** Status column text: the HTTP status, or the state while there is none or it was aborted. */
export function statusText(request: RequestEntry): string {
  if (request.state === "aborted") return request.state;
  if (request.status !== undefined && request.status > 0) return String(request.status);
  return request.state === "pending" ? "…" : request.state;
}

export function requestLine(request: RequestEntry): string {
  const parts = [request.method, shortUrl(request.url), statusText(request)];
  if (request.state === "open") parts.push("streaming");
  if (request.error !== undefined) parts.push(request.error);
  parts.push(formatMs(request.durationMs), formatBytes(request.responseSize));
  return parts.filter((part) => part !== "").join(" ");
}

export function actionLine(entry: ActionEntry | NavigationEntry): string {
  if (entry.kind === "navigation") return `navigate (${entry.type}) to ${shortUrl(entry.to)}`;
  const { target } = entry;
  const name = target.label ?? target.text;
  return [
    entry.key === undefined ? entry.type : `${entry.type} ${entry.key}`,
    target.role ?? target.tag,
    name === undefined ? undefined : JSON.stringify(name),
    target.testId === undefined ? undefined : `[data-testid=${target.testId}]`,
    target.src,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}
