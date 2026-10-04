# pk-annotator

실행 중인 앱에서 바꿀 곳을 가리키고 원하는 변경을 적으면, 코딩 에이전트가 그 요청을 근거와 함께 받습니다. 근거에는 소스 파일과 줄 번호, 선택자, 스크린샷, 콘솔, 네트워크, 녹화, 성능 정보가 들어갑니다.

[웹사이트](https://pk-annotator.paulbkim.dev/ko/) · [English](README.md) · MIT

pk-annotator는 Vite와 React 앱을 위한 개발 전용 오버레이입니다. 개발 빌드를 검토하는 사람은 누구나 요소를 선택하거나, 그리거나, 스크린샷을 찍거나, 녹화한 뒤 요청을 적어 보낼 수 있습니다. 주석은 로컬 파일 저장소에 저장되고, Claude Code, Codex, Pi가 함께 들어 있는 `pka-mcp` 서버로 읽습니다. 에이전트의 답변은 페이지에 표시됩니다. 프로덕션 빌드에는 아무것도 포함되지 않습니다. 오버레이가 닫혀 있는 동안에도 페이지는 크기가 제한된 콘솔, 오류, 네트워크 수집을 유지하고, 이 탭에서 주석을 보낸 뒤에는 그 상태와 답변을 따라갑니다. 오버레이 UI와 성능 관찰자는 사용할 때 불러옵니다.

## 설치

Node 24 이상, Vite 8, React 19가 필요합니다. Yarn 2 이상에서는 `.yarnrc.yml`에 `nodeLinker: node-modules`도 필요하며, Plug’n’Play는 지원하지 않습니다.

**에이전트에게 맡기기.** 프로젝트 루트에서 Claude Code, Codex, Pi에 다음을 붙여 넣으세요.

```text
https://pk-annotator.paulbkim.dev/agents.md 를 따라 이 프로젝트에 pk-annotator를 설정해 줘
```

**설치 스크립트 실행.** 프로젝트 루트에서 실행하면 사용 중인 패키지 매니저로 개발 의존성을 추가하고, `claude`가 설치되어 있으면 Claude Code에 `pka-mcp`를 등록합니다.

```sh
curl -fsSL https://pk-annotator.paulbkim.dev/install.sh | sh
```

그다음 아래처럼 플러그인을 추가하고 오버레이를 마운트하세요. 직접 설치하려면 워크스페이스 루트에서 `pnpm add -D pk-annotator`(또는 npm, Yarn, Bun의 같은 명령)를 실행합니다.

## 설정

```ts
// vite.config.ts
import { annotator } from "pk-annotator/vite";

export default defineConfig({
  plugins: [...annotator()],
});
```

```tsx
// 클라이언트 진입점, React 렌더링 전
let rootOptions = {};
if (import.meta.env.DEV) {
  try {
    const { mount } = await import("pk-annotator/overlay");
    rootOptions = mount({ hot: import.meta.hot!, theme: "system" }).reactRootOptions;
  } catch (cause) {
    console.error("pk-annotator did not load; the page runs without it", cause);
  }
}
createRoot(document.getElementById("root")!, rootOptions).render(<App />);
// 또는: hydrateRoot(document, <App />, rootOptions);
```

개발 서버를 시작하고 런처 버튼이나 Alt+Shift+A로 오버레이를 엽니다. 페이지에 Content-Security-Policy가 있다면 스크린샷을 위해 `img-src data: blob:`을 허용하세요.

## 에이전트 연결

오버레이 메뉴에서 **에이전트에 연결하기**를 고르세요. 이 페이지에 맞는 `pka-mcp` 명령이 담긴 요청이 복사되니, 에이전트 세션에 붙여 넣으면 됩니다. 프로젝트 루트에서 직접 등록하려면 다음을 실행합니다.

```sh
claude mcp add pka --scope project -- node_modules/.bin/pka-mcp      # Claude Code, .mcp.json
codex mcp add pka -- "$PWD/node_modules/.bin/pka-mcp" --root "$PWD"  # Codex, 전역 설정
```

Codex는 서버를 전역 설정에 저장하므로 이 항목은 한 프로젝트만 가리킵니다. `~/.codex/config.toml`의 `[mcp_servers.pka]`에 `tool_timeout_sec = 1830`도 설정하세요. 기본값 300초에서는 긴 `wait_for_annotation`이 중간에 끊깁니다. Pi는 `.pi/mcp.json`에 `{ "mcpServers": { "pka": { "command": "node_modules/.bin/pka-mcp", "exposure": "direct" } } }`를 추가합니다.

에이전트는 `wait_for_annotation`으로 기다리고, 보낸 주석을 `set_status`로 맡고, `reply`로 답하고, `get_errors`로 페이지 오류를 읽습니다. 연결되어 있는 동안 오버레이는 Claude나 Codex의 모습으로 바뀝니다.

Claude Code에서는 주석을 보내는 즉시 세션에 나타나게 할 수도 있습니다. pka를 채널로 불러와 Claude Code를 시작하고 확인 화면에서 승인하세요.

```sh
claude --dangerously-load-development-channels server:pka
```

채널은 Claude Code의 리서치 프리뷰 기능이며, Team과 Enterprise 조직은 먼저 채널을 허용해야 합니다. 세션을 시작하기 전부터 기다리던 주석은 보내지 않고 개수만 알려 줍니다.

## 사용

| 그룹      | 도구                                        |
| --------- | ------------------------------------------- |
| 요소 선택 | 선택(Shift로 여러 개), 영역 선택, 올가미    |
| 캡처      | 스크린샷과 자르기, 영역 녹화(GIF 또는 WebM) |
| 그리기    | 자유 그리기, 사각형, 원                     |
| 디버그    | 콘솔, 네트워크, 성능                        |
| 설정      | 기록, English/한국어, 종료                  |

요소 선택과 캡처 도구는 요청 편집기를 열고, 그리기를 마치면 스크린샷 주석으로 쌓여 함께 보낼 수 있습니다. 바로 보내거나, 주석을 저장해 두었다가 한 번에 보낼 수 있습니다. 본문의 요소와 캡처 배지는 에이전트에게 `[element n]`, `[attachment n: label]` 참조로 전달됩니다. 연결된 에이전트가 없으면 보내기는 주석을 마크다운으로도 복사합니다.

## CLI

```text
pka list | get <id> | watch --once | status <id> <state> | reply <id> <text> | errors | prune | lab
```

모든 명령은 `--json`과 `--root DIR`를 받습니다. 옵션은 `pka --help`로 확인하세요. `pka lab`은 녹화를 프로덕션 빌드에 다시 재생해 성능 판정을 기록하며 Playwright가 필요합니다.

## 더 보기

- [Reference](docs/REFERENCE.md): 플러그인 옵션, 테마, 저장소 위치, 작업 맡기(claim), CLI 상세 (영문)
- [Design](docs/DESIGN.md): 동작, 리소스 예산, 보안 계약 (영문)
- [Developing](docs/DEVELOPING.md): pk-annotator 자체 개발 (영문)
