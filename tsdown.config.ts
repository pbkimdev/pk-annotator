import { readFile } from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type Declaration } from "postcss";
import { esmExternalRequirePlugin } from "rolldown/plugins";
import { defineConfig, type UserConfig } from "tsdown";

const INLINE_CSS = "?inline";

// rem resolves against the host page's <html> font-size, the one host value that
// crosses the shadow boundary, so the overlay stylesheet is compiled to px.
const remToPx = {
  postcssPlugin: "pka-rem-to-px",
  Declaration(declaration: Declaration) {
    if (!declaration.value.includes("rem")) return;
    declaration.value = declaration.value.replace(
      /(-?\d*\.?\d+)rem\b/g,
      (_, value: string) => `${Number(value) * 16}px`,
    );
  },
};

// Compiles `*.css?inline` imports with Tailwind and inlines the result as a string
// that the overlay adopts into its shadow root.
const inlineTailwind = {
  name: "pka-inline-tailwind",
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith(`.css${INLINE_CSS}`) || importer === undefined) return null;
    return path.resolve(path.dirname(importer), source.slice(0, -INLINE_CSS.length)) + INLINE_CSS;
  },
  async load(id: string) {
    if (!id.endsWith(`.css${INLINE_CSS}`)) return null;
    const file = id.slice(0, -INLINE_CSS.length);
    const result = await postcss([tailwindcss({ optimize: { minify: true } }), remToPx]).process(
      await readFile(file, "utf8"),
      { from: file },
    );
    return { code: `export default ${JSON.stringify(result.css)};`, moduleType: "js" as const };
  },
};

const overlay: UserConfig = {
  entry: { overlay: "src/overlay/index.ts" },
  platform: "browser",
  format: "esm",
  target: "es2024",
  dts: true,
  clean: false,
  minify: true,
  outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
  // The UI chunk imports the launcher's modules from the entry instead of a third chunk,
  // so the first page load requests one small file. Radix ships "use client" directives
  // that mean nothing in this browser bundle.
  // web-vitals has no stop API, so its observers are built from a tracked subclass that the
  // overlay disconnects on unmount. Free `fetch` calls (snapdom, overlay code) go around
  // capture's wrapper so overlay requests stay out of the Network panel.
  inputOptions: {
    preserveEntrySignatures: "allow-extension",
    checks: { moduleLevelDirective: false },
    transform: {
      inject: {
        PerformanceObserver: [
          path.resolve(import.meta.dirname, "src/overlay/perf/observer.ts"),
          "TrackedPerformanceObserver",
        ],
        fetch: [
          path.resolve(import.meta.dirname, "src/overlay/untracked-fetch.ts"),
          "untrackedFetch",
        ],
      },
    },
  },
  alias: { "@": path.resolve(import.meta.dirname, "src") },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
  plugins: [
    esmExternalRequirePlugin({ external: [/^react($|\/)/, /^react-dom($|\/)/] }),
    inlineTailwind,
  ],
};

export default defineConfig([
  {
    entry: {
      vite: "src/vite/index.ts",
      pka: "src/cli/main.ts",
    },
    platform: "node",
    format: "esm",
    dts: true,
    clean: true,
  },
  // Each agent session spawns pka-mcp, so its dependencies are bundled: one module to
  // resolve and compile instead of about 115 from node_modules.
  {
    entry: { "pka-mcp": "src/mcp/bin.ts" },
    platform: "node",
    format: "esm",
    clean: false,
    outputOptions: { chunkFileNames: "pka-mcp-server-[hash].mjs" },
    deps: {
      alwaysBundle: [/.*/],
      onlyBundle: false,
    },
  },
  overlay,
]);
