// A page that enforces Trusted Types refuses markup strings, so the overlay's SVG art is
// built element by element.
export function svg(
  tag: string,
  attributes: Readonly<Record<string, string | number>>,
  ...children: Element[]
): SVGElement {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  element.append(...children);
  return element;
}
