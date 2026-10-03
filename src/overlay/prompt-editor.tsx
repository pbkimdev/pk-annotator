import { useText } from "./language.ts";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { BoldIcon, ChevronDownIcon, ItalicIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

/** A Markdown block editor; `actions` sit at the end of its formatting row. */
export function PromptEditor({
  value,
  onChange,
  label,
  placeholder,
  disabled,
  onSend,
  onPasteImage,
  actions,
}: {
  value: string;
  onChange(value: string): void;
  label: string;
  placeholder: string;
  disabled: boolean;
  onSend(): void;
  onPasteImage?(file: File): void;
  actions: ReactNode;
}) {
  const t = useText();
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false } }),
      Markdown,
      Placeholder.configure({ placeholder }),
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
    onUpdate: ({ editor: updated }) => onChange(updated.getMarkdown()),
  });
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
    }),
  });
  return (
    <div className="rounded-2xl border bg-background transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15 dark:bg-input/20">
      <EditorContent editor={editor} />
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        <div role="toolbar" aria-label={t("Text formatting")} className="flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full text-muted-foreground"
                disabled={disabled || editor === null}
                aria-label={t("Block type")}
              >
                {t("Text")} <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => editor?.chain().focus().setParagraph().run()}>
                {t("Paragraph")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
              >
                {t("Heading")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor?.chain().focus().toggleBulletList().run()}>
                {t("Bullet list")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor?.chain().focus().toggleOrderedList().run()}>
                {t("Numbered list")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor?.chain().focus().toggleBlockquote().run()}>
                {t("Quote")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => editor?.chain().focus().toggleCodeBlock().run()}>
                {t("Code block")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            aria-label={t("Bold")}
            aria-pressed={state?.bold}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <BoldIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            aria-label={t("Italic")}
            aria-pressed={state?.italic}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <ItalicIcon />
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </div>
    </div>
  );
}
