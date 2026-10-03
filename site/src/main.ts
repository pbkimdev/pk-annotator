import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/architects-daughter/400.css";
import "./style.css";
import { cloud } from "./shapes.ts";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const ZONES = "ABCDEFGH";

async function copy(button: HTMLButtonElement, text: string): Promise<void> {
  const label = button.querySelector("span") ?? button;
  const idle = button.dataset.label ?? label.textContent;
  try {
    await navigator.clipboard.writeText(text);
    label.textContent = button.dataset.done ?? "";
    button.dataset.state = "done";
  } catch {
    // The clipboard can be refused (insecure context, permissions); leave the text selected instead.
    const code = button.parentElement?.querySelector("code");
    if (code) getSelection()?.selectAllChildren(code);
    label.textContent = button.dataset.failed ?? "";
    button.dataset.state = "failed";
  }
  button.addEventListener(
    "pointerleave",
    () => {
      label.textContent = idle;
      delete button.dataset.state;
    },
    { once: true },
  );
}

for (const button of document.querySelectorAll<HTMLButtonElement>(".copy-button")) {
  button.addEventListener("click", () => {
    const code = button.parentElement?.querySelector("code");
    if (!code) throw new Error("copy button without a code element");
    void copy(button, code.textContent ?? "");
  });
}

/* Hero: the request is picked, redlined, sent, and resolved, once, then holds. */
const figure = document.querySelector<HTMLElement>(".hero-figure");
if (!figure) throw new Error("hero figure missing");
const status = figure.querySelector<HTMLElement>(".status");
const lines = [...figure.querySelectorAll<HTMLElement>(".terminal-lines li")];
const STEPS = ["s-pick", "s-cloud", "s-note", "s-send"] as const;
let timers: number[] = [];

function setStatus(state: "pending" | "acknowledged" | "resolved"): void {
  if (!status) return;
  status.textContent = status.dataset[state] ?? state;
  status.dataset.state = state;
}

function finish(): void {
  figure?.classList.add(...STEPS, "s-working", "s-fixed", "s-resolved");
  for (const line of lines) line.classList.add("on");
  setStatus("resolved");
}

function play(): void {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
  figure?.classList.remove(...STEPS, "s-working", "s-fixed", "s-resolved");
  for (const line of lines) line.classList.remove("on");
  if (reducedMotion.matches) return finish();
  setStatus("pending");
  const at = (ms: number, action: () => void) => timers.push(window.setTimeout(action, ms));
  at(500, () => figure?.classList.add("s-pick"));
  at(1300, () => figure?.classList.add("s-cloud"));
  at(2300, () => figure?.classList.add("s-note"));
  at(3600, () => figure?.classList.add("s-send"));
  lines.forEach((line, index) => {
    at(4300 + index * 420, () => {
      line.classList.add("on");
      if (index === 3) {
        setStatus("acknowledged");
        figure?.classList.add("s-working");
      }
      if (index === 5) figure?.classList.add("s-fixed");
      if (index === lines.length - 1) {
        setStatus("resolved");
        figure?.classList.remove("s-working");
        figure?.classList.add("s-resolved");
      }
    });
  });
}

figure.querySelector("[data-replay]")?.addEventListener("click", play);
play();

/* Sheets draw their linework once when they enter the viewport. */
const seen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("seen");
      seen.unobserve(entry.target);
    }
  },
  { rootMargin: "0px 0px -20% 0px" },
);
for (const sheet of document.querySelectorAll(".sheet:not(.sheet-hero)")) seen.observe(sheet);

/* Parts schedule rows light their balloons in the XML. */
for (const row of document.querySelectorAll<HTMLElement>(".schedule tr[data-item]")) {
  const balloons = document.querySelectorAll(`.xml .balloon[data-item="${row.dataset.item}"]`);
  const toggle = (on: boolean) => {
    for (const balloon of balloons) balloon.classList.toggle("lit", on);
  };
  row.addEventListener("pointerenter", () => toggle(true));
  row.addEventListener("pointerleave", () => toggle(false));
}

/* The demo picker: mark this page the way the overlay marks yours. */
type Mark = { element: Element; label: string; zone: string; note: string; node: HTMLElement };

const picker = document.querySelector<HTMLElement>("[data-picker]");
const launcher = document.querySelector<HTMLButtonElement>("[data-launcher]");
if (!picker || !launcher) throw new Error("picker markup missing");
const list = picker.querySelector<HTMLOListElement>(".picker-list");
const count = picker.querySelector<HTMLElement>(".picker-count");
if (!list || !count) throw new Error("picker list missing");
const layer = document.createElement("div");
layer.className = "mark-layer";
layer.setAttribute("aria-hidden", "true");
document.body.append(layer);
const highlight = document.createElement("div");
highlight.className = "pick-highlight";
highlight.hidden = true;
const tag = document.createElement("span");
tag.className = "pick-highlight-tag";
highlight.append(tag);
document.body.append(highlight);
const hint = document.createElement("p");
hint.className = "pick-hint";
hint.textContent = picker.dataset.hint ?? "";
hint.hidden = true;
hint.setAttribute("role", "status");
document.body.append(hint);

const marks: Mark[] = [];
let hovered: Element | null = null;
let frame = 0;
let editing: HTMLElement | null = null;

function ignored(element: Element): boolean {
  return Boolean(
    element.closest(".picker, .launcher, .mark-layer, .pick-highlight, .pick-hint, .mark-editor"),
  );
}

function zoneOf(element: Element): string {
  const rect = element.getBoundingClientRect();
  const letter =
    ZONES[Math.min(7, Math.max(0, Math.floor(((rect.left + rect.width / 2) / innerWidth) * 8)))];
  const sheets = [...document.querySelectorAll(".sheet")];
  const sheet = sheets.findIndex((candidate) => candidate.contains(element));
  return `${letter}${sheet + 1 || "–"}`;
}

function describe(element: Element): string {
  const name = element.tagName.toLowerCase();
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  return text ? `${name} "${text.length > 36 ? `${text.slice(0, 35)}…` : text}"` : name;
}

function place(node: HTMLElement, element: Element): void {
  const rect = element.getBoundingClientRect();
  node.style.left = `${rect.left + scrollX}px`;
  node.style.top = `${rect.top + scrollY}px`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

function showHighlight(element: Element | null): void {
  hovered = element;
  if (!element) {
    highlight.hidden = true;
    return;
  }
  const rect = element.getBoundingClientRect();
  highlight.hidden = false;
  highlight.style.transform = `translate(${rect.left - 4}px, ${rect.top - 4}px)`;
  highlight.style.width = `${rect.width + 8}px`;
  highlight.style.height = `${rect.height + 8}px`;
  tag.textContent = `${element.tagName.toLowerCase()} · ${zoneOf(element)}`;
}

function onMove(event: PointerEvent): void {
  if (editing) return;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    showHighlight(target && !ignored(target) && target !== document.body ? target : null);
  });
}

function renderList(): void {
  if (!list || !count) return;
  list.replaceChildren(
    ...marks.map((mark, index) => {
      const item = document.createElement("li");
      const number = document.createElement("span");
      number.className = "delta-mark";
      number.textContent = String(index + 1);
      const body = document.createElement("span");
      body.textContent = `${mark.label} · ${mark.zone}${mark.note ? ` — ${mark.note}` : ""}`;
      item.append(number, body);
      return item;
    }),
  );
  count.textContent = String(marks.length);
  picker?.toggleAttribute("data-has-marks", marks.length > 0);
}

function closeEditor(): void {
  editing?.remove();
  editing = null;
}

function mark(element: Element): void {
  closeEditor();
  const rect = element.getBoundingClientRect();
  const node = document.createElement("div");
  node.className = "mark";
  place(node, element);
  const pad = 10;
  const width = rect.width + pad * 2;
  const height = rect.height + pad * 2;
  node.innerHTML = `<svg viewBox="${-pad} ${-pad} ${width} ${height}" style="left:${-pad}px;top:${-pad}px;width:${width}px;height:${height}px"><path pathLength="1" d="${cloud(-pad + 2, -pad + 2, width - 4, height - 4, 18)}"/></svg><span class="mark-delta">${marks.length + 1}</span>`;
  layer.append(node);
  const entry: Mark = { element, label: describe(element), zone: zoneOf(element), note: "", node };
  marks.push(entry);
  renderList();

  const editor = document.createElement("form");
  editor.className = "mark-editor";
  editor.style.left = `${Math.min(rect.left + scrollX, scrollX + innerWidth - 300)}px`;
  editor.style.top = `${rect.bottom + scrollY + 14}px`;
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = picker?.dataset.placeholder ?? "";
  input.setAttribute("aria-label", picker?.dataset.placeholder ?? "");
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = picker?.dataset.save ?? "";
  editor.append(input, save);
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    entry.note = input.value.trim();
    renderList();
    closeEditor();
  });
  document.body.append(editor);
  editing = editor;
  input.focus({ preventScroll: true });
}

function onClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || ignored(target)) return;
  event.preventDefault();
  event.stopPropagation();
  if (hovered) mark(hovered);
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    if (editing) closeEditor();
    else setPicking(false);
    return;
  }
  const focused = document.activeElement;
  if (
    event.key === "Enter" &&
    !editing &&
    focused &&
    focused !== document.body &&
    !ignored(focused)
  ) {
    event.preventDefault();
    mark(focused);
  }
}

function onResize(): void {
  for (const entry of marks) place(entry.node, entry.element);
}

function setPicking(on: boolean): void {
  if (!launcher || !picker) return;
  document.documentElement.toggleAttribute("data-picking", on);
  launcher.setAttribute("aria-pressed", String(on));
  const label = launcher.querySelector(".launcher-label");
  const text = (on ? launcher.dataset.on : launcher.dataset.off) ?? "";
  if (label) label.textContent = text;
  launcher.setAttribute("aria-label", text);
  picker.hidden = !on && marks.length === 0;
  hint.hidden = !on;
  // Listeners exist only while marking, so the page does no work otherwise.
  if (on) {
    document.addEventListener("pointermove", onMove);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
  } else {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
  }
  if (!on) {
    closeEditor();
    showHighlight(null);
  }
}

launcher.addEventListener("click", (event) => {
  event.stopPropagation();
  setPicking(launcher.getAttribute("aria-pressed") !== "true");
});

picker.querySelector("[data-pick-clear]")?.addEventListener("click", () => {
  for (const entry of marks) entry.node.remove();
  marks.length = 0;
  renderList();
  closeEditor();
});

picker
  .querySelector<HTMLButtonElement>("[data-pick-copy]")
  ?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;
    const element = picker.dataset.element ?? "element";
    const text = [
      `# ${location.href}`,
      "",
      ...marks.map(
        (entry, index) =>
          `${index + 1}. [${element} ${index + 1}] ${entry.label} (${entry.zone})${entry.note ? `: ${entry.note}` : ""}`,
      ),
    ].join("\n");
    const idle = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = picker.dataset.copied ?? "";
    } catch {
      button.textContent = picker.dataset.failed ?? "";
    }
    button.addEventListener("pointerleave", () => (button.textContent = idle), { once: true });
  });
