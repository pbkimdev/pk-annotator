import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "tsdown";
import { afterAll, beforeAll, expect, it } from "vitest";

import type { AnnotationDraft } from "../shared/schema.ts";
import { createStore } from "../store/store.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OPS = new URL("../ops/ops.ts", import.meta.url).href;
const DRAFT: AnnotationDraft = {
  url: "http://localhost:3000/projects",
  route: "/projects",
  viewport: { w: 1440, h: 900, dpr: 2, scrollX: 0, scrollY: 0 },
  prompt: "Archive should confirm first",
  elements: [],
  attachments: [],
};
const TOOLS = [
  "get_annotation",
  "get_errors",
  "list_annotations",
  "reply",
  "set_status",
  "wait_for_annotation",
];
const READ_TOOLS = ["get_annotation", "get_errors", "list_annotations", "wait_for_annotation"];

let root: string;
let store: string;

beforeAll(async () => {
  await build({ cwd: PACKAGE_ROOT, logLevel: "silent" });
  root = await mkdtemp(path.join(tmpdir(), "pka-mcp-"));
  store = await createStore(root);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// Another process writes the annotation, as the Vite plugin would.
async function createInOtherProcess(): Promise<string> {
  const script = `import { create } from ${JSON.stringify(OPS)};
const { id } = await create(${JSON.stringify(store)}, ${JSON.stringify(DRAFT)}, []);
process.stdout.write(id);`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
  ]);
  return stdout;
}

function processExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

it("serves six tools, wakes a wait on a new annotation, and exits on stdin EOF", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PACKAGE_ROOT, "dist", "pka-mcp.mjs")],
    env: { PKA_ROOT: root },
    stderr: "pipe",
  });
  const client = new Client({ name: "pka-test", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
  for (const tool of tools) {
    expect(tool.title).toBeTruthy();
    expect(tool.annotations?.openWorldHint).toBe(false);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.outputSchema !== undefined).toBe(true);
    expect(tool.annotations?.readOnlyHint).toBe(READ_TOOLS.includes(tool.name));
  }

  const waiting = client.callTool({
    name: "wait_for_annotation",
    arguments: { timeoutSec: 20 },
  });
  await sleep(300);
  const id = await createInOtherProcess();
  const result = await waiting;
  expect(result.structuredContent).toMatchObject({
    timedOut: false,
    annotation: { id, status: "pending", prompt: DRAFT.prompt },
  });
  expect(result.content).toEqual([
    { type: "text", text: JSON.stringify(result.structuredContent) },
  ]);

  const acknowledged = await client.callTool({
    name: "set_status",
    arguments: { id, status: "acknowledged" },
  });
  expect(acknowledged.structuredContent).toMatchObject({ status: "acknowledged", changed: true });

  const inFlight = client.callTool({ name: "wait_for_annotation", arguments: { timeoutSec: 600 } });
  inFlight.catch(() => undefined);
  await sleep(300);
  const pid = transport.pid;
  expect(pid).not.toBeNull();
  const closing = performance.now();
  await client.close();
  expect(performance.now() - closing).toBeLessThan(1000);
  expect(processExited(pid ?? 0)).toBe(true);
}, 30_000);
