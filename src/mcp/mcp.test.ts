import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client, type JSONRPCMessage } from "@modelcontextprotocol/client";
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
async function createInOtherProcess(target = store): Promise<string> {
  const script = `import { create } from ${JSON.stringify(OPS)};
const { id } = await create(${JSON.stringify(target)}, ${JSON.stringify(DRAFT)});
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

  expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false });
  expect(client.getServerVersion()?.title).toBe("pk-annotator");
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
  // Claude Code 2.1.288 opens this way. pka refuses it so Claude Code falls back to
  // initialize, where channels work; a 2026-07-28 request is still served without discovery.
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
  expect(await request("discover", "server/discover", {})).toMatchObject({
    error: { code: -32601 },
  });
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

it("starts without a store and serves tools once the dev server creates one", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "pka-mcp-empty-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PACKAGE_ROOT, "dist", "pka-mcp.mjs")],
    cwd: project,
    stderr: "pipe",
  });
  const client = new Client({ name: "pka-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
    const missing = await client.callTool({ name: "list_annotations", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(missing.content).toEqual([
      { type: "text", text: expect.stringContaining("Start the app's Vite dev server") },
    ]);

    const created = await createStore(project);
    const listed = await client.callTool({ name: "list_annotations", arguments: {} });
    expect(listed.structuredContent).toEqual({ items: [] });
    await waitForFile(agentFile(created, "pka-test", transport.pid ?? 0));
  } finally {
    await client.close();
    await rm(project, { recursive: true, force: true });
  }
}, 30_000);

it("pushes each new annotation to a Claude Code session once, and nothing to other clients", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "pka-mcp-channel-"));
  const empty = await mkdtemp(path.join(tmpdir(), "pka-mcp-channel-empty-"));
  const channelStore = await createStore(project);
  const backlogId = await createInOtherProcess(channelStore);
  const Message = z.looseObject({
    id: z.string().optional(),
    method: z.string().optional(),
    params: z.looseObject({}).optional(),
    result: z.looseObject({}).optional(),
  });
  type Message = z.infer<typeof Message>;
  const connect = async (name: string, root = project) => {
    const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, "dist", "pka-mcp.mjs")], {
      env: { ...process.env, PKA_ROOT: root },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const messages: Message[] = [];
    let buffered = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) messages.push(Message.parse(JSON.parse(line)));
    });
    const until = async (found: () => Message | undefined): Promise<Message> => {
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const message = found();
        if (message !== undefined) return message;
        await sleep(20);
      }
      throw new Error(`${name} did not receive the expected message`);
    };
    const write = (message: JSONRPCMessage) => child.stdin.write(`${JSON.stringify(message)}\n`);
    write({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name, version: "0.0.0" },
      },
    });
    const initialized = await until(() => messages.find((message) => message.id === "init"));
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    const channel = () =>
      messages.filter((message) => message.method === "notifications/claude/channel");
    return { child, initialized, until, channel };
  };
  try {
    const claude = await connect("claude-code");
    const codex = await connect("codex-mcp-client");
    const storeless = await connect("claude-code", empty);
    expect(claude.initialized.result).toMatchObject({
      capabilities: { experimental: { "claude/channel": {} } },
      instructions: expect.stringContaining("set_status"),
    });
    expect(codex.initialized.result?.capabilities).not.toHaveProperty("experimental");
    expect(codex.initialized.result).not.toHaveProperty("instructions");

    const missing = await storeless.until(() => storeless.channel()[0]);
    expect(missing.params?.meta).toEqual({ event: "error" });
    expect(missing.params?.content).toEqual(expect.stringContaining("pka pushes nothing yet"));

    const backlog = await claude.until(() => claude.channel()[0]);
    expect(backlog.params?.meta).toEqual({ event: "backlog", count: "1" });

    const id = await createInOtherProcess(channelStore);
    const pushed = await claude.until(() => claude.channel()[1]);
    expect(pushed.params?.meta).toEqual({
      event: "annotation",
      annotation_id: id,
      route: DRAFT.route,
      status: "pending",
    });
    expect(pushed.params?.content).toEqual(expect.stringContaining(DRAFT.prompt));
    expect(pushed.params?.content).toEqual(expect.stringContaining("```untrusted\nurl: "));
    await sleep(300);
    expect(claude.channel()).toHaveLength(2);
    expect(JSON.stringify(claude.channel())).not.toContain(backlogId);
    expect(codex.channel()).toEqual([]);

    // The store watcher must not keep the process alive after stdin closes.
    for (const { child } of [claude, codex, storeless]) {
      const exited = once(child, "exit");
      child.stdin.end();
      await exited;
    }
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
}, 30_000);
