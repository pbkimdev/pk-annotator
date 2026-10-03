import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type Declaration } from "postcss";
import { esmExternalRequirePlugin } from "rolldown/plugins";
import { defineConfig, type TsdownHooks, type UserConfig } from "tsdown";

const INLINE_CSS = "?inline";
const DIST = path.resolve(import.meta.dirname, "dist");
const STAGING = path.resolve(import.meta.dirname, "node_modules/.cache/pk-annotator-dist");

// A dev server that serves dist/ (the fixture does) reloads pages on every file change, so
// the build never empties dist/: all configs write to STAGING, then each file is renamed
// into dist/, entries last so they never name a missing chunk, and stale files go after.
let pending: number;
const entries = new Set<string>();
const publish: TsdownHooks["build:done"] = async ({ options, chunks }) => {
  if (options.watch !== false) throw new Error("The staged dist/ swap does not support watch");
  for (const chunk of chunks)
    if (chunk.type === "chunk" && chunk.isEntry) entries.add(chunk.fileName);
  pending -= 1;
  if (pending > 0) return;
  const staged = await readdir(STAGING, { withFileTypes: true });
  const odd = staged.find((entry) => !entry.isFile());
  if (odd !== undefined) throw new Error(`Unexpected directory in the build output: ${odd.name}`);
  const files = staged
    .map((entry) => entry.name)
    .toSorted((left, right) => Number(entries.has(left)) - Number(entries.has(right)));
  await mkdir(DIST, { recursive: true });
  for (const file of files) await rename(path.join(STAGING, file), path.join(DIST, file));
  const fresh = new Set(files);
  for (const file of await readdir(DIST)) {
    if (!fresh.has(file)) await rm(path.join(DIST, file), { recursive: true });
  }
  await rm(STAGING, { recursive: true });
};

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
  outDir: STAGING,
  clean: false,
  hooks: { "build:done": publish },
  minify: true,
  outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
  // Capture recognizes the overlay's own errors by this prefix (src/core/errors.ts).
  outputOptions: { chunkFileNames: "pka-overlay-[name]-[hash].mjs" },
  // The UI chunk imports the launcher's modules from the entry instead of a third chunk,
  // so the first page load requests one small file. Radix ships "use client" directives
  // that mean nothing in this browser bundle.
  // web-vitals has no stop API, so its observers are built from a tracked subclass that the
  // overlay pauses while Perf is closed. Free `fetch` calls (snapdom, overlay code) go around
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
  // The agent theme inlines its fonts as bytes, so a consumer's bundler needs no asset
  // handling and a page's font-src, which governs font URLs, does not apply.
  loader: { ".woff2": "binary" },
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

const configs: UserConfig[] = [
  {
    entry: {
      vite: "src/vite/index.ts",
      pka: "src/cli/main.ts",
    },
    platform: "node",
    format: "esm",
    dts: true,
    outDir: STAGING,
    clean: true,
    hooks: { "build:done": publish },
  },
  // Each agent session spawns pka-mcp, so its dependencies are bundled: one module to
  // resolve and compile instead of about 115 from node_modules.
  {
    entry: { "pka-mcp": "src/mcp/bin.ts" },
    platform: "node",
    format: "esm",
    outDir: STAGING,
    clean: false,
    hooks: { "build:done": publish },
    outputOptions: { chunkFileNames: "pka-mcp-server-[hash].mjs" },
    deps: {
      alwaysBundle: [/.*/],
      onlyBundle: false,
    },
  },
  overlay,
];
pending = configs.length;

export default defineConfig(configs);
