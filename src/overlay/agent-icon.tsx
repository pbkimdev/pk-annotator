import { useSyncExternalStore, type ComponentType } from "react";

import { cn } from "./lib/utils.ts";
import { agentIcons } from "./registry.ts";

/** The connected agent's icon for `name` when its theme has one, else the lucide icon. */
export function AgentIcon({
  name,
  icon: Fallback,
  className,
  strokeWidth = 1.75,
}: {
  name: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  className?: string | undefined;
  strokeWidth?: number;
}) {
  const path = useSyncExternalStore(agentIcons.subscribe, () => agentIcons.get()?.[name]);
  if (path === undefined) {
    return (
      <Fallback {...(className === undefined ? {} : { className })} strokeWidth={strokeWidth} />
    );
  }
  return (
    <svg
      viewBox="0 0 256 256"
      fill="currentColor"
      className={cn("pka-agent-icon", className)}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
