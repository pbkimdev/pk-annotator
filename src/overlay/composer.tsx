import { CopyIcon, SendIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  COMPOSE,
  COPIED_HINT_KEY,
  MAX_DRAFT_BYTES,
  MAX_MARKS,
  NOTE,
  elementKey,
  useOverlay,
  type SavedMark,
  type UiState,
} from "./context.tsx";
import { AgentIcon } from "./agent-icon.tsx";
import { copyLater } from "./clipboard.ts";
import { isAgentConnected } from "./agent-presence.ts";
import { annotationBlock } from "./markdown.ts";
import { useText } from "./language.ts";
import { BADGE_TOKENS, PromptEditor, type Badge, type Badges } from "./prompt-editor.tsx";
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

const SEND_KEY = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘ ↵" : "Ctrl ↵";

function markId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function phaseText(phase: SendPhase): string {
  if (phase.phase === "locating") return "Resolving sources…";
  if (phase.phase === "capturing") return "Capturing screenshot…";
  if (phase.phase === "waiting") return "Waiting for the dev server…";
  return `Uploading ${Math.round(phase.sent / 1024)} of ${Math.round(phase.total / 1024)} KB…`;
}

/** The first line of a Markdown prompt without its markup, for a one-line title. */
function promptTitle(prompt: string): string {
  const line =
    prompt
      .replace(BADGE_TOKENS, "")
      .split("\n")
      .find((candidate) => candidate.trim() !== "") ?? "";
  return line
    .replace(/\\(.)/g, "$1")
    .replace(/[*_`#>~]/g, "")
    .trim();
}

/**
 * Replaces element and attachment badge tokens with references the agent resolves against
 * the sent annotation: `[element n]` for the element's `n`, and `[attachment n: label]` for
 * the files under `capture/attachments/<n>/`. `offset` counts attachments sent before these.
 */
function references(
  text: string,
  elements: readonly Element[],
  attachments: readonly ComposerAttachment[],
  offset: number,
): string {
  return text.replace(
    BADGE_TOKENS,
    (token, kind: string, id: string, at: number, whole: string) => {
      let reference = token;
      if (kind === "element") {
        const n = elements.findIndex((element) => String(elementKey(element)) === id) + 1;
        reference = n === 0 ? "" : `[element ${n}]`;
      } else if (kind === "attachment") {
        const index = attachments.findIndex((attachment) => attachment.id === id);
        const attachment = attachments[index];
        reference =
          attachment === undefined ? "" : `[attachment ${offset + index + 1}: ${attachment.label}]`;
      }
      if (reference === "" || reference === token) return reference;
      // A badge sits apart from the words beside it; its text reference must too.
      const before = /\S/.test(whole[at - 1] ?? " ") ? " " : "";
      const after = /[^\s.,;:!?)]/.test(whole[at + token.length] ?? " ") ? " " : "";
      return `${before}${reference}${after}`;
    },
  );
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The global comment with each mark's section at its badge, or appended when it has none.
 * Attachments are numbered across all marks in order, as they are sent.
 */
function batchText(
  global: string,
  marks: readonly SavedMark[],
  elements: readonly Element[],
): string {
  const sections = new Map<string, string>();
  let offset = 0;
  for (const [index, mark] of marks.entries()) {
    const refs = mark.elements.map((element) => elements.indexOf(element) + 1);
    const prompt = references(mark.prompt, elements, mark.attachments, offset);
    offset += mark.attachments.length;
    sections.set(
      mark.id,
      `## Mark ${index + 1}${refs.length === 0 ? "" : ` (elements ${refs.join(", ")})`}\n\n${prompt.trim() || "See attached capture."}`,
    );
  }
  // A badge whose mark was sent on its own has no section left.
  const text = global.replace(BADGE_TOKENS, (_token, kind: string, id: string) => {
    const section = kind === "mark" ? sections.get(id) : undefined;
    if (section === undefined) return "";
    sections.delete(id);
    return `\n\n${section}\n\n`;
  });
  return tidy([text, ...sections.values()].join("\n\n"));
}

function canSubmit(state: UiState, batch: boolean): boolean {
  if (state.busy || state.recording) return false;
  if (batch)
    return state.editing === null && (state.marks.length > 0 || state.globalPrompt.trim() !== "");
  return state.prompt.trim() !== "";
}

export function Composer({ batch = false }: { batch?: boolean }) {
  const t = useText();
  const { hot, ui, thread } = useOverlay();
  const selection = useStore(ui, (state) => state.selection);
  const marks = useStore(ui, (state) => state.marks);
  const editing = useStore(ui, (state) => state.editing);
  const prompt = useStore(ui, (state) => (batch ? state.globalPrompt : state.prompt));
  const recording = useStore(ui, (state) => state.recording);
  const language = useStore(ui, (state) => state.language);
  const busy = useStore(ui, (state) => state.busy);
  const tooMany = useStore(ui, (state) => state.tooMany);
  const extra = useList(attachmentList);
  const ready = useStore(ui, (state) => canSubmit(state, batch));
  const [phase, setPhase] = useState<SendPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        tooMany: null,
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
      ? batchText(current.globalPrompt, chosen, elements)
      : tidy(references(current.prompt, elements, extra, 0));
    if (text.trim() === "") return;
    setError(null);
    ui.set({ busy: true, picking: null });
    try {
      const allAttachments = chosen.flatMap((mark, index) =>
        mark.attachments.map((attachment) =>
          batch ? { ...attachment, label: `Mark ${index + 1}: ${attachment.label}` } : attachment,
        ),
      );
      const sending = sendAnnotation(hot, text, elements, allAttachments, setPhase);
      // Without an agent the annotation also goes to the clipboard, for pasting into one.
      const copied = isAgentConnected()
        ? null
        : copyLater(
            Promise.all([locateElements(elements), sending]).then(
              ([located, sent]) =>
                `${annotationBlock(
                  { route: location.pathname, viewport: currentViewport(), prompt: text },
                  located,
                )}\nAnnotation files: ${sent.dir}\n`,
            ),
          ).then(
            () => "ok" as const,
            (cause: unknown) => ({ cause }),
          );
      const { id, createdAt } = await sending;
      thread.added({ id, prompt: text, createdAt, elements: elements.length });
      for (const attachment of allAttachments) attachment.sent?.(id);
      if (batch) ui.set({ marks: [], globalPrompt: "", picking: null, panel: null });
      else flush(current.marks.filter((mark) => mark.id !== current.editing));
      // Not awaited: a clipboard write the browser never settles must not keep Send busy.
      void copied?.then((outcome) => {
        if (outcome !== "ok") {
          console.error("[pk-annotator] copying the sent annotation failed", outcome.cause);
          ui.set({ copied: "failed" });
        } else if (sessionStorage.getItem(COPIED_HINT_KEY) === null) ui.set({ copied: "ok" });
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPhase(null);
      ui.set({ busy: false });
    }
  };

  /** Drops the current mark and returns the overlay to idle; `marks` are the saved marks to keep. */
  const flush = (marks: readonly SavedMark[]) => {
    attachmentList.clear();
    ui.set({
      marks,
      selection: [],
      tooMany: null,
      prompt: "",
      editing: null,
      picking: null,
      panel: null,
    });
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

  const latest = useRef({ edit });
  latest.current = { edit };

  const copy = async () => {
    try {
      const elements = await locateElements(selection);
      await navigator.clipboard.writeText(
        annotationBlock(
          {
            route: location.pathname,
            viewport: currentViewport(),
            prompt: tidy(references(prompt, selection, extra, 0)),
          },
          elements,
        ),
      );
      flush(ui.get().marks);
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

  const badges = useMemo((): Badges => {
    const items: Badge[] = batch
      ? marks.map((mark, index) => ({
          id: `mark:${mark.id}`,
          kind: "mark",
          n: index + 1,
          title: promptTitle(mark.prompt) || mark.attachments[0]?.label || t("Selected elements"),
        }))
      : [
          ...selection.map((element, index): Badge => ({
            id: `element:${elementKey(element)}`,
            kind: "element",
            n: index + 1,
            element,
          })),
          ...extra.map((attachment): Badge => ({
            id: `attachment:${attachment.id}`,
            kind: "attachment",
            attachment,
          })),
        ];
    return {
      items,
      edit(id) {
        const mark = ui.get().marks.find((item) => `mark:${item.id}` === id);
        if (mark !== undefined && !ui.get().busy) latest.current.edit(mark);
      },
      remove(id) {
        const state = ui.get();
        if (state.busy) return;
        const [kind, key] = id.split(":");
        if (kind === "mark")
          // Deleting the mark being edited leaves its draft open as a new, unsaved mark.
          ui.set({
            marks: state.marks.filter((mark) => mark.id !== key),
            editing: state.editing === key ? null : state.editing,
          });
        else if (kind === "element")
          ui.set({
            selection: state.selection.filter((element) => String(elementKey(element)) !== key),
          });
        else if (key !== undefined) attachmentList.remove(key);
      },
    };
    // t is a new function each render; language is what changes its output.
  }, [batch, marks, selection, extra, ui, language]);

  return (
    <div className="space-y-3 p-4">
      <PromptEditor
        // The placeholder and label are set when the editor is created; the prompt itself
        // lives in the store, so a language switch remounts the editor without losing it.
        key={`${batch ? "global" : (editing ?? "current")}-${language}`}
        value={prompt}
        onChange={(value) => ui.set(batch ? { globalPrompt: value } : { prompt: value })}
        label={t(batch ? "Global comment" : "Prompt")}
        placeholder={t(batch ? "Add a note for all marks (optional)" : "Describe the change…")}
        disabled={busy}
        onSend={() => void submit()}
        onError={setError}
        badges={badges}
        {...(batch ? {} : { onPasteImage: pasteImage })}
        actions={
          <>
            {!batch && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-muted-foreground"
                  aria-label={t("Copy as Markdown")}
                  data-testid="pka-copy"
                  disabled={busy}
                  onClick={() => void copy()}
                >
                  <AgentIcon name="copy" icon={CopyIcon} />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  data-testid="pka-save"
                  disabled={busy || recording || !hasCurrent}
                  onClick={() => void save()}
                >
                  {t("Save")}
                </Button>
              </>
            )}
            <Button
              size="sm"
              className="rounded-full pr-1.5 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
              data-testid="pka-send"
              aria-keyshortcuts="Control+Enter Meta+Enter"
              disabled={!ready}
              onClick={() => void submit()}
            >
              <AgentIcon name="send" icon={SendIcon} />
              {t("Send")}
              <kbd className="rounded-full bg-current/15 px-1.5 font-sans text-[10px] leading-4 font-medium">
                {SEND_KEY}
              </kbd>
            </Button>
          </>
        }
      />
      {recording && (
        <p className="text-xs text-muted-foreground">Stop recording before saving or sending.</p>
      )}
      {!batch && tooMany !== null && (
        <p role="alert" className="text-xs text-destructive" data-testid="pka-too-many">
          Select at most {MAX_ELEMENTS} elements; that pick had {tooMany}.
        </p>
      )}
      {/* Empty, it cancels the gap above it; it stays mounted so changes are announced. */}
      <div aria-live="polite" className="text-xs empty:-mt-3">
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
