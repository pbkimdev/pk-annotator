import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

let rootOptions = {};
if (import.meta.env.DEV) {
  const { mount } = await import("../../../src/overlay/index.ts");
  rootOptions = mount({ hot: import.meta.hot! }).reactRootOptions;
}
hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
  rootOptions,
);
