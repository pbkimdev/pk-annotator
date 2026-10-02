import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    vite: "src/vite/index.ts",
    overlay: "src/overlay/index.ts",
    pka: "src/cli/main.ts",
    "pka-mcp": "src/mcp/main.ts",
  },
  platform: "node",
  format: "esm",
  dts: true,
  clean: true,
});
