## 2026-07-01 — 민원 초안 생성 화면 대규모 개편

### 변경 목적
1. API Key 오류 수정, 2. 캔버스 픽셀 에이전트 애니메이션, 3. 민원 초안 3건 각각 별도 카드, 4. 에러 내성 강화

### 수정 파일

**`server/src/minjeon/openrouterClient.ts`**
- `getApiKey()` — `{ apiKey: "..." }` AND `{ "OPENROUTER_API_KEY": "..." }` 두 JSON 형식 모두 지원
- 오류 메시지 한국어로 친절하게 변경

**`server/src/minjeon/complaintWorkflow.ts`**
- `emitStageComplete` — `extra?: Record<string, unknown>` 파라미터 추가
- 민원분류(classify) 단계 완료 시 `{ category: complaintType }` 이벤트에 포함

**`webview-ui/src/components/MinjeonPanel.tsx`** — 전면 재작성
- **`ComplaintJob`** 타입: id, title, content, status, currentStageId, result.{category, finalDraft}, error
- **`CanvasWorkerOverlay`**: 캔버스 영역(right: 460, bottom: 56) 위에 CSS 픽셀 아트 인물 표시
  - 3가지 색상(accent/green/orange)으로 구분
  - 'pending' → opacity 0 (off-screen), 'processing' → entry 위치 → desk 위치 (CSS transition 1.4s)
  - 1.3초 후 `enteredChars` Set에 추가 → 책상으로 이동
  - 단계별 위치: classify/search/write/integrate → desk, review → 회의 테이블, done → 소파
- **`FinalDraftCard`**: 처리 완료된 민원 초안 카드 (status-success 테두리, 분류 정보 포함, 복사/펼치기 버튼)
  - 3건이면 3개 SEPARATE 카드로 표시 (절대 합치지 않음)
- **에이전트 현황 리스트**: 각 민원별 색상 마커 + 제목 + 현재 단계 표시
- **에러 내성**: 1건 실패해도 다음 건 계속 처리, 실패한 건만 error 카드로 표시
- 직접 입력 탭도 동일한 ComplaintJob 흐름 사용 (단일 job id=-1)

**`webview-ui/src/index.css`**
- `.minjeon-worker`, `.minjeon-worker-head/body/legs/leg` — 20px × 36px 픽셀 아트 캐릭터
- `.minjeon-worker--entering` — 다리 흔들기 (leg-swing 재사용)
- `.minjeon-worker--working` — 상하 bob 애니메이션
- `.minjeon-worker--reviewing` — 좌우 기울기 (lean)
- `.minjeon-worker--resting` — 느린 좌우 흔들기 (sway)

### 실행 방법
```bash
node dist/cli.mjs --provider openrouter
# http://localhost:3100 → "민원 초안" → 민원 3건 선택 → "선택된 3건 처리 시작"
```

### 빌드 결과
- `npm run compile` exit code 0 ✓

---

## 2026-06-26 11:00

### 변경 목적
민원 초안 생성 기능 확장: 에이전트 출퇴근 애니메이션 + 엑셀 3건 배치 처리

### 추가/수정 파일

**신규 파일**
- `server/src/minjeon/excelReader.ts` — xlsx 파싱 + 샘플 폴백 (파일 없으면 3건 샘플 자동 사용)
- `data/.gitkeep` — `data/complaints.xlsx` 위치 표시용

**수정 파일**
- `package.json` — `xlsx ^0.18.5` 의존성 추가 (esbuild가 dist/cli에 번들링)
- `server/src/httpServer.ts` — `POST /api/minjeon/excel-samples` SSE 엔드포인트 추가
- `webview-ui/src/components/MinjeonPanel.tsx` — 전면 개편 (모드 탭 / 스테이지 레인 / 에이전트 칩 / 배치 카드)
- `webview-ui/src/index.css` — CSS 키프레임 애니메이션 6종 추가

### 주요 변경 내용

**엑셀 읽기 (`excelReader.ts`)**
- `xlsx` npm 패키지로 `.xlsx` 파싱
- 컬럼명 유연 매칭: title/제목/민원제목/subject + content/내용/민원내용/body/description
- 파일 없거나 컬럼 못 찾으면 샘플 3건 자동 사용 (usingSample 플래그로 UI에 표시)
- 항상 최대 3건만 반환 (비용 제어)

**배치 엔드포인트 (`/api/minjeon/excel-samples`)**
- SSE 스트림으로 민원 3건을 순차 처리
- 각 파이프라인 이벤트에 `complaintIndex` 필드 추가
- batch_start / complaint_start / complaint_complete / complaint_error / batch_complete 이벤트

**UI 개편 (`MinjeonPanel.tsx`)**
- 탭 전환: 직접 입력 ↔ 엑셀 3건
- 스테이지 레인: 각 단계를 카드 레이아웃으로 표시, 에이전트 칩이 레인 안에 배치
- 에이전트 칩 (AgentChip): 상태별 시각 표시 (대기/작업중/완료/오류)
- 배치 상태 카드 3개: 각 민원의 독립 진행 상태 + 초안 결과

**CSS 애니메이션 (`index.css`)**
- `minjeon-lane-in`: 스테이지 레인 등장 (위에서 내려오기)
- `minjeon-agent-in`: 에이전트 카드 등장 (왼쪽에서 슬라이드) + `animation-delay`로 단계 차이
- `minjeon-agent-pulse`: 작업 중 에이전트 — 보라 테두리 펄스
- `minjeon-agent-leave`: 완료 에이전트 — 오른쪽으로 페이드아웃

### 실행 방법

```bash
# 빌드
npm run compile

# 서버 실행
node dist/cli.mjs --provider openrouter

# 브라우저에서 http://localhost:3100
# 하단 "민원 초안" 버튼 → "엑셀 3건" 탭 → "엑셀 민원 3건 불러오기"

# 엑셀 파일 사용 시
# data/complaints.xlsx 에 제목/내용 컬럼 포함 파일 배치
# 없으면 내장 샘플 3건으로 자동 실행
```

### 빌드 결과
- `npm run compile` exit code 0 ✓
- TypeScript, ESLint, esbuild, Vite 모두 통과

---

## 2026-06-26 09:30

### 빌드 수정 (ESLint 에러)
- `openrouter-agent.ts`: `import * as child_process` → `import { execSync }` (naming-convention)
- `openrouter-agent.ts`: `sessionId` 타입 명시 (`let sessionId: string`)
- 여러 파일 import 정렬 자동 수정 (`eslint --fix`)
- 결과: `npm run compile` 전체 통과 ✓

---

## 2026-06-26 09:00

### 변경 목적
민원 초안 생성 병렬 Multi-Agent 기능 추가 (standalone 모드 전용)

### 추가/수정 파일

**신규 파일 (서버 — 역할 분리)**
- `server/src/minjeon/openrouterClient.ts` — OpenRouter HTTP 클라이언트 (API key 조회 + chat completions 호출)
- `server/src/minjeon/modelConfig.ts` — 에이전트 정의 (5단계 × 에이전트 목록, 사용 모델)
- `server/src/minjeon/localSearch.ts` — 로컬 지식 베이스 검색 (민원 유형 → 담당부서/법규/서류)
- `server/src/minjeon/complaintWorkflow.ts` — 파이프라인 오케스트레이터 (5단계 순차 + 단계 내 병렬)

**신규 파일 (UI)**
- `webview-ui/src/components/MinjeonPanel.tsx` — 풀스크린 오버레이 패널 (SSE 스트리밍, 실시간 업데이트)

**수정 파일**
- `server/src/httpServer.ts` — `POST /api/minjeon` SSE 엔드포인트 추가
- `webview-ui/src/App.tsx` — `isMinjeonOpen` 상태 + `MinjeonPanel` 렌더링
- `webview-ui/src/components/BottomToolbar.tsx` — "민원 초안" 버튼 (standalone 모드에서만 표시)

### 에이전트 구성

| 단계 | 에이전트 | 모델 | 실행 |
|------|---------|------|------|
| Stage 1: 민원분류 | 분류-A | google/gemma-4-31b-it | 병렬 |
| | 분류-B | microsoft/phi-4 | 병렬 |
| | 분류-C | mistralai/mistral-small-3.2-24b-instruct | 병렬 |
| Stage 2: 검색 | 검색 | (로컬) | 즉시 |
| Stage 3: 작성 | 공식 초안 | nvidia/nemotron-3-super-120b-a12b | 병렬 |
| | 문제 강조 | meta-llama/llama-4-maverick | 병렬 |
| | 간결 초안 | qwen/qwen3.5-plus-02-15 | 병렬 |
| Stage 4: 검수 | 정중성 검수 | google/gemini-2.5-flash | 병렬 |
| | 개인정보 검수 | microsoft/phi-4 | 병렬 |
| | 요청 명확성 | mistralai/mistral-small-3.2-24b-instruct | 병렬 |
| | 과장 표현 | google/gemma-4-31b-it | 병렬 |
| Stage 5: 최종 통합 | 통합 | nvidia/nemotron-3-super-120b-a12b | 순차 |

### 실행 방법

```bash
# 1) API key 확인 (이미 ~/.pixel-agents/openrouter.json 에 저장되어 있음)
# 2) 빌드 (필요 시)
npm run compile

# 3) 서버 실행
npx pixel-agents --provider openrouter
# 또는
node dist/cli.js --provider openrouter

# 4) 브라우저에서 접속
# http://localhost:3100
# 하단 툴바 "민원 초안" 버튼 클릭
```

### 테스트 방법

```bash
# 서버 실행 상태에서 직접 API 호출 (curl, SSE 확인)
curl -N -X POST http://localhost:3100/api/minjeon \
  -H "Content-Type: application/json" \
  -d '{"title":"아파트 인근 공사 소음 민원","content":"야간 공사로 인한 수면 방해가 심합니다."}'

# 예상 SSE 스트림:
# data: {"type":"pipeline_start","stages":["민원분류","검색","작성","검수","최종 통합"]}
# data: {"type":"stage_start","stageId":"classify","stage":"민원분류","agents":[...]}
# data: {"type":"agent_start","stageId":"classify","agent":"분류-A","model":"google/gemma-4-31b-it"}
# data: {"type":"agent_result",...,"result":"환경/소음"}
# ... (각 에이전트 완료 시 실시간 스트리밍)
# data: {"type":"final_draft","draft":"...최종 민원서..."}
# data: {"type":"pipeline_complete"}
```

### 비고
- VS Code 확장 모드에서는 "민원 초안" 버튼이 숨겨짐 (webview CSP 제한으로 fetch 불가)
- Node 18+ native fetch 사용 (외부 패키지 추가 없음)
- esbuild 변경 없음 (minjeon/ 모듈은 cli.ts 번들에 자동 포함)
- AsyncAPI 프로토콜 변경 없음 (기존 WebSocket과 독립된 REST/SSE 채널)
