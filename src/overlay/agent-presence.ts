// Whether a pka-mcp session is live, from the plugin's pka:agent messages. Part of the
// launcher chunk, like registry.ts: plain data only, so the UI can read it without loading
// the agent theme.

let connected = false;
const listeners = new Set<() => void>();

export function setAgentConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const listener of listeners) listener();
}

/** True while the plugin reports a live pka-mcp session for this page. */
export function isAgentConnected(): boolean {
  return connected;
}

export function subscribeAgentConnected(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
