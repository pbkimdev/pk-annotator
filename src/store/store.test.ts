import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { State } from "../shared/schema.ts";
import {
  PkaError,
  annotationFiles,
  createClaim,
  createStore,
  readJson,
  requireAnnotation,
  resolveInside,
  writeAnnotationDir,
} from "./store.ts";

const STATE = `${JSON.stringify({
  status: "pending",
  history: [{ status: "pending", at: "2026-10-02T00:00:00.000Z" }],
})}\n`;

let root: string;
let store: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pka-store-"));
  store = await createStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("store", () => {
  it("refuses ids and paths that resolve outside the store", () => {
    expect(() => annotationFiles(store, "../../../etc")).toThrow(PkaError);
    expect(() => resolveInside(store, "..", "outside")).toThrow(/outside/);
    expect(() => resolveInside(store, "/etc/passwd")).toThrow(/outside/);
  });

  it("refuses a symlinked annotation directory and a symlinked file", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "state.json"), STATE);

    await symlink(outside, path.join(store, "linked-annotation"));
    await expect(requireAnnotation(store, "linked-annotation")).rejects.toThrow(/symlink/);

    const real = annotationFiles(store, "real-annotation");
    await mkdir(real.dir);
    await symlink(path.join(outside, "state.json"), real.state);
    await expect(readJson(store, real.state, State)).rejects.toThrow(/symlink/);
  });

  it("lets exactly one of two concurrent claims win", async () => {
    await writeAnnotationDir(store, "claimed-once", [{ path: "state.json", data: STATE }]);
    const at = new Date().toISOString();
    const results = await Promise.all([
      createClaim(store, "claimed-once", { by: "agent-a", at }),
      createClaim(store, "claimed-once", { by: "agent-b", at }),
    ]);
    expect(results.filter((result) => result.won)).toHaveLength(1);
    expect(results[0]?.claim).toEqual(results[1]?.claim);
  });
});
