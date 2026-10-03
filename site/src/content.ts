export type Locale = "en" | "ko";

export const SITE = "https://pk-annotator.paulbkim.dev";
export const INSTALL_COMMAND = `curl -fsSL ${SITE}/install.sh | sh`;
export const VERSION = "0.6.0";

const en = {
  lang: "en",
  path: "/",
  title: "pk-annotator: redline the running app",
  description:
    "Point at your running app, say what should change, and your coding agent gets the request with the source line, screenshot, console, and network. A dev-only overlay for Vite and React with its own MCP server.",
  skip: "Skip to content",
  nav: { detail: "Detail", hub: "Hub", flow: "Flow", notes: "Notes", install: "Install" },
  otherLanguage: { label: "한국어", href: "/ko/", lang: "ko" },
  hero: {
    title: "Redline the running app.",
    lead: "Point at what should change, say it in a sentence, press Send. Your coding agent gets the request with the source line, screenshot, console, and network, and answers on the page.",
    install: "Install",
    askAgent: "Or ask your agent",
    agentPrompt: `Set up pk-annotator in this project by following ${SITE}/agents.md`,
    requirements: "Vite 8 · React 19 · Node 24 · MIT · dev only",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Select and copy",
  },
  block: {
    project: "Project",
    drawing: "Drawing",
    drawingValue: "Redline the running app",
    sheet: "Sheet",
    rev: "Rev",
    date: "Date",
    by: "Drawn by",
  },
  demo: {
    label: "Illustration",
    url: "localhost:5173/settings/billing",
    heading: "Billing",
    card: "Card",
    email: "Invoice email",
    cancel: "Cancel",
    save: "Save changes",
    note: ["make Save the", "primary action"],
    reply: "Save is now the primary button.",
    revisions: "Revisions",
    replay: "Replay",
    columns: ["Rev", "Description", "By", "Status"],
    description: "Make Save the primary action",
    statuses: { pending: "pending", acknowledged: "acknowledged", resolved: "resolved" },
  },
  detail: {
    sheetTitle: "Detail A · An annotation, exploded",
    title: "What travels with a request",
    intro:
      "A sentence alone leaves an agent guessing where to look. Each annotation carries what you were looking at, so the agent starts in the right file.",
    columns: ["Item", "Part", "What the agent gets", "File"],
    parts: [
      [
        "Prompt",
        "Your words, with [element n] and [attachment n] where you placed them",
        "annotation.json",
      ],
      [
        "Element",
        "Call site file:line:col, owner components, role and name, selector, trimmed HTML",
        "annotation.json",
      ],
      [
        "Screenshot",
        "The viewport or a cropped area, with your drawing flattened in",
        "capture/attachments/n/",
      ],
      ["Console", "Errors grouped, with stacks mapped back to source", "errors.json"],
      ["Network", "Requests, status, and timing; bodies only for paths you allow", "network.jsonl"],
      ["Recording", "An area as GIF or WebM, with keyframes and a timeline", "manifest.json"],
      ["Performance", "Web Vitals attribution, long animation frames, slow requests", "summary.md"],
    ],
    received: "What the agent receives",
  },
  hub: {
    sheetTitle: "Plan · Hub and radial menu",
    title: "One button in the corner",
    intro:
      "The hub opens a radial menu of five groups. Each group runs the tool you used last; hover it to pick another. Alt+Shift+A brings the overlay back after you exit.",
    groups: [
      ["Pick", "Select, Box, Lasso"],
      ["Capture", "Screenshot, Record"],
      ["Annotate", "Freehand, Rectangle, Circle"],
      ["Debug", "Console, Network, Performance"],
      ["Settings", "History, Language, Exit"],
    ],
    offset: "20 px",
    agents:
      "When Claude Code or Codex connects, the hub takes on that agent's mark and color, and turns while the agent works on your request.",
  },
  flow: {
    sheetTitle: "Schematic · Browser to agent",
    title: "Reviewers stay in the browser",
    intro:
      "Designers, PMs, and QA review the dev build where the problem is visible. The developer's agent works in the repository. Annotations pass between them as files, and replies come back to the page.",
    nodes: [
      ["Overlay", "in the page"],
      ["Vite plugin", "dev server"],
      ["File store", "_interim/annotations"],
      ["pka-mcp", "stdio"],
      ["Agent", "Claude Code · Codex · Pi"],
    ],
    request: "annotation",
    reply: "reply",
    lifecycle: "Lifecycle",
    states: ["pending", "acknowledged", "resolved", "dismissed"],
    languages: "The overlay speaks English and Korean.",
  },
  notes: {
    sheetTitle: "General notes",
    title: "Costs nothing when you are not using it",
    items: [
      [
        "Development builds only.",
        "The plugin runs under vite dev, and production builds contain none of it.",
      ],
      [
        "Nothing runs while idle.",
        "There is no polling and no idle timer. The menu's UI loads the first time you open it.",
      ],
      [
        "Bounded memory and disk.",
        "Console, network, and recording buffers have fixed caps, and the store refuses new video above 500 MB.",
      ],
      [
        "Clean test runs.",
        "Nothing mounts when navigator.webdriver is true, so Playwright sees your page as it is.",
      ],
      [
        "Local files over stdio.",
        "Annotations are files in your workspace that pka-mcp reads over stdio, without an account, cloud service, or browser extension.",
      ],
      [
        "Page content is data.",
        "Text and request bodies from the page are kept apart from your prompt, and the agent is told not to follow them.",
      ],
    ],
    dimensions: [
      ["Production footprint", "0 B"],
      ["Idle timers", "0"],
      ["Store cap", "500 MB"],
    ],
  },
  install: {
    sheetTitle: "Issued for construction",
    title: "Set it up",
    steps: [
      {
        title: "Ask your agent",
        body: "Paste this into Claude Code, Codex, or Pi at the project root. The guide covers every step below.",
      },
      {
        title: "Or run the installer",
        body: "Adds the dev dependency with your package manager and registers pka-mcp with Claude Code.",
      },
      { title: "Add the plugin", body: "It runs only under vite dev." },
      {
        title: "Mount the overlay",
        body: "In the client entry, before React renders, in development only.",
      },
      {
        title: "Connect your agent",
        body: "Choose Connect agent in the overlay's menu and paste the copied prompt into your agent session.",
      },
    ],
    guide: "Agent guide",
    npm: "npm",
    reference: "README",
  },
  pick: {
    launcher: "Try marking this page",
    exit: "Stop marking",
    hint: "Click any element to mark it · Esc to stop",
    placeholder: "Describe the change…",
    save: "Save",
    marks: "Your marks",
    copyMarkdown: "Copy as Markdown",
    clear: "Clear",
    disclaimer: "Demo. No agent is connected to this site; marks stay in this tab.",
    element: "element",
  },
  footer: {
    license: "MIT License",
    madeBy: "Made by Paul B. Kim",
  },
  notFound: {
    title: "Sheet not found",
    body: "This drawing is not in the set.",
    home: "Back to sheet 1",
  },
};

export type Content = typeof en;

const ko: Content = {
  lang: "ko",
  path: "/ko/",
  title: "pk-annotator: 고칠 곳은 화면에서 바로 짚으세요",
  description:
    "실행 중인 앱에서 바꿀 곳을 가리키고 한 문장으로 적으면, 코딩 에이전트가 소스 위치, 스크린샷, 콘솔, 네트워크 정보와 함께 요청을 받습니다. MCP 서버가 함께 들어 있는 Vite·React용 개발 전용 오버레이입니다.",
  skip: "본문으로 건너뛰기",
  nav: { detail: "상세", hub: "허브", flow: "흐름", notes: "주의 사항", install: "설치" },
  otherLanguage: { label: "English", href: "/", lang: "en" },
  hero: {
    title: "고칠 곳은 화면에서 바로 짚으세요.",
    lead: "바꿀 곳을 가리키고, 한 문장으로 적고, 보내기를 누르세요. 코딩 에이전트는 소스 위치, 스크린샷, 콘솔, 네트워크 정보와 함께 요청을 받고 페이지에서 바로 답합니다.",
    install: "설치",
    askAgent: "또는 에이전트에게 맡기기",
    agentPrompt: `${SITE}/agents.md 를 따라 이 프로젝트에 pk-annotator를 설정해 줘`,
    requirements: "Vite 8 · React 19 · Node 24 · MIT · 개발 전용",
    copy: "복사",
    copied: "복사됨",
    copyFailed: "선택해서 복사하세요",
  },
  block: {
    project: "프로젝트",
    drawing: "도면명",
    drawingValue: "실행 중인 앱에 빨간 펜",
    sheet: "시트",
    rev: "개정",
    date: "날짜",
    by: "작성",
  },
  demo: {
    label: "예시 그림",
    url: "localhost:5173/settings/billing",
    heading: "결제",
    card: "카드",
    email: "청구서 이메일",
    cancel: "취소",
    save: "변경 사항 저장",
    note: ["저장을 주 버튼으로", "바꿔 주세요"],
    reply: "저장 버튼을 주 버튼으로 바꿨어요.",
    revisions: "개정 이력",
    replay: "다시 보기",
    columns: ["개정", "내용", "담당", "상태"],
    description: "저장 버튼을 주 버튼으로",
    statuses: { pending: "대기", acknowledged: "확인됨", resolved: "해결됨" },
  },
  detail: {
    sheetTitle: "상세 A · 주석 분해도",
    title: "요청과 함께 가는 것",
    intro:
      "문장 하나만으로는 에이전트가 어디를 봐야 할지 짐작해야 합니다. 주석에는 보고 있던 화면이 함께 담기므로, 에이전트는 맞는 파일에서 시작합니다.",
    columns: ["번호", "항목", "에이전트가 받는 것", "파일"],
    parts: [
      ["요청", "직접 쓴 문장과, 입력한 자리의 [element n]·[attachment n] 참조", "annotation.json"],
      [
        "요소",
        "호출 위치 file:line:col, 소유 컴포넌트, 역할과 이름, 선택자, 줄인 HTML",
        "annotation.json",
      ],
      ["스크린샷", "화면 전체나 자른 영역, 그린 표시까지 합친 이미지", "capture/attachments/n/"],
      ["콘솔", "묶은 오류와 소스로 되돌린 스택", "errors.json"],
      ["네트워크", "요청, 상태, 소요 시간. 본문은 허용한 경로만", "network.jsonl"],
      ["녹화", "영역의 GIF나 WebM, 키프레임과 타임라인", "manifest.json"],
      ["성능", "Web Vitals 원인 분석, 긴 애니메이션 프레임, 느린 요청", "summary.md"],
    ],
    received: "에이전트가 받는 내용",
  },
  hub: {
    sheetTitle: "평면도 · 허브와 원형 메뉴",
    title: "구석의 버튼 하나",
    intro:
      "허브를 누르면 다섯 그룹의 원형 메뉴가 열립니다. 그룹은 마지막에 쓴 도구를 바로 실행하고, 마우스를 올리면 다른 도구를 고를 수 있습니다. 종료한 뒤에는 Alt+Shift+A로 다시 엽니다.",
    groups: [
      ["요소 선택", "선택, 영역 선택, 올가미"],
      ["캡처", "스크린샷, 녹화"],
      ["그리기", "자유 그리기, 사각형, 원"],
      ["디버그", "콘솔, 네트워크, 성능"],
      ["설정", "기록, 언어, 종료"],
    ],
    offset: "20 px",
    agents:
      "Claude Code나 Codex가 연결되면 허브는 그 에이전트의 로고와 색으로 바뀌고, 요청을 처리하는 동안 돌아갑니다.",
  },
  flow: {
    sheetTitle: "계통도 · 브라우저에서 에이전트까지",
    title: "검토하는 사람은 브라우저에 머뭅니다",
    intro:
      "디자이너, PM, QA는 문제가 보이는 개발 빌드에서 검토합니다. 개발자의 에이전트는 저장소에서 일합니다. 그 사이에서 주석은 파일로 오가고, 답변은 페이지로 돌아옵니다.",
    nodes: [
      ["오버레이", "페이지 안"],
      ["Vite 플러그인", "개발 서버"],
      ["파일 저장소", "_interim/annotations"],
      ["pka-mcp", "stdio"],
      ["에이전트", "Claude Code · Codex · Pi"],
    ],
    request: "주석",
    reply: "답변",
    lifecycle: "처리 단계",
    states: ["대기", "확인됨", "해결됨", "닫힘"],
    languages: "오버레이는 한국어와 영어를 지원합니다.",
  },
  notes: {
    sheetTitle: "일반 주의 사항",
    title: "쓰지 않을 때는 아무 비용도 들지 않습니다",
    items: [
      [
        "개발 빌드에서만 동작합니다.",
        "플러그인은 vite dev에서만 실행되고, 프로덕션 빌드에는 들어가지 않습니다.",
      ],
      [
        "쉬는 동안에는 아무것도 돌지 않습니다.",
        "폴링이나 유휴 타이머가 없고, 메뉴 UI는 처음 열 때 불러옵니다.",
      ],
      [
        "메모리와 디스크 사용에 상한이 있습니다.",
        "콘솔, 네트워크, 녹화 버퍼는 크기가 정해져 있고, 저장소가 500 MB를 넘으면 새 영상을 받지 않습니다.",
      ],
      [
        "테스트 실행에 끼어들지 않습니다.",
        "navigator.webdriver가 true면 마운트하지 않으므로 Playwright는 원래 페이지를 그대로 봅니다.",
      ],
      [
        "로컬 파일과 stdio로 동작합니다.",
        "주석은 워크스페이스의 파일이고 pka-mcp가 stdio로 읽습니다. 계정, 클라우드 서비스, 브라우저 확장이 필요하지 않습니다.",
      ],
      [
        "페이지 내용은 데이터로 다룹니다.",
        "페이지의 텍스트와 요청 본문은 요청과 분리되고, 에이전트에게는 이를 따르지 말라고 알립니다.",
      ],
    ],
    dimensions: [
      ["프로덕션 용량", "0 B"],
      ["유휴 타이머", "0"],
      ["저장소 상한", "500 MB"],
    ],
  },
  install: {
    sheetTitle: "시공용 발행",
    title: "설치",
    steps: [
      {
        title: "에이전트에게 맡기기",
        body: "프로젝트 루트에서 Claude Code, Codex, Pi에 붙여 넣으세요. 아래 단계를 모두 안내합니다.",
      },
      {
        title: "또는 설치 스크립트",
        body: "사용 중인 패키지 매니저로 개발 의존성을 추가하고 Claude Code에 pka-mcp를 등록합니다.",
      },
      { title: "플러그인 추가", body: "vite dev에서만 동작합니다." },
      {
        title: "오버레이 마운트",
        body: "클라이언트 진입점에서, React 렌더링 전에, 개발 환경에서만.",
      },
      {
        title: "에이전트 연결",
        body: "오버레이 메뉴에서 에이전트에 연결하기를 누르고, 복사된 요청을 에이전트 세션에 붙여 넣으세요.",
      },
    ],
    guide: "에이전트 안내서",
    npm: "npm",
    reference: "README",
  },
  pick: {
    launcher: "이 페이지에 표시해 보기",
    exit: "표시 그만하기",
    hint: "요소를 클릭해 표시하세요 · Esc로 종료",
    placeholder: "무엇을 바꿀지 적어 주세요…",
    save: "저장",
    marks: "내 표시",
    copyMarkdown: "마크다운으로 복사",
    clear: "지우기",
    disclaimer:
      "데모입니다. 이 사이트에는 에이전트가 연결되어 있지 않고, 표시는 이 탭에만 남습니다.",
    element: "요소",
  },
  footer: {
    license: "MIT 라이선스",
    madeBy: "만든 사람 Paul B. Kim",
  },
  notFound: {
    title: "없는 시트입니다",
    body: "이 도면은 도면 세트에 없습니다.",
    home: "1번 시트로",
  },
};

export const CONTENT = { en, ko } satisfies Record<Locale, Content>;
