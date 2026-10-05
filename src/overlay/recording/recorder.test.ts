// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

import { maskFields } from "./recorder.ts";

afterEach(() => vi.unstubAllGlobals());

it("masks field clones whose constructors differ from the top window", () => {
  const live = document.createElement("div");
  live.innerHTML =
    '<input value="PRIVATE"><textarea>PRIVATE</textarea><select><option>PRIVATE</option></select><span contenteditable="true">PRIVATE</span>';
  const clone = live.cloneNode(true);
  expect(clone).toBeInstanceOf(Element);
  if (!(clone instanceof Element)) throw new Error("No element clone");
  vi.stubGlobal("HTMLInputElement", class extends HTMLInputElement {});
  vi.stubGlobal("HTMLTextAreaElement", class extends HTMLTextAreaElement {});
  vi.stubGlobal("HTMLSelectElement", class extends HTMLSelectElement {});
  expect(clone.querySelector("input") instanceof HTMLInputElement).toBe(false);
  maskFields(clone);
  expect(clone.querySelector<HTMLInputElement>("input")?.value).toBe("•••••");
  expect(clone.querySelector("input")?.getAttribute("value")).toBe("•••••");
  expect(clone.querySelector("textarea")?.textContent).toBe("•••••");
  expect(clone.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("•••••");
  expect(clone.querySelector("option")?.textContent).toBe("•••••");
  expect(clone.querySelector("span")?.textContent).toBe("•••••••");
  expect(live.querySelector("input")?.value).toBe("PRIVATE");
});
