import {
  CheckIcon,
  CopyIcon,
  ImageIcon,
  MousePointer2Icon,
  NetworkIcon,
  TriangleAlertIcon,
  VideoIcon,
  GaugeIcon,
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
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
  type PromptInputMessage,
} from "./ai-elements/prompt-input.tsx";
import { elementKey, THREAD, useOverlay } from "./context.tsx";
import { annotationBlock } from "./markdown.ts";
import { attachments as attachmentList, type ComposerAttachment } from "./registry.ts";
import {
  currentViewport,
  locateElements,
  MAX_ELEMENTS,
  sendAnnotation,
  type SendPhase,
} from "./send.ts";
import { useList, useStore } from "./store.ts";

const KIND_ICON = {
  recording: VideoIcon,
  video: VideoIcon,
  errors: TriangleAlertIcon,
  network: NetworkIcon,
  perf: GaugeIcon,
  frame: ImageIcon,
} satisfies Record<AttachmentKind, LucideIcon>;

function fileLine(location: string): string {
  const [file = location, line] = location.split(":");
  return line === undefined ? file : `${file.split("/").at(-1)}:${line}`;
}

function ElementChip({ element, n, remove }: { element: Element; n: number; remove(): void }) {
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
            className="size-5 rounded-full bg-pick text-[11px] font-semibold text-pick-foreground"
            fallbackIcon={<span aria-hidden="true">{n}</span>}
          />
          <AttachmentInfo className="font-mono text-[11px]" />
          <AttachmentRemove label={`Remove element ${n}`} className="focus-visible:opacity-100" />
        </Attachment>
      </AttachmentHoverCardTrigger>
      <AttachmentHoverCardContent className="w-80 space-y-1 font-mono text-[11px] leading-4">
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
      onRemove={() => attachmentList.remove(attachment.id)}
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

function PastedChips() {
  const pasted = usePromptInputAttachments();
  return pasted.files.map((file) => (
    <Attachment
      key={file.id}
      data={file}
      onRemove={() => pasted.remove(file.id)}
      className="h-7 max-w-56 cursor-default pl-1 text-xs"
    >
      <AttachmentPreview />
      <AttachmentInfo />
      <AttachmentRemove className="focus-visible:opacity-100" />
    </Attachment>
  ));
}

async function pastedAttachment(
  file: PromptInputMessage["files"][number],
  index: number,
): Promise<ComposerAttachment> {
  const data = await (await fetch(file.url)).blob();
  const extension = file.mediaType.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
  const path = `capture/files/pasted-${index + 1}.${extension}`;
  return {
    id: `pasted-${index}`,
    kind: "frame",
    label: file.filename ?? `Pasted image ${index + 1}`,
    collect: async () => ({
      path,
      summary: `Image pasted into the prompt`,
      files: [{ path, data }],
    }),
  };
}

function phaseText(phase: SendPhase): string {
  if (phase.phase === "locating") return "Resolving sources…";
  if (phase.phase === "capturing") return "Capturing screenshot…";
  if (phase.phase === "waiting") return "Waiting for the dev server…";
  return `Uploading ${Math.round(phase.sent / 1024)} of ${Math.round(phase.total / 1024)} KB…`;
}

function CopyMarkdown({ onError }: { onError(message: string): void }) {
  const { ui } = useOverlay();
  const controller = usePromptInputController();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      const elements = await locateElements(ui.get().selection);
      const block = annotationBlock(
        {
          route: location.pathname,
          viewport: currentViewport(),
          prompt: controller.textInput.value,
        },
        elements,
      );
      await navigator.clipboard.writeText(block);
      setCopied(true);
    } catch (error) {
      onError(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (
    <PromptInputButton
      aria-label="Copy as Markdown"
      tooltip="Copy as Markdown"
      data-testid="pka-copy"
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
    </PromptInputButton>
  );
}

function ComposerForm() {
  const { hot, ui, thread } = useOverlay();
  const selection = useStore(ui, (state) => state.selection);
  const picking = useStore(ui, (state) => state.picking);
  const extra = useList(attachmentList);
  const controller = usePromptInputController();
  const [phase, setPhase] = useState<SendPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const empty = controller.textInput.value.trim() === "";

  const submit = async (message: PromptInputMessage) => {
    setError(null);
    try {
      const pasted = await Promise.all(message.files.map(pastedAttachment));
      const { id, createdAt } = await sendAnnotation(
        hot,
        message.text,
        selection,
        [...extra, ...pasted],
        setPhase,
      );
      thread.added({ id, prompt: message.text, createdAt, elements: selection.length });
      for (const attachment of extra) attachment.sent?.(id);
      attachmentList.clear();
      ui.set({ selection: [], panel: THREAD, picking: null });
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setError(text);
      throw cause;
    } finally {
      setPhase(null);
    }
  };

  return (
    <div className="p-2">
      <PromptInput
        accept="image/*"
        multiple
        onSubmit={submit}
        onError={(problem) => setError(problem.message)}
        className="[&_[data-slot=input-group]]:bg-background"
      >
        {(selection.length > 0 || extra.length > 0) && (
          <PromptInputHeader className="px-2 pt-2">
            <Attachments variant="inline" className="gap-1.5">
              {selection.map((element, index) => (
                <ElementChip
                  key={elementKey(element)}
                  element={element}
                  n={index + 1}
                  remove={() =>
                    ui.set({ selection: ui.get().selection.filter((item) => item !== element) })
                  }
                />
              ))}
              {extra.map((attachment) => (
                <AttachmentChip key={attachment.id} attachment={attachment} />
              ))}
              <PastedChips />
            </Attachments>
          </PromptInputHeader>
        )}
        <PromptInputBody>
          <PromptInputTextarea
            data-testid="pka-prompt"
            aria-label="Prompt"
            placeholder={
              selection.length > 0
                ? "What should change?"
                : "Pick elements, then describe the change"
            }
            className="min-h-14 text-sm"
          />
        </PromptInputBody>
        <PromptInputFooter className="px-1.5 pb-1.5">
          <PromptInputTools>
            <PromptInputButton
              aria-label="Pick elements"
              aria-pressed={picking === "pick"}
              tooltip="Pick elements"
              className="aria-pressed:bg-pick aria-pressed:text-pick-foreground"
              onClick={() => ui.set({ picking: picking === "pick" ? null : "pick" })}
            >
              <MousePointer2Icon className="size-4" />
            </PromptInputButton>
            <CopyMarkdown onError={setError} />
            {selection.length > MAX_ELEMENTS && (
              <span className="text-xs text-destructive">At most {MAX_ELEMENTS} elements</span>
            )}
          </PromptInputTools>
          <PromptInputSubmit
            aria-label="Send to agent"
            data-testid="pka-send"
            status={phase === null ? "ready" : "submitted"}
            disabled={phase !== null || empty || selection.length > MAX_ELEMENTS}
          />
        </PromptInputFooter>
      </PromptInput>
      <div aria-live="polite" className="min-h-5 px-1 pt-1.5 text-xs">
        {error !== null ? (
          <p role="alert" className="flex items-start gap-1.5 text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
            {error}
          </p>
        ) : phase !== null ? (
          <p className="text-muted-foreground">{phaseText(phase)}</p>
        ) : (
          <p className="text-muted-foreground">Enter sends · Shift+Enter adds a line</p>
        )}
      </div>
    </div>
  );
}

export { ComposerForm as Composer };
