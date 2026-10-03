import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  EditorContent,
  Extension,
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type Editor,
  type ReactNodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowDownUpIcon,
  GaugeIcon,
  ImageIcon,
  MicIcon,
  TriangleAlertIcon,
  VideoIcon,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { locate, ownerName, type Location } from "../select/source.ts";
import type { AttachmentKind } from "../shared/schema.ts";
import { AgentIcon } from "./agent-icon.tsx";
import { useOverlay } from "./context.tsx";
import { useText } from "./language.ts";
import type { ComposerAttachment } from "./registry.ts";
import { useStore } from "./store.ts";
import { Button } from "./ui/button.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card.tsx";

/**
 * A reference shown as a badge in the editor text: a saved mark (Send panel), or a picked
 * element or composer attachment (mark composer). `id` is `<kind>:<item id>`.
 */
export type Badge =
  | { id: string; kind: "mark"; n: number; title: string }
  | { id: string; kind: "element"; n: number; element: Element }
  | { id: string; kind: "attachment"; attachment: ComposerAttachment };
export type Badges = {
  items: readonly Badge[];
  edit(id: string): void;
  remove(id: string): void;
};

const BADGE = "refBadge";
const BADGE_SOURCE = String.raw`\[\[((?:mark|element|attachment):[\w-]+)\]\]`;
const BADGE_TOKEN = new RegExp(`^${BADGE_SOURCE}`);
/**
 * Every badge token in Markdown, with its kind and item id. Tiptap's Markdown serializer
 * backslash-escapes `[` and `]` in typed text, so typed text never forms a token.
 */
export const BADGE_TOKENS = /\[\[(mark|element|attachment):([\w-]+)\]\]/g;

/** The Markdown a badge serializes to. */
export function badgeToken(id: string): string {
  return `[[${id}]]`;
}

const BadgeContext = createContext<{ items: ReadonlyMap<string, Badge>; handlers: Badges } | null>(
  null,
);

function fileLine(location: string): string {
  const [file = location, line] = location.split(":");
  return line === undefined ? file : `${file.split("/").at(-1)}:${line}`;
}

const KIND_ICON = {
  recording: VideoIcon,
  video: VideoIcon,
  errors: TriangleAlertIcon,
  network: ArrowDownUpIcon,
  perf: GaugeIcon,
  frame: ImageIcon,
} satisfies Record<AttachmentKind, LucideIcon>;

function RemoveButton({ label, remove }: { label: string; remove(): void }) {
  return (
    <button
      type="button"
      aria-label={label}
      className="pka-ref-remove"
      onClick={(event) => {
        event.preventDefault();
        remove();
      }}
    >
      ×
    </button>
  );
}

function ElementBadge({ id, n, element }: { id: string; n: number; element: Element }) {
  const t = useText();
  const { ui } = useOverlay();
  const corner = useStore(ui, (state) => state.corner);
  const context = useContext(BadgeContext);
  const [location, setLocation] = useState<Location | undefined>();
  useEffect(() => {
    let current = true;
    void locate(element).then((resolved) => {
      if (current) setLocation(resolved);
    });
    return () => {
      current = false;
    };
  }, [element]);
  const name = location?.component ?? ownerName(element) ?? element.localName;
  const where = location?.source ?? location?.usedAt;
  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>
        <span className="pka-ref pka-ref-element" data-testid="pka-element-ref">
          <span className="pka-ref-n" aria-hidden="true">
            {n}
          </span>
          <span className="pka-ref-label font-mono">
            {where === undefined ? name : `${name} ${fileLine(where)}`}
          </span>
          <RemoveButton
            label={`${t("Remove element")} ${n}`}
            remove={() => context?.handlers.remove(id)}
          />
        </span>
      </HoverCardTrigger>
      {/* Beside the panel, toward the page, so the card never covers the prompt. */}
      <HoverCardContent
        side={corner.endsWith("right") ? "left" : "right"}
        sideOffset={24}
        className="w-80 space-y-1 font-mono text-[11px] leading-4"
      >
        <p className="font-sans text-xs font-semibold">{name}</p>
        {location?.source !== undefined && <p className="break-all">source {location.source}</p>}
        {location?.usedAt !== undefined && <p className="break-all">used at {location.usedAt}</p>}
        {location !== undefined && location.owners.length > 0 && (
          <p className="break-all text-muted-foreground">{location.owners.join(" › ")}</p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/** The node view: a draggable badge whose look comes from the item it references. */
function BadgeView({ node }: ReactNodeViewProps) {
  const t = useText();
  const context = useContext(BadgeContext);
  const id = String(node.attrs.id);
  const item = context?.items.get(id);
  if (context === null || item === undefined) return <NodeViewWrapper as="span" />;
  const { handlers } = context;
  let body: ReactNode;
  if (item.kind === "mark")
    body = (
      <span className="pka-ref pka-ref-mark" data-testid="pka-saved-mark" title={item.title}>
        <span
          role="button"
          aria-label={`${t("Edit mark")} ${item.n}`}
          onClick={() => handlers.edit(id)}
        >
          #{item.n}
        </span>
        <RemoveButton label={`${t("Remove mark")} ${item.n}`} remove={() => handlers.remove(id)} />
      </span>
    );
  else if (item.kind === "element")
    body = <ElementBadge id={id} n={item.n} element={item.element} />;
  else {
    body = (
      <span className="pka-ref pka-ref-attachment" data-testid="pka-attachment-ref">
        <AgentIcon
          name={`kind:${item.attachment.kind}`}
          icon={KIND_ICON[item.attachment.kind]}
          className="size-3 shrink-0"
        />
        <span className="pka-ref-label">{item.attachment.label}</span>
        <RemoveButton
          label={`${t("Remove")} ${item.attachment.label}`}
          remove={() => handlers.remove(id)}
        />
      </span>
    );
  }
  return (
    <NodeViewWrapper as="span" data-drag-handle="">
      {body}
    </NodeViewWrapper>
  );
}

/** Text editing never deletes a badge; × does. */
function stepOver(editor: Editor, forward: boolean): boolean {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection) return selection.node.type.name === BADGE;
  if (!selection.empty) return false;
  const next = forward ? selection.$from.nodeAfter : selection.$from.nodeBefore;
  if (next?.type.name !== BADGE) return false;
  return editor.commands.setTextSelection(selection.from + (forward ? 1 : -1));
}

const RefBadge = Node.create<{ handlers: { current: Badges | null } }>({
  name: BADGE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addOptions: () => ({ handlers: { current: null } }),
  addAttributes: () => ({
    id: {
      default: "",
      parseHTML: (element) => element.getAttribute("data-ref"),
      renderHTML: (attributes) => ({ "data-ref": attributes.id }),
    },
  }),
  parseHTML: () => [{ tag: "span[data-ref]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes],
  markdownTokenName: BADGE,
  markdownTokenizer: {
    name: BADGE,
    level: "inline",
    start: "[[",
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
        const id = String(selection.node.attrs.id);
        if (!id.startsWith("mark:")) return false;
        this.options.handlers.current?.edit(id);
        return true;
      },
      Backspace: ({ editor }) => stepOver(editor, false),
      Delete: ({ editor }) => stepOver(editor, true),
    };
  },
  addNodeView: () => ReactNodeViewRenderer(BadgeView, { as: "span" }),
});

/**
 * Makes the badges match `items`: drops badges without an item and duplicates, and adds a
 * badge for each item that has none, at the cursor while the editor has focus, else at
 * the end.
 */
function syncBadges(editor: Editor, items: readonly Badge[]): void {
  const { state } = editor;
  const type = state.schema.nodes[BADGE];
  const paragraph = state.schema.nodes.paragraph;
  if (type === undefined || paragraph === undefined) throw new Error("Badge schema is missing");
  const wanted = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  const stale: { pos: number; size: number }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type !== type) return;
    const id = String(node.attrs.id);
    if (!wanted.has(id) || seen.has(id)) stale.push({ pos, size: node.nodeSize });
    else seen.add(id);
  });
  const missing = items.filter((item) => !seen.has(item.id));
  if (stale.length === 0 && missing.length === 0) return;
  const transaction = state.tr;
  for (const { pos, size } of stale.toReversed()) transaction.delete(pos, pos + size);
  if (missing.length > 0) {
    const nodes = missing.map((item) => type.create({ id: item.id }));
    const { $head } = transaction.selection;
    if (editor.isFocused && $head.parent.inlineContent) transaction.insert($head.pos, nodes);
    else if (transaction.doc.lastChild?.type === paragraph)
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
  badges,
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
  badges: Badges;
  actions: ReactNode;
}) {
  const t = useText();
  const { ui } = useOverlay();
  const language = useStore(ui, (state) => state.language);
  const handlers = useRef<Badges | null>(badges);
  handlers.current = badges;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false } }),
      Markdown,
      Placeholder.configure({ placeholder }),
      Interim,
      RefBadge.configure({ handlers }),
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
      if (handlers.current !== null) syncBadges(updated, handlers.current.items);
      onChange(updated.getMarkdown());
    },
  });
  // A badge's node view renders through Tiptap's flushSync, which React refuses inside an
  // effect. So toggling editable emits no update, whose handler would sync badges, and the
  // badge sync waits for the commit to end.
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);
  useEffect(() => {
    if (editor === null) return;
    queueMicrotask(() => {
      if (!editor.isDestroyed) syncBadges(editor, badges.items);
    });
  }, [editor, badges]);
  const context = useMemo(
    () => ({ items: new Map(badges.items.map((item) => [item.id, item])), handlers: badges }),
    [badges],
  );

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
      <BadgeContext value={context}>
        <EditorContent editor={editor} />
      </BadgeContext>
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
            <AgentIcon
              name="dictate"
              icon={MicIcon}
              className={listening ? "animate-pulse motion-reduce:animate-none" : undefined}
            />
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </div>
    </div>
  );
}
