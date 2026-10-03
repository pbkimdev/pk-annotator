import { useText } from "../language.ts";
import { CircleDotIcon, CircleIcon, SquareIcon, CropIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { NOTE, useOverlay } from "../context.tsx";
import { cn } from "../lib/utils.ts";
import { attachments, registerPanel, type PanelProps } from "../registry.ts";
import { createRecorder, RECORDING_ATTACHMENT, videoUnavailable } from "../recording/recorder.ts";
import { useList, useStore } from "../store.ts";
import { Button } from "../ui/button.tsx";

const recorder = createRecorder();

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function RecordIcon({ className }: { className?: string }) {
  const recording = useStore(recorder.state, (state) => state.phase === "recording");
  return (
    <CircleDotIcon
      className={cn(
        className,
        recording && "animate-pulse fill-destructive text-destructive motion-reduce:animate-none",
      )}
    />
  );
}

function Running() {
  const t = useText();
  const startedAt = useStore(recorder.state, (state) => state.startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const counts = recorder.counts();
  return (
    <>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="size-2 rounded-full bg-destructive" />
        <span className="font-medium">{t("Recording")}</span>
        <time
          data-testid="pka-record-elapsed"
          className="font-mono text-muted-foreground tabular-nums"
          aria-label={t("Elapsed time")}
        >
          {clock(now - startedAt)}
        </time>
        <Button
          variant="destructive"
          size="sm"
          className="ml-auto"
          data-testid="pka-record-stop"
          onClick={() => void recorder.stop()}
        >
          <SquareIcon className="fill-current" />
          {t("Stop")}
        </Button>
      </div>
      {counts !== undefined && (
        <p data-testid="pka-record-counts" className="text-xs text-muted-foreground">
          {[
            count(counts.steps, "step"),
            count(counts.errors, "error"),
            count(counts.requests, "request"),
            count(counts.frames, "keyframe"),
            ...(counts.dropped > 0 ? [`${counts.dropped} over the entry cap`] : []),
          ].join(" · ")}
        </p>
      )}
    </>
  );
}

function RecordingOptions() {
  const t = useText();
  const { ui } = useOverlay();
  const phase = useStore(recorder.state, (state) => state.phase);
  const withGif = useStore(recorder.state, (state) => state.withGif);
  const region = useStore(ui, (state) => state.recordRegion);
  const withVideo = useStore(recorder.state, (state) => state.withVideo);
  const attached = useList(attachments).some((item) => item.id === RECORDING_ATTACHMENT);
  const unavailable = useMemo(videoUnavailable, []);

  return (
    <>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          data-testid="pka-record-start"
          disabled={phase === "stopping"}
          onClick={() => {
            // The user records by using the page, which pick and box modes would intercept.
            ui.set({ picking: null, hover: null, marquee: null });
            recorder.start(region);
          }}
        >
          <CircleIcon className="fill-destructive text-destructive" />
          {t(phase === "stopping" ? "Saving…" : attached ? "Record again" : "Start recording")}
        </Button>
        <label
          className={cn(
            "flex items-center gap-1.5 text-sm",
            unavailable !== undefined && "text-muted-foreground",
          )}
        >
          <input
            type="checkbox"
            data-testid="pka-record-gif"
            className="size-3.5 accent-primary"
            checked={withGif && unavailable === undefined}
            disabled={unavailable !== undefined || phase !== "idle"}
            onChange={(event) => recorder.setWithGif(event.target.checked)}
          />
          GIF
        </label>
        <label
          className={cn(
            "flex items-center gap-1.5 text-sm",
            unavailable !== undefined && "text-muted-foreground",
          )}
        >
          <input
            type="checkbox"
            data-testid="pka-record-video"
            className="size-3.5 accent-primary"
            checked={withVideo && unavailable === undefined}
            disabled={unavailable !== undefined || phase !== "idle"}
            onChange={(event) => recorder.setWithVideo(event.target.checked)}
          />
          {t("Video")}
        </label>
      </div>
      {phase === "idle" && (
        <div className="flex items-center gap-2 text-xs">
          <Button
            size="xs"
            variant="outline"
            onClick={() => ui.set({ gesture: "record-area", picking: null, panel: null })}
          >
            <CropIcon />
            {t(region === null ? "Choose area" : "Change area")}
          </Button>
          <span className="text-muted-foreground">
            {region === null
              ? t("Whole viewport")
              : `${Math.round(region.w)} × ${Math.round(region.h)}`}
          </span>
          {region !== null && (
            <Button size="xs" variant="ghost" onClick={() => ui.set({ recordRegion: null })}>
              {t("Reset")}
            </Button>
          )}
        </div>
      )}
      {withGif && (
        <p className="text-xs text-muted-foreground">
          GIF: up to 120 frames, 480 px, 32 MB. Video and GIF show typed values.
        </p>
      )}
    </>
  );
}

function RecordPanel(_props: PanelProps) {
  const t = useText();
  const { ui } = useOverlay();
  const phase = useStore(recorder.state, (state) => state.phase);
  const video = useStore(recorder.state, (state) => state.video);
  const last = useStore(recorder.state, (state) => state.last);
  const error = useStore(recorder.state, (state) => state.error);
  const attached = useList(attachments).some((item) => item.id === RECORDING_ATTACHMENT);
  const unavailable = useMemo(videoUnavailable, []);

  return (
    <div data-testid="pka-record" className="space-y-3 p-3 text-sm">
      {phase === "recording" ? <Running /> : <RecordingOptions />}
      {phase !== "recording" && unavailable !== undefined && (
        <p className="text-xs text-muted-foreground">
          {unavailable}. Recordings keep the timeline and keyframes.
        </p>
      )}
      {video.state === "starting" && (
        <p className="text-xs text-muted-foreground">{t("Choose this tab to share…")}</p>
      )}
      {video.state === "on" && phase === "recording" && (
        <p className="text-xs text-muted-foreground">
          Tab capture on, overlay excluded. Typed values are visible in the video.
        </p>
      )}
      {video.state === "failed" && (
        <p
          data-testid="pka-record-video-status"
          className="text-xs text-amber-700 dark:text-amber-400"
        >
          {phase === "recording"
            ? `No video: ${video.reason}. The timeline and keyframes are still recorded.`
            : `The last recording has no video: ${video.reason}.`}
        </p>
      )}
      {phase === "idle" && attached && last !== null && (
        <div className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-2 text-xs">
          <p className="min-w-0 flex-1">
            <span className="font-medium">{t("Ready to annotate")}</span>{" "}
            <span className="text-muted-foreground">{last}</span>
          </p>
          <Button variant="outline" size="xs" onClick={() => ui.set({ panel: NOTE })}>
            {t("Open editor")}
          </Button>
        </div>
      )}
      {phase === "idle" && !attached && (
        <p className="text-xs text-muted-foreground">
          Keyframe at each action, navigation, and error. Input values are never recorded.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Adds the Record menu item and panel; the returned function also ends a running recording. */
export function registerRecordPanel(onPhase: (active: boolean) => void): () => void {
  const stopPhase = recorder.state.subscribe(() => onPhase(recorder.state.get().phase !== "idle"));
  const unregister = registerPanel({
    id: "record",
    label: "Record",
    icon: RecordIcon,
    component: RecordPanel,
  });
  return () => {
    unregister();
    stopPhase();
    recorder.dispose();
  };
}
