/**
 * Writes `text` to the clipboard once it resolves. The write starts while the click or key
 * press still counts as user activation, which Safari and Firefox require; the ClipboardItem
 * holds the pending text until the dev server's reply arrives.
 */
export function copyLater(text: Promise<string>): Promise<void> {
  if (!("ClipboardItem" in globalThis))
    return text.then((value) => navigator.clipboard.writeText(value));
  return navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })),
    }),
  ]);
}
