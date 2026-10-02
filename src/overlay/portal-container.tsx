import { createContext, useContext } from "react";

export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer(): HTMLElement {
  const container = useContext(PortalContainerContext);
  if (!container) throw new Error("PortalContainerContext is missing; render inside the overlay");
  return container;
}
