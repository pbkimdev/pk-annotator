import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, Extension, Node, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { MicIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useOverlay } from "./context.tsx";
import { useText } from "./language.ts";
import { useStore } from "./store.ts";
import { Button } from "./ui/button.tsx";

/** A saved mark as a badge in the editor; `n` is its number in the saved list. */
export type BadgeMark = { id: string; n: number; title: string };
type BadgeHandlers = { edit(id: string): void; remove(id: string): void };

const BADGE = "markBadge";
const BADGE_TOKEN = /^\{\{mark:([0-9a-f]+)\}\}/;

/** The Markdown a badge serializes to; Send replaces it with the mark's section. */
export function badgeToken(id: string): string {
  return `{{mark:${id}}}`;
}

/** An inline, draggable mark badge; clicking it edits the mark and × removes the mark. */
function markBadge(handlers: { current: BadgeHandlers }, label: (value: string) => string) {
  const stepOver = (editor: Editor, forward: boolean): boolean => {
    const { selection } = editor.state;
    if (selection instanceof NodeSelection) return selection.node.type.name === BADGE;
    if (!selection.empty) return false;
    const next = forward ? selection.$from.nodeAfter : selection.$from.nodeBefore;
    if (next?.type.name !== BADGE) return false;
    // Text editing never deletes a mark; × does.
    return editor.commands.setTextSelection(selection.from + (forward ? 1 : -1));
  };
  return Node.create({
    name: BADGE,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes: () => ({
      id: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-mark-id"),
        renderHTML: (attributes) => ({ "data-mark-id": attributes.id }),
      },
      n: { default: 0, rendered: false },
      title: { default: "", rendered: false },
    }),
    parseHTML: () => [{ tag: "span[data-mark-id]" }],
    renderHTML: ({ HTMLAttributes, node }) => ["span", HTMLAttributes, `#${node.attrs.n}`],
    markdownTokenName: BADGE,
    markdownTokenizer: {
      name: BADGE,
      level: "inline",
      start: "{{mark:",
      tokenize: (source) => {
        const match = BADGE_TOKEN.exec(source);
        return match === null ? undefined : { type: BADGE, raw: match[0], id: match[1] };
      },
    },
    parseMarkdown: (token) => ({ type: BADGE, attrs: { id: token.id } }),
    renderMarkdown: (node) => badgeToken(String(node.attrs?.id)),
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          const { selection } = editor.state;
          if (!(selection instanceof NodeSelection) || selection.node.type.name !== BADGE)
            return false;
          handlers.current.edit(String(selection.node.attrs.id));
          return true;
        },
        Backspace: ({ editor }) => stepOver(editor, false),
        Delete: ({ editor }) => stepOver(editor, true),
      };
    },
    addNodeView: () => (props) => {
      const dom = document.createElement("span");
      dom.className = "pka-mark-badge";
      dom.contentEditable = "false";
      dom.draggable = true;
      dom.dataset.testid = "pka-saved-mark";
      const edit = document.createElement("span");
      edit.setAttribute("role", "button");
      const remove = document.createElement("span");
      remove.setAttribute("role", "button");
      remove.className = "pka-mark-remove";
      remove.textContent = "×";
      dom.append(edit, remove);
      let id = "";
      const render = (node: ProseMirrorNode) => {
        id = String(node.attrs.id);
        const n = String(node.attrs.n);
        edit.textContent = `#${n}`;
        edit.setAttribute("aria-label", `${label("Edit mark")} ${n}`);
        remove.setAttribute("aria-label", `${label("Remove mark")} ${n}`);
        dom.title = String(node.attrs.title);
      };
      render(props.node);
      edit.addEventListener("click", () => handlers.current.edit(id));
      remove.addEventListener("click", () => handlers.current.remove(id));
      return {
        dom,
        update(node) {
          if (node.type.name !== BADGE) return false;
          render(node);
          return true;
        },
        ignoreMutation: () => true,
      };
    },
  });
}

/**
 * Makes the badges match `marks`: renumbers them, drops badges of removed marks and
 * duplicates, and appends a badge for each mark that has none.
 */
function syncBadges(editor: Editor, marks: readonly BadgeMark[]): void {
  const { state } = editor;
  const type = state.schema.nodes[BADGE];
  const paragraph = state.schema.nodes.paragraph;
  if (type === undefined || paragraph === undefined) throw new Error("Badge schema is missing");
  const wanted = new Map(marks.map((mark) => [mark.id, mark]));
  const seen = new Set<string>();
  const changes: { pos: number; size: number; mark: BadgeMark | null }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type !== type) return;
    const mark = wanted.get(String(node.attrs.id));
    if (mark === undefined || seen.has(mark.id))
      changes.push({ pos, size: node.nodeSize, mark: null });
    else {
      seen.add(mark.id);
      if (node.attrs.n !== mark.n || node.attrs.title !== mark.title)
        changes.push({ pos, size: node.nodeSize, mark });
    }
  });
  const missing = marks.filter((mark) => !seen.has(mark.id));
  if (changes.length === 0 && missing.length === 0) return;
  const transaction = state.tr;
  for (const change of changes.toReversed()) {
    if (change.mark === null) transaction.delete(change.pos, change.pos + change.size);
    else transaction.setNodeMarkup(change.pos, undefined, change.mark);
  }
  if (missing.length > 0) {
    const nodes = missing.map((mark) => type.create(mark));
    if (transaction.doc.lastChild?.type === paragraph)
      transaction.insert(transaction.doc.content.size - 1, nodes);
    else transaction.insert(transaction.doc.content.size, paragraph.create(null, nodes));
  }
  editor.view.dispatch(transaction.setMeta("addToHistory", false));
}

const interimKey = new PluginKey<string>("pka-interim");

/** Shows dictation's interim text at the cursor without changing the document. */
const Interim = Extension.create({
  name: "pkaInterim",
  addProseMirrorPlugins: () => [
    new Plugin<string>({
      key: interimKey,
      state: {
        init: () => "",
        apply: (transaction, value): string => transaction.getMeta(interimKey) ?? value,
      },
      props: {
        decorations(state) {
          const text = interimKey.getState(state);
          if (text === undefined || text === "") return null;
          const widget = () => {
            const span = document.createElement("span");
            span.className = "pka-interim";
            span.textContent = text;
            return span;
          };
          return DecorationSet.create(state.doc, [
            Decoration.widget(state.selection.head, widget, { side: 1 }),
          ]);
        },
      },
    }),
  ],
});

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionApi = new () => Recognition;

function recognitionApi(): RecognitionApi | undefined {
  // SAFETY: TypeScript's DOM library has no SpeechRecognition constructor; both names are
  // optional here and the caller hides dictation when neither exists.
  const scope = globalThis as {
    SpeechRecognition?: RecognitionApi;
    webkitSpeechRecognition?: RecognitionApi;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** A Markdown block editor; `actions` sit at the end of its bottom row. */
export function PromptEditor({
  value,
  onChange,
  label,
  placeholder,
  disabled,
  onSend,
  onPasteImage,
  onError,
  marks,
  actions,
}: {
  value: string;
  onChange(value: string): void;
  label: string;
  placeholder: string;
  disabled: boolean;
  onSend(): void;
  onPasteImage?(file: File): void;
  onError(message: string): void;
  marks?: { items: readonly BadgeMark[] } & BadgeHandlers;
  actions: ReactNode;
}) {
  const t = useText();
  const { ui } = useOverlay();
  const language = useStore(ui, (state) => state.language);
  const handlers = useRef<BadgeHandlers>({ edit() {}, remove() {} });
  if (marks !== undefined) handlers.current = marks;
  const items = useRef(marks?.items);
  items.current = marks?.items;
  const badges = marks !== undefined;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false } }),
      Markdown,
      Placeholder.configure({ placeholder }),
      Interim,
      ...(badges ? [markBadge(handlers, t)] : []),
    ],
    content: value,
    contentType: "markdown",
    immediatelyRender: false,
    editable: !disabled,
    editorProps: {
      attributes: {
        class: "pka-editor",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        "data-testid": "pka-prompt",
      },
      handleKeyDown(_view, event) {
        if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.isComposing)
          return false;
        event.preventDefault();
        if (!disabled) onSend();
        return true;
      },
      handlePaste(_view, event) {
        const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length === 0 || onPasteImage === undefined) return false;
        event.preventDefault();
        for (const file of files) onPasteImage(file);
        return true;
      },
    },
    onUpdate: ({ editor: updated }) => {
      if (items.current !== undefined) syncBadges(updated, items.current);
      onChange(updated.getMarkdown());
    },
  });
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  useEffect(() => {
    if (editor !== null && marks !== undefined) syncBadges(editor, marks.items);
  }, [editor, marks]);

  const Api = recognitionApi();
  const recognition = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  useEffect(() => () => recognition.current?.abort(), []);
  const dictate = () => {
    if (editor === null || Api === undefined) return;
    if (recognition.current !== null) {
      recognition.current.stop();
      return;
    }
    const interim = (text: string) =>
      editor.view.dispatch(editor.state.tr.setMeta(interimKey, text));
    const session = new Api();
    session.lang = language === "ko" ? "ko-KR" : "en-US";
    session.continuous = true;
    session.interimResults = true;
    session.onresult = (event) => {
      let pending = "";
      for (const result of Array.from(event.results).slice(event.resultIndex)) {
        const text = result.item(0).transcript;
        if (!result.isFinal) {
          pending += text;
          continue;
        }
        const { $from } = editor.state.selection;
        const before = $from.parent.textBetween(
          Math.max(0, $from.parentOffset - 1),
          $from.parentOffset,
        );
        const spoken = text.trim();
        if (spoken !== "")
          editor.view.dispatch(
            editor.state.tr.insertText(before === "" || /\s/.test(before) ? spoken : ` ${spoken}`),
          );
      }
      interim(pending);
    };
    session.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech")
        onError(`Dictation failed: ${event.error}`);
    };
    session.onend = () => {
      recognition.current = null;
      setListening(false);
      if (!editor.isDestroyed) interim("");
    };
    recognition.current = session;
    session.start();
    setListening(true);
  };

  return (
    <div className="rounded-2xl border bg-background transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15 dark:bg-input/20">
      <EditorContent editor={editor} />
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        {Api !== undefined && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground aria-pressed:text-destructive"
            aria-label={t("Dictate")}
            aria-pressed={listening}
            data-testid="pka-dictate"
            disabled={disabled || editor === null}
            onClick={dictate}
          >
            <MicIcon
              strokeWidth={1.75}
              className={listening ? "animate-pulse motion-reduce:animate-none" : undefined}
            />
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </div>
    </div>
  );
}
