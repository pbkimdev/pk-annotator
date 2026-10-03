import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

let rootOptions = {};
if (import.meta.env.DEV) {
  try {
    const { mount } = await import("@srv/pk-annotator/overlay");
    rootOptions = mount({ hot: import.meta.hot! }).reactRootOptions;
  } catch (cause) {
    console.error("pk-annotator did not load; the page runs without it", cause);
  }
}
hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
  rootOptions,
);
