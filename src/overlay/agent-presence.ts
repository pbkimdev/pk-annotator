// Whether a pka-mcp session is live, from the plugin's pka:agent messages. Part of the
// launcher chunk, like registry.ts: plain data only, so the UI can read it without loading
// the agent theme.

let connected = false;

export function setAgentConnected(next: boolean): void {
  connected = next;
}

/** True while the plugin reports a live pka-mcp session for this page. */
export function isAgentConnected(): boolean {
  return connected;
}
