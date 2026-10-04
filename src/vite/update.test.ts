import { describe, expect, it } from "vitest";

import { installCommand, isNewer } from "./update.ts";

describe("update", () => {
  it("offers only a later release", () => {
    expect(isNewer("0.7.0", "0.6.2")).toBe(true);
    expect(isNewer("0.6.10", "0.6.9")).toBe(true);
    expect(isNewer("0.6.2", "0.6.2")).toBe(false);
    expect(isNewer("0.6.2", "0.7.0")).toBe(false);
    expect(isNewer("0.7.0", "0.7.0-beta.1")).toBe(true);
    expect(isNewer("0.7.0-beta.1", "0.6.2")).toBe(true);
    expect(isNewer("0.7.0-beta.1", "0.7.0")).toBe(false);
  });

  it("keeps the dependency field and pinning in each manager's syntax", () => {
    const dir = "/app";
    expect(installCommand({ dir, manager: "pnpm", dev: true, exact: true }, "0.7.0")).toEqual([
      "pnpm",
      "add",
      "--save-dev",
      "--save-exact",
      "pk-annotator@0.7.0",
    ]);
    expect(installCommand({ dir, manager: "npm", dev: true, exact: false }, "0.7.0")).toEqual([
      "npm",
      "install",
      "--save-dev",
      "pk-annotator@0.7.0",
    ]);
    expect(installCommand({ dir, manager: "yarn", dev: false, exact: true }, "0.7.0")).toEqual([
      "yarn",
      "add",
      "--exact",
      "pk-annotator@0.7.0",
    ]);
    expect(installCommand({ dir, manager: "bun", dev: true, exact: false }, "0.7.0")).toEqual([
      "bun",
      "add",
      "--dev",
      "pk-annotator@0.7.0",
    ]);
  });
});
