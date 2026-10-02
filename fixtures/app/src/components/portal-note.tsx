import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function PortalNote() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <aside id="portal-note">
      <p>Portal content</p>
    </aside>,
    document.body,
  );
}
