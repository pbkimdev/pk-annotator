// @vitest-environment happy-dom
import { expect, it } from "vitest";

import { findQuote, quoteOf } from "./quote.ts";

it("finds a selected repeat again after a render splits its text differently", () => {
  document.body.innerHTML = "<p>the fix is in. Then the fix is out.</p>";
  const paragraph = document.querySelector("p")!;
  const text = paragraph.firstChild!;
  const selected = document.createRange();
  selected.setStart(text, 20);
  selected.setEnd(text, 27);
  const quote = quoteOf(selected, paragraph);
  expect(quote).toEqual({ exact: "the fix", prefix: "the fix is in. Then ", suffix: " is out." });

  paragraph.replaceChildren(
    "the fix is in. Then ",
    Object.assign(document.createElement("b"), {
      textContent: "the",
    }),
    " fix is out.",
  );
  const found = findQuote(paragraph, quote);
  expect(found?.toString()).toBe("the fix");
  expect(found?.startContainer.textContent).toBe("the");
  expect(found?.endContainer.textContent).toBe(" fix is out.");
});
