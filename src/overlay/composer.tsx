import { useText } from "./language.ts";
import {
  CheckIcon,
  CopyIcon,
  ImageIcon,
  NetworkIcon,
  TriangleAlertIcon,
  VideoIcon,
  GaugeIcon,
  SendIcon,
  Trash2Icon,
  PencilIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { locate, ownerName, type Location } from "../select/source.ts";
import type { AttachmentKind } from "../shared/schema.ts";
import {
  Attachment,
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "./ai-elements/attachments.tsx";
import {
  COMPOSE,
  NOTE,
  elementKey,
  THREAD,
  useOverlay,
  type SavedMark,
  type UiState,
} from "./context.tsx";
import { annotationBlock } from "./markdown.ts";
import { PromptEditor } from "./prompt-editor.tsx";
import { attachments as attachmentList, type ComposerAttachment } from "./registry.ts";
import {
  currentViewport,
  locateElements,
  MAX_ELEMENTS,
  sendAnnotation,
  type SendPhase,
} from "./send.ts";
import { useList, useStore } from "./store.ts";
import { Button } from "./ui/button.tsx";

const KIND_ICON = {
  recording: VideoIcon,
  video: VideoIcon,
  errors: TriangleAlertIcon,
  network: NetworkIcon,
  perf: GaugeIcon,
  frame: ImageIcon,
} satisfies Record<AttachmentKind, LucideIcon>;
const MAX_MARKS = 50;
const MAX_DRAFT_BYTES = 256 * 1024 * 1024;

function markId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function fileLine(location: string): string {
  const [file = location, line] = location.split(":");
  return line === undefined ? file : `${file.split("/").at(-1)}:${line}`;
}

function ElementChip({ element, n, remove }: { element: Element; n: number; remove(): void }) {
  const { ui } = useOverlay();
  const corner = useStore(ui, (state) => state.corner);
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
  const title = where === undefined ? name : `${name} ${fileLine(where)}`;
  return (
    <AttachmentHoverCard>
      <AttachmentHoverCardTrigger asChild>
        <Attachment
          data-testid="pka-element-chip"
          data={{
            id: `element-${elementKey(element)}`,
            type: "source-document",
            sourceId: `element-${elementKey(element)}`,
            mediaType: "text/html",
            title,
          }}
          onRemove={remove}
          className="h-7 max-w-56 cursor-default pl-1 text-xs"
        >
          <AttachmentPreview
            className="size-4 rounded-[3px] bg-pick text-[10px] font-semibold text-pick-foreground"
            fallbackIcon={<span aria-hidden="true">{n}</span>}
          />
          <AttachmentInfo className="font-mono text-[11px]" />
          <AttachmentRemove label={`Remove element ${n}`} className="focus-visible:opacity-100" />
        </Attachment>
      </AttachmentHoverCardTrigger>
      {/* Beside the panel, toward the page, so the card never covers the prompt. */}
      <AttachmentHoverCardContent
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
      </AttachmentHoverCardContent>
    </AttachmentHoverCard>
  );
}

function AttachmentChip({ attachment }: { attachment: ComposerAttachment }) {
  const { ui } = useOverlay();
  const Icon = KIND_ICON[attachment.kind];
  return (
    <Attachment
      data-testid="pka-attachment-chip"
      data={{
        id: attachment.id,
        type: "source-document",
        sourceId: attachment.id,
        mediaType: "text/plain",
        title: attachment.label,
      }}
      onRemove={() => {
        if (!ui.get().busy) attachmentList.remove(attachment.id);
      }}
      className="h-7 max-w-56 cursor-default pl-1 text-xs"
    >
      <AttachmentPreview fallbackIcon={<Icon className="size-3 text-muted-foreground" />} />
      <AttachmentInfo />
      <AttachmentRemove
        label={`Remove ${attachment.label}`}
        className="focus-visible:opacity-100"
      />
    </Attachment>
  );
}

function phaseText(phase: SendPhase): string {
  if (phase.phase === "locating") return "Resolving sources…";
  if (phase.phase === "capturing") return "Capturing screenshot…";
  if (phase.phase === "waiting") return "Waiting for the dev server…";
  return `Uploading ${Math.round(phase.sent / 1024)} of ${Math.round(phase.total / 1024)} KB…`;
}

function SavedMarks({
  marks,
  busy,
  current,
  edit,
  remove,
  resume,
}: {
  marks: readonly SavedMark[];
  busy: boolean;
  current: boolean;
  edit(mark: SavedMark): void;
  remove(mark: SavedMark): void;
  resume(): void;
}) {
  const t = useText();
  return (
    <>
      {marks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("No saved marks. Pick or capture to add one.")}
        </p>
      ) : (
        <ol className="divide-y" aria-label={t("Saved marks")}>
          {marks.map((mark, index) => (
            <li key={mark.id} data-testid="pka-saved-mark" className="flex items-center gap-2 py-2">
              <span className="grid size-5 shrink-0 place-items-center rounded-sm bg-pick text-xs text-pick-foreground">
                {index + 1}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => edit(mark)}
                className="min-w-0 flex-1 text-left text-sm focus-visible:outline-ring"
              >
                <span className="block truncate">
                  {mark.prompt || mark.attachments[0]?.label || "Selected elements"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {mark.elements.length} elements · {mark.attachments.length} captures
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Edit mark ${index + 1}`}
                disabled={busy}
                onClick={() => edit(mark)}
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove mark ${index + 1}`}
                disabled={busy}
                onClick={() => remove(mark)}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ol>
      )}
      {current && (
        <Button variant="outline" size="sm" disabled={busy} onClick={resume}>
          {t("Continue current mark")}
        </Button>
      )}
      <label className="block text-xs font-medium">{t("Global comment")}</label>
    </>
  );
}

function canSubmit(state: UiState, batch: boolean): boolean {
  if (state.busy || state.recording) return false;
  if (batch)
    return state.editing === null && (state.marks.length > 0 || state.globalPrompt.trim() !== "");
  return state.prompt.trim() !== "" && state.selection.length <= MAX_ELEMENTS;
}

export function Composer({ batch = false }: { batch?: boolean }) {
  const t = useText();
  const { hot, ui, thread } = useOverlay();
  const selection = useStore(ui, (state) => state.selection);
  const marks = useStore(ui, (state) => state.marks);
  const editing = useStore(ui, (state) => state.editing);
  const prompt = useStore(ui, (state) => (batch ? state.globalPrompt : state.prompt));
  const recording = useStore(ui, (state) => state.recording);
  const busy = useStore(ui, (state) => state.busy);
  const extra = useList(attachmentList);
  const ready = useStore(ui, (state) => canSubmit(state, batch));
  const [phase, setPhase] = useState<SendPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const hasCurrent = selection.length > 0 || extra.length > 0 || ui.get().prompt.trim() !== "";

  const save = async () => {
    if (ui.get().busy || ui.get().recording) return;
    ui.set({ busy: true });
    setError(null);
    try {
      const current = ui.get();
      const others = current.marks.filter((mark) => mark.id !== current.editing);
      if (others.length >= MAX_MARKS)
        throw new Error(`Send or remove marks before saving more than ${MAX_MARKS}.`);
      let bytes = 0;
      const frozen: ComposerAttachment[] = [];
      for (const attachment of extra) {
        const collected = await attachment.collect();
        bytes += collected.files.reduce((total, file) => total + file.data.size, 0);
        if (bytes + others.reduce((total, mark) => total + mark.bytes, 0) > MAX_DRAFT_BYTES) {
          throw new Error("Saved captures would exceed 256 MB. Send or remove saved marks first.");
        }
        frozen.push({ ...attachment, collect: async () => collected });
      }
      const mark: SavedMark = {
        id: current.editing ?? markId(),
        prompt: current.prompt,
        elements: current.selection,
        attachments: frozen,
        bytes,
      };
      const next =
        current.editing === null
          ? [...others, mark]
          : current.marks.map((item) => (item.id === mark.id ? mark : item));
      attachmentList.clear();
      ui.set({
        marks: next,
        prompt: "",
        selection: [],
        editing: null,
        picking: null,
        panel: COMPOSE,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      ui.set({ busy: false });
    }
  };

  const submit = async () => {
    if (!canSubmit(ui.get(), batch)) return;
    const current = ui.get();
    if (batch && current.editing !== null) {
      setError("Save the edited mark before sending all.");
      return;
    }
    const chosen = batch
      ? current.marks
      : [
          {
            id: current.editing ?? markId(),
            prompt: current.prompt,
            elements: selection,
            attachments: extra,
            bytes: 0,
          },
        ];
    const elements = [...new Set(chosen.flatMap((mark) => [...mark.elements]))];
    const text = batch
      ? [
          current.globalPrompt.trim(),
          ...chosen.map((mark, index) => {
            const refs = mark.elements.map((element) => elements.indexOf(element) + 1);
            return `## Mark ${index + 1}${refs.length === 0 ? "" : ` (elements ${refs.join(", ")})`}\n\n${mark.prompt || "See attached capture."}`;
          }),
        ]
          .filter(Boolean)
          .join("\n\n")
      : current.prompt;
    if (text.trim() === "") return;
    setError(null);
    ui.set({ busy: true, picking: null });
    try {
      const allAttachments = chosen.flatMap((mark, index) =>
        mark.attachments.map((attachment) =>
          batch ? { ...attachment, label: `Mark ${index + 1}: ${attachment.label}` } : attachment,
        ),
      );
      const { id, createdAt } = await sendAnnotation(hot, text, elements, allAttachments, setPhase);
      thread.added({ id, prompt: text, createdAt, elements: elements.length });
      for (const attachment of allAttachments) attachment.sent?.(id);
      if (batch) ui.set({ marks: [], globalPrompt: "", panel: THREAD });
      else {
        attachmentList.clear();
        ui.set({
          marks: current.marks.filter((mark) => mark.id !== current.editing),
          selection: [],
          prompt: "",
          editing: null,
          panel: THREAD,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPhase(null);
      ui.set({ busy: false });
    }
  };

  const edit = (mark: SavedMark) => {
    if (hasCurrent) {
      setError("Save or finish the current mark before editing another.");
      return;
    }
    for (const attachment of mark.attachments) attachmentList.add(attachment);
    ui.set({
      selection: mark.elements,
      prompt: mark.prompt,
      editing: mark.id,
      picking: null,
      panel: NOTE,
    });
  };

  const copy = async () => {
    try {
      const elements = await locateElements(selection);
      await navigator.clipboard.writeText(
        annotationBlock(
          { route: location.pathname, viewport: currentViewport(), prompt },
          elements,
        ),
      );
      setCopied(true);
    } catch (cause) {
      setError(`Copy failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  const pasteImage = (file: File) => {
    if (ui.get().busy) return;
    if (attachmentList.get().length >= 50) {
      setError("Save or send this mark before adding more captures.");
      return;
    }
    if (file.size > 16 * 1024 * 1024) {
      setError("Pasted images must be 16 MB or smaller.");
      return;
    }
    const id = markId();
    const extension = file.type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
    const path = `capture/files/pasted-${id}.${extension}`;
    attachmentList.add({
      id,
      kind: "frame",
      label: file.name,
      collect: async () => ({
        path,
        summary: "Image pasted into the prompt",
        files: [{ path, data: file }],
      }),
    });
  };

  return (
    <div className="space-y-3 p-3">
      {batch ? (
        <SavedMarks
          marks={marks}
          busy={busy}
          current={hasCurrent}
          edit={edit}
          remove={(mark) => ui.set({ marks: marks.filter((item) => item !== mark) })}
          resume={() => ui.set({ panel: NOTE })}
        />
      ) : (
        <Attachments variant="inline" className="gap-1.5">
          {selection.map((element, index) => (
            <ElementChip
              key={elementKey(element)}
              element={element}
              n={index + 1}
              remove={() => {
                if (!busy) ui.set({ selection: selection.filter((item) => item !== element) });
              }}
            />
          ))}
          {extra.map((attachment) => (
            <AttachmentChip key={attachment.id} attachment={attachment} />
          ))}
        </Attachments>
      )}
      <PromptEditor
        key={batch ? "global" : (editing ?? "current")}
        value={prompt}
        onChange={(value) => ui.set(batch ? { globalPrompt: value } : { prompt: value })}
        label={t(batch ? "Global comment" : "Prompt")}
        disabled={busy}
        onSend={() => void submit()}
        {...(batch ? {} : { onPasteImage: pasteImage })}
      />
      <div className="flex items-center gap-2">
        {!batch && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("Copy as Markdown")}
            data-testid="pka-copy"
            disabled={busy}
            onClick={() => void copy()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        )}
        <span className="mr-auto text-xs text-muted-foreground">{t("Ctrl / ⌘ Enter sends")}</span>
        {!batch && (
          <Button
            variant="outline"
            size="sm"
            data-testid="pka-save"
            disabled={busy || recording || !hasCurrent || selection.length > MAX_ELEMENTS}
            onClick={() => void save()}
          >
            {t("Save")}
          </Button>
        )}
        <Button size="sm" data-testid="pka-send" disabled={!ready} onClick={() => void submit()}>
          <SendIcon />
          {t(batch ? "Send all" : "Send")}
        </Button>
      </div>
      {recording && (
        <p className="text-xs text-muted-foreground">Stop recording before saving or sending.</p>
      )}
      {selection.length > MAX_ELEMENTS && (
        <p className="text-xs text-destructive">Select at most {MAX_ELEMENTS} elements.</p>
      )}
      <div aria-live="polite" className="text-xs">
        {error !== null ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : phase !== null ? (
          <p className="text-muted-foreground">{phaseText(phase)}</p>
        ) : null}
      </div>
    </div>
  );
}
