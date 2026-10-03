import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "tsdown";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";

import { agentFile, agentsDir, liveAgents } from "../ops/presence.ts";
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
// The server answers every request this test sends with a string id.
const Response = z.looseObject({ jsonrpc: z.literal("2.0"), id: z.string() });
type Response = z.infer<typeof Response>;
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
const { id } = await create(${JSON.stringify(store)}, ${JSON.stringify(DRAFT)});
process.stdout.write(id);`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
  ]);
  return stdout;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** The presence write follows the first message asynchronously. */
async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await exists(file)) return;
    await sleep(20);
  }
  throw new Error(`${file} did not appear`);
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

  const pid = transport.pid;
  expect(pid).not.toBeNull();
  const presence = agentFile(store, "pka-test", pid ?? 0);
  await waitForFile(presence);

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
  const closing = performance.now();
  await client.close();
  expect(performance.now() - closing).toBeLessThan(1000);
  expect(processExited(pid ?? 0)).toBe(true);
  expect(await exists(presence)).toBe(false);
}, 30_000);

it("names a 2026-07-28 client from its envelope, drops dead and invalid records, and withdraws on SIGTERM", async () => {
  const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, "dist", "pka-mcp.mjs")], {
    env: { ...process.env, PKA_ROOT: root },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  const responses = new Map<string, Response>();
  let buffered = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const response = Response.parse(JSON.parse(line));
      responses.set(response.id, response);
    }
  });
  // Claude Code 2.1.288 opens this way and never sends initialize.
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {
      name: "claude-code",
      title: "Claude Code",
      version: "2.1.288",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const request = async (
    id: string,
    method: "server/discover" | "tools/call",
    params: { name?: string; arguments?: Record<string, string> },
  ): Promise<Response> => {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } })}\n`,
    );
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const response = responses.get(id);
      if (response !== undefined) return response;
      await sleep(20);
    }
    throw new Error(`No response to ${method}`);
  };
  await request("discover", "server/discover", {});
  const presence = agentFile(store, "claude-code", child.pid ?? 0);
  await waitForFile(presence);

  const id = await createInOtherProcess();
  expect(
    await request("ack", "tools/call", {
      name: "set_status",
      arguments: { id, status: "acknowledged" },
    }),
  ).toMatchObject({ result: { structuredContent: { status: "acknowledged" } } });
  const claim = JSON.parse(await readFile(path.join(store, id, "claim.json"), "utf8"));
  expect(claim.by).toBe(`claude-code:${child.pid}`);

  const ended = spawn(process.execPath, ["--eval", ""]);
  await once(ended, "exit");
  const stale = agentFile(store, "codex-mcp-client", ended.pid ?? 0);
  await writeFile(
    stale,
    JSON.stringify({
      name: "codex-mcp-client",
      version: "0.160.0",
      pid: ended.pid,
      connectedAt: new Date().toISOString(),
    }),
  );
  const invalid = path.join(agentsDir(store), "broken-1.json");
  await writeFile(invalid, JSON.stringify({ name: "x", pid: 1, extra: true }));

  const live = await liveAgents(store);
  expect(live.agents.map((agent) => [agent.name, agent.version, agent.pid])).toEqual([
    ["claude-code", "2.1.288", child.pid],
  ]);
  expect(live.invalid.map((entry) => entry.file)).toEqual([invalid]);
  expect(await exists(stale)).toBe(false);
  await rm(invalid);

  child.kill("SIGTERM");
  await exited;
  expect(await exists(presence)).toBe(false);
  expect(await readdir(agentsDir(store))).toEqual([]);
}, 30_000);
