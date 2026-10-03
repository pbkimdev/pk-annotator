import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

import { GetResult, ListResult } from "../src/ops/ops.ts";
import { NetworkLine, RecordingManifest } from "../src/shared/recording.ts";

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");

test(
  "fixture mounts only outside automation and sends a readable recording",
  { timeout: 120_000 },
  async (t) => {
    await mkdir("/tmp/pk-annotator", { recursive: true });
    const workspace = await mkdtemp("/tmp/pk-annotator/smoke-");
    let server: ViteDevServer | undefined;
    let browser: Browser | undefined;
    t.after(async () => {
      const closed = await Promise.allSettled([browser?.close(), server?.close()]);
      await rm(workspace, { recursive: true, force: true });
      const failures = closed.filter((result) => result.status === "rejected");
      if (failures.length > 0)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Smoke cleanup failed",
        );
    });

    for (const file of [
      "src",
      "dist",
      "package.json",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "fixtures/app/src",
      "fixtures/app/package.json",
      "fixtures/app/tsconfig.json",
      "fixtures/app/vite.config.ts",
    ]) {
      const destination = path.join(workspace, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(repo, file), destination, { recursive: true });
    }
    for (const directory of ["node_modules", "fixtures/app/node_modules"]) {
      await symlink(path.join(repo, directory), path.join(workspace, directory), "dir");
    }

    const fixture = path.join(workspace, "fixtures/app");
    server = await createServer({
      root: fixture,
      configFile: path.join(fixture, "vite.config.ts"),
      configLoader: "runner",
      cacheDir: path.join(workspace, ".vite"),
      server: { host: "127.0.0.1", port: 0, strictPort: true },
      logLevel: "warn",
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    assert.ok(url, "Fixture must expose a loopback URL");
    browser = await chromium.launch();

    const automated = await browser.newContext();
    const guarded = await automated.newPage();
    await guarded.goto(new URL("/lab", url).href);
    await guarded.locator("html[data-fixture-ready]").waitFor({ state: "attached" });
    await guarded.getByTestId("lab-fetch-items").click();
    await guarded.getByTestId("lab-output").filter({ hasText: "alpha" }).waitFor();
    assert.equal(await guarded.evaluate(() => navigator.webdriver), true);
    assert.equal(await guarded.locator("pk-annotator").count(), 0);
    await automated.close();
    t.diagnostic("Automation guard passed after the fixture hydrated.");

    const interactive = await browser.newContext();
    // Only this fixture context impersonates a manual browser; the guard above stays intact.
    await interactive.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    const page = await interactive.newPage();
    page.setDefaultTimeout(30_000);
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(new URL("/lab", url).href);
    await page.locator("html[data-fixture-ready]").waitFor({ state: "attached" });
    assert.equal(await page.evaluate(() => navigator.webdriver), false);
    await page.locator("pk-annotator .pka-launcher").click();
    const dock = page.getByTestId("pka-dock");
    await dock.getByRole("button", { name: "Record", exact: true }).click();
    await page.getByTestId("pka-record-start").click();
    await page.getByTestId("lab-fetch-items").click();
    await page.getByTestId("lab-output").filter({ hasText: "alpha" }).waitFor();
    await page.getByTestId("pka-record-stop").click();
    await page.getByText("In Compose", { exact: true }).waitFor();
    await dock.getByRole("button", { name: "Compose", exact: true }).click();
    const prompt = "Fixture smoke recording";
    await page.getByTestId("pka-prompt").fill(prompt);
    await page.getByTestId("pka-send").click();
    await page.getByTestId("pka-thread-item").filter({ hasText: prompt }).waitFor();

    const cli = path.join(workspace, "dist/pka.mjs");
    const listed = await exec(process.execPath, [
      cli,
      "--root",
      workspace,
      "--json",
      "list",
      "--status",
      "all",
    ]);
    const { items } = ListResult.parse(JSON.parse(listed.stdout));
    assert.equal(items.length, 1);
    const item = items[0];
    assert.ok(item);
    const detail = await exec(process.execPath, [
      cli,
      "--root",
      workspace,
      "--json",
      "get",
      item.id,
    ]);
    const { annotation } = GetResult.parse(JSON.parse(detail.stdout));
    assert.equal(annotation.prompt, prompt);
    assert.equal(annotation.dir, path.join(workspace, "_interim/annotations", item.id));
    assert.ok(annotation.attachments.some((attachment) => attachment.kind === "recording"));

    const capture = path.join(annotation.dir, "capture");
    const summary = await readFile(path.join(capture, "summary.md"), "utf8");
    assert.match(summary, /\/api\/items/);
    const manifest = RecordingManifest.parse(
      JSON.parse(await readFile(path.join(capture, "manifest.json"), "utf8")),
    );
    assert.equal(manifest.frames.failed, 0);
    assert.ok(manifest.frames.items.length > 0, "Recording must save at least one keyframe");
    for (const frame of manifest.frames.items) {
      const bytes = await readFile(path.join(annotation.dir, frame.path));
      assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
    }
    const network = (await readFile(path.join(capture, "network.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => NetworkLine.parse(JSON.parse(line)));
    const request = network.find((entry) => new URL(entry.request.url).pathname === "/api/items");
    assert.ok(request, "The saved recording must contain the fixture request");
    assert.equal(request.response.status, 200);
    assert.match(request.response.content.text ?? "", /alpha/);
    assert.deepEqual(errors, []);
    t.diagnostic(
      "Record → Send → pka list/get passed; summary, network body, and WebP keyframes inspected.",
    );
  },
);
