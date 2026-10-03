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
    browser = await chromium.launch({
      channel: "chromium",
      args: [
        "--auto-select-tab-capture-source-by-title=pk-annotator fixture",
        "--enable-experimental-web-platform-features",
      ],
    });

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
    const hub = page.locator("pk-annotator .pka-launcher");
    // Opens the hub's menu unless it is open, sweeps out a group, and chooses one of its items.
    const choose = async (group: string, item: string, role: "menuitem" | "menuitemcheckbox") => {
      if ((await hub.getAttribute("aria-expanded")) !== "true") await hub.click();
      await page.getByRole("menuitem", { name: group, exact: true }).click();
      await page.getByRole(role, { name: item, exact: true }).click();
    };
    await choose("Capture", "Record", "menuitemcheckbox");
    await page.getByTestId("pka-record-start").click();
    await page.getByTestId("lab-fetch-items").click();
    await page.getByTestId("lab-output").filter({ hasText: "alpha" }).waitFor();
    await page.getByTestId("pka-record-stop").click();
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

    const recording = annotation.attachments.find((attachment) => attachment.kind === "recording");
    assert.ok(recording);
    const capture = path.dirname(path.join(annotation.dir, recording.path));
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

    const fetchBox = await page.getByTestId("lab-fetch-items").boundingBox();
    assert.ok(fetchBox);
    await choose("Pick elements", "Single", "menuitemcheckbox");
    await page.mouse.click(fetchBox.x + fetchBox.width / 2, fetchBox.y + fetchBox.height / 2);
    await page.getByTestId("pka-prompt").fill("Change this button");
    await page.getByRole("button", { name: "Bold", exact: true }).click();
    await page.getByTestId("pka-save").click();
    await page.getByTestId("pka-saved-mark").waitFor();
    await page.getByRole("button", { name: "Edit mark 1", exact: true }).click();
    assert.match(await page.getByTestId("pka-prompt").innerText(), /Change this button/);
    await page.getByTestId("pka-prompt").fill("Edited button mark");
    await page.getByTestId("pka-save").click();

    await choose("Capture", "Crop screenshot", "menuitemcheckbox");
    await page.mouse.move(20, 20);
    await page.mouse.down();
    await page.mouse.move(260, 140, { steps: 5 });
    await page.mouse.up();
    await page.getByTestId("pka-prompt").fill("Cropped screenshot mark");
    await page.getByTestId("pka-save").click();

    await choose("Annotate", "Circle", "menuitemcheckbox");
    await page.mouse.move(25, 25);
    await page.mouse.down();
    await page.mouse.move(220, 130, { steps: 5 });
    await page.mouse.up();
    await page.getByTestId("pka-prompt").fill("Circle mark");
    await page.getByTestId("pka-save").click();

    for (const attempt of [1, 2]) {
      await choose("Capture", "Record", "menuitemcheckbox");
      if (attempt === 1) {
        await page.getByTestId("pka-record-gif").check();
        await page.getByTestId("pka-record-video").check();
        await page.getByRole("button", { name: "Choose area", exact: true }).click();
        await page.mouse.move(20, 20);
        await page.mouse.down();
        await page.mouse.move(260, 140, { steps: 5 });
        await page.mouse.up();
      }
      await page.getByTestId("pka-record-start").click();
      try {
        await page.getByText("Tab capture on, overlay excluded.", { exact: false }).waitFor();
      } catch (cause) {
        throw new Error(
          `Tab capture did not start: ${await page.getByTestId("pka-record").innerText()}`,
          { cause },
        );
      }
      await page.getByTestId("lab-fetch-items").click();
      await page.getByTestId("lab-output").filter({ hasText: "alpha" }).waitFor();
      await page.getByTestId("pka-record-stop").click();
      await page.getByTestId("pka-prompt").fill(`Saved recording ${attempt}`);
      await page.getByTestId("pka-save").click();
    }
    assert.equal(await page.getByTestId("pka-saved-mark").count(), 5);
    await choose("Settings", "Minimize", "menuitem");
    await hub.click();
    assert.equal(await page.getByTestId("pka-saved-mark").count(), 5);
    const global = "Fix these marks together";
    await page.getByTestId("pka-prompt").fill(global);
    await page.getByTestId("pka-send").click();
    await page.getByTestId("pka-thread-item").filter({ hasText: global }).waitFor();
    const batchedList = ListResult.parse(
      JSON.parse(
        (
          await exec(process.execPath, [
            cli,
            "--root",
            workspace,
            "--json",
            "list",
            "--status",
            "all",
          ])
        ).stdout,
      ),
    );
    assert.equal(batchedList.items.length, 2);
    const batchItem = batchedList.items.find((candidate) => candidate.id !== item.id);
    assert.ok(batchItem);
    const batch = GetResult.parse(
      JSON.parse(
        (await exec(process.execPath, [cli, "--root", workspace, "--json", "get", batchItem.id]))
          .stdout,
      ),
    ).annotation;
    assert.match(batch.prompt, /Fix these marks together/);
    assert.match(batch.prompt, /Edited button mark/);
    assert.equal(batch.elements.length, 1);
    const recordings = batch.attachments.filter((attachment) => attachment.kind === "recording");
    assert.equal(recordings.length, 2);
    assert.notEqual(recordings[0]?.path, recordings[1]?.path);
    for (const recording of recordings) {
      const recordingDir = path.dirname(path.join(batch.dir, recording.path));
      const saved = RecordingManifest.parse(
        JSON.parse(await readFile(path.join(recordingDir, "manifest.json"), "utf8")),
      );
      assert.deepEqual(saved.region, { x: 20, y: 20, w: 240, h: 120 });
      assert.ok(saved.video.path, "Opt-in video must contain WebM data");
      assert.ok(saved.gif, "Opt-in GIF must contain animation data");
      const webm = await readFile(path.join(batch.dir, saved.video.path));
      assert.equal(webm.subarray(0, 4).toString("hex"), "1a45dfa3");
      const gif = await readFile(path.join(batch.dir, saved.gif.path));
      assert.match(gif.toString("ascii", 0, 6), /^GIF8[79]a$/);
      assert.equal(saved.gif.width, 240);
      assert.equal(saved.gif.height, 120);
      assert.ok(saved.gif.frames > 0);
    }
    // A coding-test page with a 20 px root font, in-page code, and a slow judge request.
    await page.getByTestId("nav-practice").click();
    await page.getByTestId("practice-editor").waitFor();
    const hubBox = await hub.boundingBox();
    assert.deepEqual([hubBox?.width, hubBox?.height], [44, 44]);
    await choose("Capture", "Record", "menuitemcheckbox");
    await page.getByTestId("pka-record-start").click();
    await page.getByTestId("practice-submit").click();
    await page.getByTestId("practice-result").getByText("Accepted").waitFor();
    await page.getByTestId("pka-record-stop").click();
    const judged = "Practice smoke: judge the submission";
    await page.getByTestId("pka-prompt").fill(judged);
    await page.getByTestId("pka-send").click();
    await page.getByTestId("pka-thread-item").filter({ hasText: judged }).waitFor();
    const titleBox = await page.getByTestId("practice-title").boundingBox();
    assert.ok(titleBox);
    await choose("Pick elements", "Single", "menuitemcheckbox");
    await page.mouse.click(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
    const picked = "Practice smoke: rename the problem";
    await page.getByTestId("pka-prompt").fill(picked);
    await page.getByTestId("pka-send").click();
    await page.getByTestId("pka-thread-item").filter({ hasText: picked }).waitFor();
    const practiceItems = ListResult.parse(
      JSON.parse(
        (
          await exec(process.execPath, [
            cli,
            "--root",
            workspace,
            "--json",
            "list",
            "--status",
            "all",
          ])
        ).stdout,
      ),
    ).items;
    const practice = await Promise.all(
      practiceItems.map(
        async (candidate) =>
          GetResult.parse(
            JSON.parse(
              (
                await exec(process.execPath, [
                  cli,
                  "--root",
                  workspace,
                  "--json",
                  "get",
                  candidate.id,
                ])
              ).stdout,
            ),
          ).annotation,
      ),
    );
    const judgedAnnotation = practice.find((annotation) => annotation.prompt === judged);
    assert.ok(judgedAnnotation);
    assert.equal(judgedAnnotation.route, "/practice");
    const judgedRecording = judgedAnnotation.attachments.find(
      (attachment) => attachment.kind === "recording",
    );
    assert.ok(judgedRecording);
    const judgedNetwork = (
      await readFile(
        path.join(
          path.dirname(path.join(judgedAnnotation.dir, judgedRecording.path)),
          "network.jsonl",
        ),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => NetworkLine.parse(JSON.parse(line)));
    const submitted = judgedNetwork.find(
      (entry) => new URL(entry.request.url).pathname === "/api/submit",
    );
    assert.ok(submitted, "The practice recording must contain the judge request");
    assert.equal(submitted.response.status, 200);
    assert.match(submitted.response.content.text ?? "", /Accepted/);
    const pickedAnnotation = practice.find((annotation) => annotation.prompt === picked);
    assert.ok(pickedAnnotation);
    assert.match(pickedAnnotation.elements[0]?.source ?? "", /routes\/practice\.tsx:\d+:\d+$/);

    // Language switches in place, so the menu stays open on the Settings group.
    await choose("Settings", "Language: English", "menuitem");
    await page.getByRole("menuitem", { name: "설정", exact: true }).waitFor();
    await page.getByRole("menuitem", { name: "언어: 한국어", exact: true }).click();
    await page.getByRole("menuitem", { name: "Exit annotator", exact: true }).click();
    await page.locator("pk-annotator").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    t.diagnostic(
      "Direct send, saved marks, editing, cropped/drawn captures, two region GIF/WebM recordings, batch send, the practice page, language, minimize, Exit and CLI artifacts passed.",
    );
  },
);
