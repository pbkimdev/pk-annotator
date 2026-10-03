// Agent activity the UI chunk reports to the launcher's hub. Part of the launcher chunk,
// like registry.ts: plain data and listeners only.

type Listener = (event: "working" | "reacted") => void;

let working = false;
const listeners = new Set<Listener>();

/** True while an annotation sent from this tab is acknowledged and not yet closed. */
export function setAgentWorking(next: boolean): void {
  if (next === working) return;
  working = next;
  for (const listener of listeners) listener("working");
}

export function isAgentWorking(): boolean {
  return working;
}

/** An agent replied to, resolved, or dismissed an annotation from this tab. */
export function agentReacted(): void {
  for (const listener of listeners) listener("reacted");
}

export function subscribeHubState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
