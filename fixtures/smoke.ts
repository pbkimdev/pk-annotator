import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

import { z } from "zod";

import { GetResult, ListResult } from "../src/ops/ops.ts";
import { NetworkLine, RecordingManifest } from "../src/shared/recording.ts";

const exec = promisify(execFile);
/** Asserts each `[attachment n: label]` in `prompt` names the attachment stored under n. */
function assertAttachmentRefs(
  prompt: string,
  attachments: readonly { path: string; summary?: string | undefined }[],
  count: number,
): void {
  const references = [...prompt.matchAll(/\[attachment (\d+): ([^\]]+)\]/g)];
  assert.equal(references.length, count);
  for (const [, n, label] of references) {
    const stored = attachments.find((attachment) =>
      attachment.path.startsWith(`capture/attachments/${n}/`),
    );
    assert.ok(stored?.summary?.includes(`: ${label}: `), `Attachment ${n} is not ${label}`);
  }
}

const ImageMetadata = z.object({
  region: z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
});
const repo = path.resolve(import.meta.dirname, "..");
// Console errors the smoke causes on purpose; any other one fails the run. The 1.5×
// context stubs a refused clipboard write.
const EXPECTED_CONSOLE_ERRORS: readonly RegExp[] = [
  /^\[pk-annotator\] copying the sent annotation failed NotAllowedError: Write permission denied\.$/,
];

/** A pka-mcp session that names itself claude-code themes the overlay until it exits. */
/** Connects a claude-code pka-mcp session, runs `whileConnected`, and disconnects it. */
async function checkAgentTheme(
  t: TestContext,
  page: Page,
  workspace: string,
  whileConnected: () => Promise<void>,
): Promise<void> {
  const hub = page.locator("pk-annotator .pka-launcher");
  assert.equal(await page.locator("pk-annotator").getAttribute("data-agent"), null);
  const agent = spawn(
    process.execPath,
    [path.join(workspace, "dist/pka-mcp.mjs"), "--root", workspace],
    {
      stdio: ["pipe", "ignore", "inherit"],
    },
  );
  t.after(() => agent.kill("SIGTERM"));
  const exited = once(agent, "exit");
  agent.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-code", version: "2.1.288" },
      },
    })}\n`,
  );
  await page.locator('pk-annotator[data-agent="claude"]').waitFor({ state: "attached" });
  assert.match((await hub.getAttribute("aria-label")) ?? "", /Claude Code connected/);
  await hub.locator('.pka-agent-logo[data-kind="claude"]').waitFor({ state: "attached" });
  await whileConnected();
  agent.stdin.end();
  await exited;
  await page.locator("pk-annotator:not([data-agent])").waitFor({ state: "attached" });
  assert.doesNotMatch((await hub.getAttribute("aria-label")) ?? "", /connected/);
}

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

    const interactive = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    // Only this fixture context impersonates a manual browser; the guard above stays intact.
    await interactive.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    const page = await interactive.newPage();
    page.setDefaultTimeout(30_000);
    const errors: Error[] = [];
    const consoleErrors: string[] = [];
    const watchErrors = (target: Page) => {
      target.on("pageerror", (error) => errors.push(error));
      target.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (!EXPECTED_CONSOLE_ERRORS.some((expected) => expected.test(text))) {
          consoleErrors.push(text);
        }
      });
    };
    watchErrors(page);
    await page.goto(new URL("/lab", url).href);
    await page.locator("html[data-fixture-ready]").waitFor({ state: "attached" });
    assert.equal(await page.evaluate(() => navigator.webdriver), false);
    const hub = page.locator("pk-annotator .pka-launcher");
    const group = (id: string) => page.locator(`.pka-node[data-group="${id}"]`);
    const focused = (locator: ReturnType<typeof group>) =>
      locator.evaluate((element) => {
        const root = element.getRootNode();
        return root instanceof ShadowRoot && root.activeElement === element;
      });
    // Opens the hub's menu unless it is open, hovers a group to sweep out its ring, and
    // chooses one of its items. Clicking a tool group would run its remembered tool instead.
    const choose = async (id: string, item: string, role: "menuitem" | "menuitemcheckbox") => {
      if ((await hub.getAttribute("aria-expanded")) !== "true") await hub.click();
      await group(id).hover();
      await page.getByRole(role, { name: item, exact: true }).click();
    };
    // Runs a tool group's remembered tool with one click on the group.
    const runRemembered = async (id: string, name: string) => {
      if ((await hub.getAttribute("aria-expanded")) !== "true") await hub.click();
      assert.equal(await group(id).getAttribute("aria-label"), name);
      await group(id).click();
    };
    // Without an agent, the menu offers the MCP setup; copying keeps the menu open, and the
    // pointer leaving the window closes it.
    await hub.click();
    await page.getByRole("menuitem", { name: "Connect agent", exact: true }).click();
    assert.match(
      await page.evaluate(() => navigator.clipboard.readText()),
      /node_modules\/\.bin\/pka-mcp[\s\S]*wait_for_annotation/,
    );
    assert.equal(await hub.getAttribute("aria-expanded"), "true");
    await page.evaluate(() =>
      document.body.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }),
      ),
    );
    await page.locator('pk-annotator .pka-launcher[aria-expanded="false"]').waitFor();

    await choose("capture", "Record", "menuitemcheckbox");
    await page.getByTestId("pka-record-start").click();
    await page.getByTestId("lab-fetch-items").click();
    await page.getByTestId("lab-output").filter({ hasText: "alpha" }).waitFor();
    await page.getByTestId("pka-record-stop").click();
    // The recording is a badge in the text; words typed around it keep their places.
    const prompt = "Fixture smoke recording";
    const recordingRef = page.getByTestId("pka-attachment-ref");
    assert.match(await recordingRef.innerText(), /^Recording \d+:\d\d/);
    await page.getByTestId("pka-prompt").focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type(`${prompt} `);
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" shows the item list");
    const speech = await page.evaluate(
      () => "SpeechRecognition" in window || "webkitSpeechRecognition" in window,
    );
    assert.equal(await page.getByTestId("pka-dictate").count(), speech ? 1 : 0);
    // Opening the menu hides the composer and keeps its draft; closing the menu restores it.
    await hub.click();
    await page.getByTestId("pka-panel").waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await page.getByTestId("pka-panel").waitFor({ state: "visible" });
    assert.match(await page.getByTestId("pka-prompt").innerText(), /Fixture smoke recording/);
    await page.getByTestId("pka-send").click();
    await page.getByTestId("pka-thread-item").filter({ hasText: prompt }).waitFor();
    // With no agent connected, Send also copies the annotation and says so.
    const copiedPopup = page.getByTestId("pka-copied");
    await copiedPopup.waitFor();
    assert.equal(await copiedPopup.getAttribute("data-outcome"), "ok");
    const copiedText = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(
      copiedText,
      /<prompt>Fixture smoke recording \[attachment 1: Recording \d+:\d\d\]/,
    );
    await page.getByRole("button", { name: "OK", exact: true }).click();
    await copiedPopup.waitFor({ state: "detached" });

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
    assert.match(
      annotation.prompt,
      /^Fixture smoke recording \[attachment 1: Recording \d+:\d\d\] shows the item list$/,
    );
    assert.equal(annotation.dir, path.join(workspace, "_interim/annotations", item.id));
    assert.match(copiedText, new RegExp(`\nAnnotation files: _interim/annotations/${item.id}\n$`));
    assert.ok(annotation.attachments.some((attachment) => attachment.kind === "recording"));

    const recording = annotation.attachments.find((attachment) => attachment.kind === "recording");
    assert.ok(recording);
    assert.ok(recording.path.startsWith("capture/attachments/1/"));
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
    // Keyboard: Enter on the hub focuses the Pick group, which shows its remembered tool;
    // Right opens its ring, Left returns, and Enter on the group runs Select.
    await hub.focus();
    await page.keyboard.press("Enter");
    assert.equal(await group("pick").getAttribute("aria-label"), "Select");
    assert.ok(await focused(group("pick")));
    await page.keyboard.press("ArrowRight");
    assert.equal(await group("pick").getAttribute("aria-expanded"), "true");
    assert.ok(await focused(page.getByRole("menuitemcheckbox", { name: "Select", exact: true })));
    await page.keyboard.press("ArrowLeft");
    assert.ok(await focused(group("pick")));
    await page.keyboard.press("Enter");
    assert.equal(await hub.getAttribute("aria-expanded"), "false");
    assert.equal(await hub.getAttribute("data-mode"), "pick");
    await page.mouse.move(fetchBox.x + fetchBox.width / 2, fetchBox.y + fetchBox.height / 2);
    await page.getByTestId("pka-select-tip").filter({ hasText: "⇧ Multi-select" }).waitFor();
    await page.mouse.click(fetchBox.x + fetchBox.width / 2, fetchBox.y + fetchBox.height / 2);
    await page.getByTestId("pka-prompt").fill("Change this button");
    await page.getByTestId("pka-save").click();
    await page.getByTestId("pka-saved-mark").waitFor();
    await page.getByRole("button", { name: "Edit mark 1", exact: true }).click();
    assert.match(await page.getByTestId("pka-prompt").innerText(), /Change this button/);
    await page.getByTestId("pka-prompt").fill("Edited button mark");
    await page.getByTestId("pka-save").click();

    // A drag takes an area and Enter keeps it; a click takes the viewport and ✓ keeps it.
    await choose("capture", "Screenshot", "menuitemcheckbox");
    await page.mouse.move(20, 20);
    await page.mouse.down();
    await page.mouse.move(260, 140, { steps: 5 });
    await page.mouse.up();
    await page.getByTestId("pka-crop").waitFor();
    await page.keyboard.press("Enter");
    await page.getByTestId("pka-prompt").fill("Cropped screenshot mark");
    await page.getByTestId("pka-save").click();
    await runRemembered("capture", "Screenshot");
    await page.mouse.click(400, 300);
    await page.getByTestId("pka-crop-confirm").click();
    await page.getByTestId("pka-prompt").fill("Full screenshot mark");
    await page.getByTestId("pka-save").click();

    await choose("annotate", "Circle", "menuitemcheckbox");
    await page.mouse.move(25, 25);
    await page.mouse.down();
    await page.mouse.move(220, 130, { steps: 5 });
    await page.mouse.up();
    await page.getByTestId("pka-prompt").fill("Circle mark");
    await page.getByTestId("pka-save").click();
    // A saved drawing stays on its route and returns with it.
    const drawing = page.getByTestId("pka-drawing");
    assert.equal(await drawing.count(), 1);
    await page.getByTestId("nav-home").click();
    await drawing.waitFor({ state: "detached" });
    await page.getByTestId("nav-lab").click();
    await drawing.waitFor({ state: "attached" });

    for (const attempt of [1, 2]) {
      if (attempt === 1) await choose("capture", "Record", "menuitemcheckbox");
      else await runRemembered("capture", "Record");
      if (attempt === 1) {
        await page.getByTestId("pka-record-gif").check();
        await page.getByTestId("pka-record-video").check();
      }
      // The area is chosen as the recording starts.
      await page.getByTestId("pka-record-start-area").click();
      await page.mouse.move(20, 20);
      await page.mouse.down();
      await page.mouse.move(260, 140, { steps: 5 });
      await page.mouse.up();
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
    assert.equal(await page.getByTestId("pka-saved-mark").count(), 6);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("pka:tool:capture")), "record");
    assert.equal(
      await page.locator("pk-annotator .pka-launcher[data-count] .pka-count").innerText(),
      "6",
    );
    const global = "Fix these marks together";
    await page.getByTestId("pka-prompt").focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type(`${global} `);
    await page.getByTestId("pka-send").click();
    await page.getByTestId("pka-thread-item").filter({ hasText: global }).waitFor();
    // The batch copies too; Don't show again hides the pop-up for the rest of the tab session.
    await copiedPopup.waitFor();
    assert.match(
      await page.evaluate(() => navigator.clipboard.readText()),
      /<prompt>Fix these marks together\n\n## Mark 1/,
    );
    await page.getByRole("checkbox", { name: "Don't show again" }).check();
    await page.keyboard.press("Escape");
    await copiedPopup.waitFor({ state: "detached" });
    await drawing.waitFor({ state: "detached" });
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
    assert.match(
      batch.prompt,
      /^Fix these marks together\n\n## Mark 1 \(elements 1\)\n\nEdited button mark/,
    );
    assert.doesNotMatch(batch.prompt, /\[\[/);
    assert.match(batch.prompt, /\nEdited button mark \[element 1\]\n/);
    // Each mark's attachment references number across the batch, as the files are stored.
    assertAttachmentRefs(batch.prompt, batch.attachments, 5);
    const regions = await Promise.all(
      batch.attachments
        .filter((attachment) => attachment.path.includes("/capture/images/"))
        .map(async (attachment) => {
          const metadata = path.join(batch.dir, attachment.path.replace(/\.webp$/, ".json"));
          return ImageMetadata.parse(JSON.parse(await readFile(metadata, "utf8"))).region;
        }),
    );
    assert.deepEqual(regions, [{ x: 20, y: 20, w: 240, h: 120 }, null, null]);
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
    await runRemembered("capture", "Record");
    await page.getByTestId("pka-record-start").click();
    await page.getByTestId("practice-submit").click();
    await page.getByTestId("practice-result").getByText("Accepted").waitFor();
    await page.getByTestId("pka-record-stop").click();
    const judged = "Practice smoke: judge the submission";
    await page.getByTestId("pka-prompt").fill(judged);
    await page.getByTestId("pka-send").click();
    await page.getByTestId("pka-thread-item").filter({ hasText: judged }).waitFor();
    assert.equal(await copiedPopup.count(), 0);
    assert.match(
      await page.evaluate(() => navigator.clipboard.readText()),
      /<prompt>Practice smoke/,
    );
    const titleBox = await page.getByTestId("practice-title").boundingBox();
    assert.ok(titleBox);
    await choose("pick", "Select", "menuitemcheckbox");
    await page.mouse.click(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
    // Typed text shaped like a badge token stays text.
    const picked = "Practice smoke: rename [element 1] to Two Sum II {{mark:abc}}";
    await page.getByTestId("pka-element-ref").waitFor();
    await page.getByTestId("pka-prompt").focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("Practice smoke: rename ");
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" to Two Sum II {{mark:abc}}");
    await page.getByTestId("pka-send").click();
    await page.getByTestId("pka-thread-item").filter({ hasText: "Two Sum II" }).waitFor();
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
    const judgedAnnotation = practice.find((annotation) => annotation.prompt.startsWith(judged));
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

    // With the agent connected, Send neither copies nor opens the pop-up.
    await page.evaluate(() => sessionStorage.removeItem("pka:copied-hint"));
    await checkAgentTheme(t, page, workspace, async () => {
      const connected = "Practice smoke: sent to the connected agent";
      await choose("pick", "Select", "menuitemcheckbox");
      await page.mouse.click(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
      await page.getByTestId("pka-element-ref").waitFor();
      await page.getByTestId("pka-prompt").focus();
      await page.keyboard.press("Control+End");
      await page.keyboard.type(connected);
      await page.getByTestId("pka-send").click();
      await page.getByTestId("pka-thread-item").filter({ hasText: connected }).waitFor();
      assert.equal(await copiedPopup.count(), 0);
      await hub.click();
      assert.equal(await page.getByTestId("pka-connect").getAttribute("data-open"), null);
      await page.keyboard.press("Escape");
      assert.doesNotMatch(
        await page.evaluate(() => navigator.clipboard.readText()),
        /connected agent/,
      );
    });

    // Language switches in place, so the menu stays open on the Settings group.
    await choose("settings", "Language: English", "menuitem");
    await page.getByRole("menuitem", { name: "설정", exact: true }).waitFor();
    await page.getByRole("menuitem", { name: "언어: 한국어", exact: true }).click();
    await page.getByRole("menuitem", { name: "Exit annotator", exact: true }).click();
    await page.locator("pk-annotator").waitFor({ state: "detached" });
    // Exit lasts for the tab session; Alt+Shift+A brings the overlay back.
    await page.reload();
    await page.locator("html[data-fixture-ready]").waitFor({ state: "attached" });
    assert.equal(await page.locator("pk-annotator").count(), 0);
    await page.keyboard.press("Alt+Shift+KeyA");
    await hub.waitFor();
    await page.reload();
    await hub.waitFor();

    // At devicePixelRatio 1.5 the flattened stroke lands at its points × 1.5 in the image.
    const scaledContext = await browser.newContext({
      deviceScaleFactor: 1.5,
      viewport: { width: 1000, height: 700 },
    });
    await scaledContext.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Reflect.deleteProperty(window, "SpeechRecognition");
      Reflect.deleteProperty(window, "webkitSpeechRecognition");
      // A refused clipboard write must open the failure pop-up, not claim the copy.
      navigator.clipboard.write = () =>
        Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
    });
    const scaled = await scaledContext.newPage();
    scaled.setDefaultTimeout(30_000);
    watchErrors(scaled);
    await scaled.goto(new URL("/lab", url).href);
    await scaled.locator("html[data-fixture-ready]").waitFor({ state: "attached" });
    await scaled.locator("pk-annotator .pka-launcher").click();
    await scaled.locator('.pka-node[data-group="annotate"]').hover();
    await scaled.getByRole("menuitemcheckbox", { name: "Rectangle", exact: true }).click();
    await scaled.mouse.move(600, 300);
    await scaled.mouse.down();
    await scaled.mouse.move(800, 450, { steps: 5 });
    await scaled.mouse.up();
    // Without the Web Speech API the composer has no dictation button.
    await scaled.getByTestId("pka-prompt").waitFor();
    assert.equal(await scaled.getByTestId("pka-dictate").count(), 0);
    const stroked = "Scaled stroke";
    await scaled.getByTestId("pka-prompt").fill(stroked);
    await scaled.getByTestId("pka-send").click();
    await scaled.getByTestId("pka-thread-item").filter({ hasText: stroked }).waitFor();
    await scaled
      .getByTestId("pka-copied")
      .filter({ hasText: "Couldn't copy to clipboard" })
      .waitFor();
    const strokedItem = ListResult.parse(
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
    ).items.find((candidate) => candidate.prompt.startsWith(stroked));
    assert.ok(strokedItem);
    const strokedAnnotation = GetResult.parse(
      JSON.parse(
        (await exec(process.execPath, [cli, "--root", workspace, "--json", "get", strokedItem.id]))
          .stdout,
      ),
    ).annotation;
    const drawn = strokedAnnotation.attachments.find((attachment) =>
      attachment.path.includes("/capture/images/"),
    );
    assert.ok(drawn);
    const image = await readFile(path.join(strokedAnnotation.dir, drawn.path));
    const samples = await scaled.evaluate(
      async ({ data, points }) => {
        const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/webp" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("No 2D context to read the stroke image");
        context.drawImage(bitmap, 0, 0);
        const ink = new OffscreenCanvas(1, 1).getContext("2d");
        if (ink === null) throw new Error("No 2D context to resolve the stroke color");
        ink.fillStyle = getComputedStyle(document.querySelector("pk-annotator")!)
          .getPropertyValue("--pka-pick")
          .trim();
        ink.fillRect(0, 0, 1, 1);
        return {
          width: bitmap.width,
          ink: Array.from(ink.getImageData(0, 0, 1, 1).data.slice(0, 3)),
          at: points.map(({ x, y }) =>
            Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3)),
          ),
        };
      },
      {
        data: image.toString("base64"),
        // The left edge at mid-height, at dpr × points and at the old dpr² × points.
        points: [
          { x: 900, y: 562 },
          { x: 1350, y: 844 },
        ],
      },
    );
    const near = (pixel: number[] | undefined) =>
      pixel !== undefined &&
      pixel.every((channel, index) => Math.abs(channel - (samples.ink[index] ?? -1000)) <= 40);
    assert.equal(samples.width, 1500);
    assert.ok(near(samples.at[0]), `Stroke missing at 1.5×: ${JSON.stringify(samples)}`);
    assert.ok(!near(samples.at[1]), `Stroke at 2.25×: ${JSON.stringify(samples)}`);
    await scaledContext.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, []);
    t.diagnostic(
      "Direct send, keyboard menu, remembered tools, the Select tip, saved marks, editing, area/full screenshots with crop, persisted drawings, two region GIF/WebM recordings chosen at start, batch send with badges, the clipboard copy and pop-up without an agent, the MCP setup copy, closing on pointer exit, the hub count, the Claude agent theme, the practice page, language, session Exit, the 1.5× stroke position and CLI artifacts passed.",
    );
  },
);
