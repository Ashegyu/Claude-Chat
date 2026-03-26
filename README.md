# Claude Chat

Claude CLI를 GUI로 사용할 수 있는 Electron 기반 데스크톱 채팅 앱입니다. 마크다운 렌더링, 파일 첨부, 코드 리뷰, 서브에이전트 등 다양한 기능을 지원합니다.

## 필수 조건

### 1. Node.js 설치

[Node.js 공식 사이트](https://nodejs.org/)에서 LTS 버전을 다운로드하여 설치합니다.

설치 확인:

```bash
node --version   # v18 이상 권장
npm --version
```

### 2. Claude CLI 설치 및 로그인

이 앱은 [Claude CLI (Claude Code)](https://docs.anthropic.com/en/docs/claude-code)를 내부적으로 호출하여 동작합니다.

```bash
npm install -g @anthropic-ai/claude-code
```

설치 후 로그인:

```bash
claude login
```

브라우저가 열리면 Anthropic 계정으로 로그인을 완료하세요.

설치 확인:

```bash
claude --version
```

## 설치

### 인스톨러 (권장)

[Releases](../../releases) 페이지에서 `Claude Chat Setup x.x.x.exe`를 다운로드하여 실행합니다.

### 소스에서 빌드

```bash
git clone <repository-url>
cd "Claude Chat"
npm install
npm run build
```

`dist/Claude Chat Setup x.x.x.exe` 인스톨러가 생성됩니다.

포터블 빌드(설치 없이 실행 가능):

```bash
npm run build:portable
```

### 개발 모드 실행

```bash
npm install   # 최초 1회
npm start
```

## 빌드 요구사항

| 도구 | 최소 버전 | 용도 |
|------|----------|------|
| Node.js | 18+ | 런타임 및 npm |
| npm | 9+ | 패키지 관리 |
| Git | 2.x | 소스 클론 및 git 연동 |
| Windows | 10+ | 빌드 대상 OS |

추가 의존성은 `npm install` 시 자동으로 설치됩니다 (Electron, electron-builder 등).

## 사용 방법

### 기본 사용

1. 앱을 실행하면 환영 화면이 표시됩니다
2. 하단 입력창에 질문이나 요청을 입력하고 **Enter**로 전송합니다
3. Claude가 스트리밍으로 응답하며, 마크다운/코드가 실시간 렌더링됩니다
4. 응답 중 **Stop** 버튼 또는 **Esc**로 중단할 수 있습니다

### 키보드 단축키

| 단축키 | 동작 |
|--------|------|
| `Enter` | 메시지 전송 |
| `Shift + Enter` | 줄바꿈 |
| `Esc` | 스트리밍 중단 / 메뉴 닫기 |
| `Ctrl + N` | 새 대화 |
| `Ctrl + P` | 새 프로젝트 열기 |
| `Ctrl + B` | 사이드바 토글 |
| `Ctrl + L` | 입력창 포커스 |

### 파일 첨부

입력창 옆 **첨부** 버튼으로 파일을 추가할 수 있습니다.

- 이미지: PNG, JPG, GIF, WebP, SVG 등 (20MB 이하)
- PDF (10MB 이하)
- 문서: DOC, DOCX, XLS, XLSX, PPT 등
- 텍스트 파일 (180KB 이하)
- 압축 파일: ZIP, TAR, 7Z 등

또는 입력창에 `@파일경로`를 입력하여 파일 내용을 직접 불러올 수 있습니다.

### 슬래시 명령어

입력창에 `/`를 입력하면 사용 가능한 명령어 목록이 표시됩니다.

| 명령어 | 설명 |
|--------|------|
| `/model [이름]` | 모델 변경 (opus, sonnet, haiku 등) |
| `/reasoning [low\|medium\|high\|max]` | 추론 수준 설정 |
| `/sandbox [모드]` | 샌드박스 모드 변경 |
| `/review` | 커밋되지 않은 변경사항 코드 리뷰 |
| `/search [쿼리]` | 웹 검색 활성화 질문 |
| `/file [경로]` | 파일 내용 불러오기 |
| `/compress` | 대화 컨텍스트 압축 |
| `/clear` | 현재 대화 초기화 |
| `/resume [세션ID]` | 이전 세션 이어하기 |
| `/usage` | 토큰 사용량 확인 |
| `/help` | 전체 명령어 목록 |

### 프로젝트 관리

- **사이드바**에서 프로젝트(작업 디렉토리)별로 대화를 관리합니다
- `Ctrl + N`으로 새 프로젝트 폴더를 열 수 있습니다
- 각 프로젝트 아래에 여러 대화를 생성하고 전환할 수 있습니다

### 승인 정책

Claude가 파일 수정이나 명령 실행을 요청할 때 승인 정책에 따라 동작합니다.

| 정책 | 동작 |
|------|------|
| 기본(default) | 매번 확인 요청 |
| 편집 허용(acceptEdits) | 파일 편집 자동 승인 |
| 자동(auto) | 안전한 작업 자동 승인 |
| 전체 허용(bypassPermissions) | 모든 작업 자동 승인 |
| 계획만(plan) | 계획만 표시, 실행 안 함 |

하단 상태바에서 현재 정책을 확인하고 변경할 수 있습니다.

### 서브에이전트

`/subagent [이름] [프롬프트]` 또는 `/auto-agent [작업설명]`으로 병렬 에이전트를 생성하여 작업을 분배할 수 있습니다.

### Git 연동

입력창 옆 **커밋** 버튼으로 AI가 생성한 커밋 메시지와 함께 변경사항을 커밋할 수 있습니다. `/review` 명령어로 코드 리뷰도 가능합니다.

## 라이선스

MIT
