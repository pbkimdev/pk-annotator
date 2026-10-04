import "@fontsource/source-serif-4/latin-400.css";
import "@fontsource/source-serif-4/latin-400-italic.css";
import "@fontsource/archivo/latin-400.css";
import "@fontsource/archivo/latin-500.css";
import "@fontsource/geist-mono/latin-400.css";
import "./style.css";

const copyStatus = document.querySelector<HTMLElement>(".copy-status");
if (!copyStatus) throw new Error("Missing copy status");
for (const button of document.querySelectorAll<HTMLButtonElement>(".copy-button")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const field = button.closest<HTMLElement>(".copy");
    const code = field?.querySelector("code");
    const value = field?.dataset.value;
    if (value === undefined || !code) throw new Error("Copy control has no value");
    try {
      await navigator.clipboard.writeText(value);
      copyStatus.textContent = button.dataset.done!;
    } catch {
      getSelection()?.selectAllChildren(code);
      code.focus();
      copyStatus.textContent = button.dataset.failed!;
    }
  });
}

const video = document.querySelector<HTMLVideoElement>("#demo-player");
const caption = document.querySelector<HTMLElement>("#demo-caption");
const loading = document.querySelector<HTMLElement>("[data-loading]");
const error = document.querySelector<HTMLElement>("[data-media-error]");
const download = document.querySelector<HTMLAnchorElement>("[data-video-link]");
const retry = document.querySelector<HTMLButtonElement>("[data-retry]");
if (!video || !caption || !loading || !error || !download || !retry) {
  throw new Error("Missing demo player controls");
}
const player = video;
const chapters = [...document.querySelectorAll<HTMLAnchorElement>("[data-clip]")];
const track = player.querySelector("track");
if (!track) throw new Error("Missing demo captions");
const captions = track;
const cover = document.querySelector<HTMLButtonElement>(".play-cover");
const poster = cover?.querySelector("img");
if (!cover || !poster) throw new Error("Missing demo poster");
cover.hidden = false;
cover.addEventListener("click", play);

function play(): void {
  void player.play().catch((cause: unknown) => {
    if (
      cause instanceof DOMException &&
      (cause.name === "AbortError" || cause.name === "NotAllowedError")
    )
      return;
    error!.hidden = false;
    loading!.hidden = true;
  });
}

for (const chapter of chapters) {
  chapter.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const clip = chapter.dataset.clip!;
    player.pause();
    for (const item of chapters) {
      if (item === chapter) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
    }
    caption.textContent = chapter.dataset.caption!;
    error.hidden = true;
    loading.hidden = true;
    player.poster = `/demo/${clip}.webp`;
    poster.src = player.poster;
    cover.hidden = false;
    player.src = chapter.href;
    captions.src = `/demo/${clip}.${document.documentElement.lang}.vtt`;
    download.href = chapter.href;
    player.load();
    play();
  });
}

retry.addEventListener("click", () => {
  error.hidden = true;
  player.load();
  play();
});
player.addEventListener("waiting", () => {
  loading.hidden = false;
});
player.addEventListener("playing", () => {
  loading.hidden = true;
  const returnFocus = document.activeElement === cover;
  cover.hidden = true;
  if (returnFocus) player.focus();
});
player.addEventListener("canplay", () => {
  loading.hidden = true;
});
player.addEventListener("pause", () => {
  loading.hidden = true;
});
player.addEventListener("error", () => {
  loading.hidden = true;
  error.hidden = false;
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) player.pause();
});
const visible = new IntersectionObserver(([entry]) => {
  if (entry && !entry.isIntersecting) player.pause();
});
visible.observe(player);
