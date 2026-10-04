export type Locale = "en" | "ko";

export const SITE = "https://pk-annotator.paulbkim.dev";
export const INSTALL_COMMAND = `curl -fsSL ${SITE}/install.sh | sh`;
export const VERSION = "0.7.0";
export const CLIPS = ["agent", "annotate", "capture", "record", "multi", "rapid"] as const;

const en = {
  lang: "en",
  path: "/",
  title: "pk-annotator · AI development, from your browser",
  description:
    "Point, capture, record, and send. Turn what you see in your app into a precise request for your coding agent.",
  skip: "Skip to content",
  docs: "Docs",
  docsUrl: "https://github.com/pbkimdev/pk-annotator#readme",
  otherLanguage: { label: "한국어", href: "/ko/", lang: "ko" },
  hero: {
    title: "AI development in your browser",
    ending: "has never been easier.",
    lead: "Point at what you want to change. Your coding agent gets the context.",
    action: "Set up with your agent",
    note: "Works in any browser. No browser extension.",
  },
  demo: {
    label: "See how it works",
    play: "Play demo",
    chapters: ["Claude Code", "Annotate", "Capture", "Record", "Multi-add", "Rapid-fire"],
    summaries: [
      "Send a request. Claude Code receives it, makes the change, and replies in History.",
      "Draw right on the page. Send the mark with a clear request.",
      "Capture the area that matters. Crop it, add a note, send.",
      "Show the interaction, not just the result. Record a region as video or GIF.",
      "Save a few marks. Send them together as one request.",
      "Send one request, then the next. No need to wait for the first to be resolved.",
    ],
    footage:
      "Real recordings. Claude Code answers live in the first clip; the others show the overlay alone.",
    loading: "Loading demo…",
    error: "The video could not load. Try again or open the video.",
    retry: "Retry video",
    download: "Open video",
    fallback: "Your browser cannot play this video. Open the video instead.",
  },
  install: {
    title: "Start on your own page.",
    body: "Paste this into Claude Code, Codex, or Pi at your project root. The guide covers installation, the Vite plugin, and connecting your agent.",
    prompt: `Set up pk-annotator in this project by following ${SITE}/agents.md`,
    copyPrompt: "Copy setup prompt",
    commandLabel: "Prefer the terminal?",
    commandBody:
      "Installs the package and registers Claude Code. Then follow the guide to add the Vite plugin and mount the overlay.",
    copyCommand: "Copy command",
    copied: "Copied",
    failed: "Clipboard unavailable. Select and copy the text.",
    guide: "Setup guide",
  },
  footer: { license: "MIT License", author: "Made by Paul B. Kim" },
  notFound: {
    title: "Page not found.",
    body: "This page does not exist.",
    home: "Back to pk-annotator",
  },
};

export type Content = typeof en;

const ko: Content = {
  lang: "ko",
  path: "/ko/",
  title: "pk-annotator · 브라우저에서 시작하는 AI 개발",
  description:
    "가리키고, 캡처하고, 녹화해서 보내세요. 앱에서 보고 있는 화면을 코딩 에이전트가 이해할 수 있는 정확한 요청으로 바꿉니다.",
  skip: "본문으로 건너뛰기",
  docs: "문서",
  docsUrl: "https://github.com/pbkimdev/pk-annotator/blob/main/README.ko.md",
  otherLanguage: { label: "English", href: "/", lang: "en" },
  hero: {
    title: "브라우저에서 시작하는 AI 개발,",
    ending: "이렇게 쉬워집니다.",
    lead: "바꾸고 싶은 곳을 짚으세요. 코딩 에이전트에게 필요한 맥락까지 전달됩니다.",
    action: "에이전트로 설정하기",
    note: "어떤 브라우저에서든. 브라우저 확장 없이.",
  },
  demo: {
    label: "사용 방법 보기",
    play: "데모 재생",
    chapters: ["Claude Code", "화면에 표시", "캡처", "녹화", "모아서 보내기", "연달아 보내기"],
    summaries: [
      "요청을 보내면 Claude Code가 받아서 바로 고치고, 기록에 답장을 남깁니다.",
      "페이지 위에 바로 그리세요. 표시와 함께 원하는 변경을 보내세요.",
      "필요한 부분을 캡처하고, 자르고, 한마디를 더해 보내세요.",
      "결과만으로 부족할 때. 동작하는 모습을 영상이나 GIF로 담으세요.",
      "여러 곳에 표시해 두세요. 하나의 요청으로 모아서 보내세요.",
      "하나 보내고, 다음 요청도 바로. 이전 요청이 해결될 때까지 기다릴 필요 없어요.",
    ],
    footage:
      "실제 녹화입니다. 첫 영상은 Claude Code가 실시간으로 응답하고, 나머지는 오버레이만 보여 줍니다.",
    loading: "데모를 불러오는 중…",
    error: "영상을 불러오지 못했습니다. 다시 시도하거나 영상을 직접 열어 주세요.",
    retry: "영상 다시 불러오기",
    download: "영상 열기",
    fallback: "이 브라우저에서는 영상을 재생할 수 없습니다. 영상을 직접 열어 주세요.",
  },
  install: {
    title: "내 페이지에서 시작하세요.",
    body: "프로젝트 루트에서 Claude Code, Codex, Pi에 붙여 넣으세요. 설치부터 Vite 플러그인 설정, 에이전트 연결까지 안내합니다.",
    prompt: `${SITE}/agents.md 를 따라 이 프로젝트에 pk-annotator를 설정해 줘`,
    copyPrompt: "설정 요청 복사",
    commandLabel: "터미널에서 설치하려면",
    commandBody:
      "패키지를 설치하고 Claude Code에 등록합니다. 이어서 안내서에 따라 Vite 플러그인과 오버레이를 추가하세요.",
    copyCommand: "명령어 복사",
    copied: "복사됨",
    failed: "클립보드를 사용할 수 없습니다. 텍스트를 선택해 복사하세요.",
    guide: "설정 안내서",
  },
  footer: { license: "MIT 라이선스", author: "만든 사람 Paul B. Kim" },
  notFound: {
    title: "페이지를 찾을 수 없습니다.",
    body: "존재하지 않는 페이지입니다.",
    home: "pk-annotator로 돌아가기",
  },
};

export const CONTENT = { en, ko } satisfies Record<Locale, Content>;
