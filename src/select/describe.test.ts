// @vitest-environment happy-dom
import { beforeEach, describe as group, expect, it } from "vitest";

import { describe, preferredLocator } from "./describe.ts";

function pick(selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`fixture has no ${selector}`);
  return element;
}

beforeEach(() => {
  document.body.innerHTML = `
    <main>
      <section>
        <button data-testid="save">Save</button>
        <button data-testid="dup">One</button>
        <button data-testid="dup">Two</button>
        <button id=":r1:">Generated</button>
        <button id="radix-:r2:">Radix</button>
        <a id="docs" href="/docs">Docs</a>
        <label for="email">Email</label><input id="email" type="email">
      </section>
      <section>
        <ul><li>alpha</li><li>beta</li></ul>
        <div><span>left</span></div>
        <div><span>right</span></div>
      </section>
    </main>`;
});

group("describe", () => {
  it("prefers a unique test id, then a stable id, for the CSS selector", () => {
    expect(describe(pick("[data-testid=save]")).selector).toEqual({
      role: "button",
      name: "Save",
      testId: "save",
      css: '[data-testid="save"]',
    });
    expect(describe(pick("#docs")).selector.css).toBe("#docs");
  });

  it("falls back to a unique nth-of-type path for duplicate test ids and generated ids", () => {
    const duplicates = document.querySelectorAll("[data-testid=dup]");
    const second = duplicates[1];
    if (second === undefined) throw new Error("fixture lost a duplicate");
    const css = describe(second).selector.css;
    expect(document.querySelectorAll(css)).toHaveLength(1);
    expect(document.querySelector(css)).toBe(second);

    for (const element of [pick("[id=':r1:']"), pick("[id='radix-:r2:']")]) {
      const generated = describe(element).selector.css;
      expect(generated).not.toContain("#");
      expect(document.querySelector(generated)).toBe(element);
    }

    const right = pick("section:nth-of-type(2) > div:nth-of-type(2) > span");
    const path = describe(right).selector.css;
    expect(document.querySelectorAll(path)).toHaveLength(1);
    expect(document.querySelector(path)).toBe(right);
  });

  it("orders locators: test id, stable id, role and name, text, CSS", () => {
    const locator = (selector: string) => preferredLocator(describe(pick(selector)));
    expect(locator("[data-testid=save]")).toBe('[data-testid="save"]');
    expect(locator("#docs")).toBe("#docs");
    expect(locator("[id=':r1:']")).toBe('role=button[name="Generated"]');
    expect(locator("li")).toBe('text="alpha"');
    const input = describe(pick("#email"));
    expect(input.selector).toMatchObject({ role: "textbox", name: "Email" });
    expect(input.text).toBeUndefined();
  });
});
