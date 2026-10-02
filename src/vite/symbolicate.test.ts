import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createServer, type ViteDevServer } from "vite";
import { afterEach, beforeEach, expect, it } from "vitest";

import { symbolicate } from "./symbolicate.ts";

const SOURCE = `interface Options {
  label: string;
  retries: number;
}

export function explode(options: Options): never {
  const message: string = \`boom \${options.label}\`;
  throw new Error(message);
}
`;

let root: string;
let server: ViteDevServer;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "pka-symbolicate-")));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "thrower.ts"), SOURCE);
  server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

it("maps a generated frame through the module's source map to the workspace file and line", async () => {
  const environment = server.environments.client;
  const result = await environment.transformRequest("/src/thrower.ts");
  const generated = result?.code.split("\n") ?? [];
  const line = generated.findIndex((text) => text.includes("throw new Error"));
  const column = generated[line]?.indexOf("throw") ?? -1;
  expect(line).toBeGreaterThanOrEqual(0);
  // The interface is stripped, so the generated line differs from the original line 8.
  expect(line + 1).not.toBe(8);

  const stack = [
    "Error: boom",
    `    at explode (http://localhost:5173/src/thrower.ts?t=1730000000000:${line + 1}:${column + 1})`,
    "    at http://localhost:5173/node_modules/.vite/deps/react-dom.js?v=1a2b3c:10:5",
  ].join("\n");
  const symbolicated = await symbolicate(environment, root, stack);

  expect(symbolicated.topFrame).toBe("src/thrower.ts:8");
  expect(symbolicated.stack.split("\n")).toEqual([
    "Error: boom",
    "    at explode (src/thrower.ts:8:3)",
    "    at http://localhost:5173/node_modules/.vite/deps/react-dom.js?v=1a2b3c:10:5",
  ]);
});
