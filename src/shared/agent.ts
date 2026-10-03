import { z } from "zod";

import { Timestamp } from "./schema.ts";

/** Presence files of running pka-mcp sessions, relative to the store. */
export const AGENTS_DIR = ["live", "agents"] as const;

// Written by pka-mcp when a client opens the connection, removed when it exits.
export const AgentPresence = z.strictObject({
  name: z.string().min(1).max(200),
  version: z.string().max(200),
  pid: z.number().int().positive(),
  connectedAt: Timestamp,
});

export type AgentPresence = z.infer<typeof AgentPresence>;
export type AgentKind = "claude" | "codex";

/**
 * Clients with a first-class theme. Claude Code 2.1.288 sends "claude-code"; Codex 0.160
 * sends "codex-mcp-client" (both observed 2026-10-03). Other Codex builds start with "codex".
 */
export function agentKind(name: string): AgentKind | null {
  if (name === "claude-code") return "claude";
  if (name.startsWith("codex")) return "codex";
  return null;
}

/** The client name in a claimant `<client name>:<pid>`. */
export function claimantName(claimant: string): string {
  const colon = claimant.lastIndexOf(":");
  return colon < 0 ? claimant : claimant.slice(0, colon);
}
