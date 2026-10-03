import { describe, expect, it } from "vitest";

import type { NavigationEntry } from "../shared/timeline.ts";
import { producedByReplay } from "./lab.ts";

const origin = "http://127.0.0.1:3210";

function step(type: NavigationEntry["type"], to: string): NavigationEntry {
  return { kind: "navigation", seq: 1, at: "2026-10-03T12:00:00.000Z", type, to: origin + to };
}

describe("producedByReplay", () => {
  it("skips only a recorded history change the replayed step made to the same destination", () => {
    const typed = {
      changes: [{ type: "replace" as const, url: `${origin}/?q=pka%20lab` }],
      entered: true,
    };
    expect(producedByReplay(step("replace", "/?q=he"), `${origin}/?q=he`, typed)).toBe(true);
    expect(producedByReplay(step("push", "/b"), `${origin}/b`, typed)).toBe(false);
    expect(producedByReplay(step("traverse", "/?q=he"), `${origin}/?q=he`, typed)).toBe(false);

    const clicked = {
      changes: [{ type: "push" as const, url: `${origin}/?tab=3` }],
      entered: false,
    };
    expect(producedByReplay(step("push", "/?tab=2"), `${origin}/?tab=2`, clicked)).toBe(false);
    expect(producedByReplay(step("push", "/?tab=3"), `${origin}/?tab=3`, clicked)).toBe(true);
  });
});
