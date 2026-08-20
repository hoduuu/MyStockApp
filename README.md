# mystock — Phase 0 수집기

개인 투자 비서 앱의 뉴스 수집·사건 합성 파이프라인. 설계 배경은 [`docs/DESIGN.md`](docs/DESIGN.md).

**기본 설정으로는 돈이 들지 않습니다.** 뉴스는 무료 RSS, 임베딩은 로컬 모델, 사건 요약은 mock입니다.
API 키도, 가입도, 서버도 필요 없습니다. 유료 API는 나중에 `--provider anthropic` 하나로 켜집니다.

**이건 버리는 프로토타입이 아닙니다.** 이 CLI가 그대로 작업 스케줄러가 호출할 헤드리스 수집기이고,
나중에 배포로 갈 때 서버에 올라갈 공용 층입니다 (설계서 §0.5). 그래서 UI도 사용자 개념도 모릅니다.

## 무료인 것과 돈이 드는 것

| 구성요소 | 무엇을 쓰나 | 비용 | 필요한 것 |
|---|---|---|---|
| 뉴스 수집 (영문) | Yahoo Finance RSS | **무료** | 없음 — 키도 가입도 불필요 |
| 뉴스 수집 (한글) | Google 뉴스 검색 RSS | **무료** | 자산에 한글명만 있으면 자동 |
| Stage 1 중복 제거 | 규칙 (URL 정규화·제목 Jaccard) | **무료** | 없음 |
| Stage 2 클러스터링 | 로컬 ONNX 임베딩 모델 | **무료** | 첫 실행 시 ~120MB 1회 다운로드 |
| Stage 3 사건 매칭 | 로컬 벡터 비교 | **무료** | 없음 |
| Stage 4 사건 합성 | **mock (기본값)** | **무료** | 없음 |
| 저장소 | SQLite 파일 1개 | **무료** | 없음 — 서버 아님, Node 내장 |
| 시세·환율·암호화폐 | Yahoo chart API | **무료** | 없음 — 키도 가입도 불필요 |
| 실적·CPI·FOMC 등 일정 | `mystock.config.json`의 `calendarEvents` (수동 입력) | **무료** | 직접 입력, 자동 수집 아님 — 아래 참조 |
| Stage 4 사건 합성 | `--provider anthropic` | **유료** | `ANTHROPIC_API_KEY` |

돈이 나가는 경로는 마지막 줄 하나뿐이고, 명시적으로 켜야만 동작합니다.
`mystock cost`는 mock 실행도 $0으로 기록하므로, 유료로 바꿨을 때 얼마가 될지 미리 가늠할 수 있습니다.

## Phase 0의 목표

> **뉴스 30개 → 사건 3개가 실제로 되는가?**

이게 안 되면 나머지는 의미가 없습니다. 2주간 매일 돌려보고 눈으로 검증하는 게 이 단계의 본체입니다.
검증 항목 7가지는 설계서 §15 Phase 0에 있습니다.

## 시작하기

```bash
npm install
cp mystock.config.example.json mystock.config.json   # 관심자산 편집
```

API 키는 필요 없습니다. 첫 실행은 임베딩 모델(~120MB)을 `./.cache`로 내려받습니다.
이후에는 오프라인으로 동작합니다.

```bash
# 수집 → 사건 정리. mock 요약이라 무료.
npm run mystock -- collect

# 쌓인 사건 읽기 — 기본은 "마지막으로 본 이후"
npm run mystock -- brief

# 사건 기록장. 중요도 하한 없이, 종료된 사건까지 전부
npm run mystock -- timeline --asset NVDA --days 30

# 지수·환율·암호화폐 시세 수집
npm run mystock -- market

# calendarEvents(실적·CPI·FOMC 등, 전부 수동 입력) 동기화 — 네트워크 안 씀
npm run mystock -- calendar

# 같은 내용을 브라우저에서 (설계서 §12의 UI 안)
npm run mystock -- brief --window 7d --html
start brief.html

# Stage 4 자체를 건너뛰고 Stage 1~3만 — 임계값 튜닝용
npm run mystock -- collect --dry-run

# 무엇이 무엇과 묶였는지 보기. 임계값을 만질 때는 개수가 아니라 구성을 봐야 한다
npm run mystock -- collect --fixture fixtures/nvda-sample.xml --dry-run --verbose --db tune.db

# 비용 확인
npm run mystock -- cost
```

네트워크 없이 파이프라인만 보려면 픽스처를 씁니다:

```bash
npm run mystock -- collect --fixture fixtures/nvda-sample.xml
```

### 나중에, 실제 AI를 붙일 때

Phase 0에서 파이프라인이 검증되고 "이제 진짜 요약 품질을 보고 싶다" 싶을 때만:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm run mystock -- collect --provider anthropic
```

`mystock.config.json`의 `aiProvider`를 `"anthropic"`으로 바꿔도 됩니다.
같은 입력으로 두 모델을 비교하려면 `compare --model a,b` (유료).

## 파이프라인

```
RSS 16건
  ↓ Stage 1  규칙 기반          URL 정규화 · 제목 Jaccard · 잡음 패턴   (무료)
    5건
  ↓ Stage 2  임베딩 클러스터링   로컬 ONNX 다국어 모델                  (무료)
    클러스터 4개
  ↓ Stage 3  기존 사건 매칭      후속이면 여기서 끝                      (무료)
    신규 후보 N개
  ↓ Stage 4  사건 합성          mock(무료) 또는 anthropic(유료)         ← 여기만 선택
    사건
```

Stage 1~3이 하는 일은 전부 **Stage 4에 도달하는 양을 줄이는 것**입니다.
후속 보도는 Stage 3에서 걸러져 Stage 4를 아예 안 거칩니다.

### mock이 하는 일과 하지 않는 일

`--provider mock`은 키워드 규칙과 클러스터 모양(기사 수·출처 다양성)으로 중요도를 매기고,
사건 요약을 **기사에 실제로 있는 필드만 조립해서** 만듭니다.

산문을 쓰지 않습니다. 숫자도, 원인도, 평가도 만들어내지 않습니다.
그럴듯한 가짜 분석을 뱉는 mock은 "파이프라인이 되는가"에 대해 잘못된 확신을 주기 때문입니다.

mock으로 검증할 수 있는 것: 사건 테이블, 후속 매칭, 사건 기록장, 빈 상태 4종, 브리핑 레이아웃, 나중의 UI 전부.
mock으로 검증할 수 없는 것: 요약 문장의 품질. 그건 유료로 바꿔야만 알 수 있고, 그때 바꾸면 됩니다.

mock이 만든 사건은 DB의 `events.provider = 'mock'`으로 남고, 브리핑에서 `[샘플]`로 표시됩니다.
샘플 텍스트가 실제 분석인 척하면 이 앱의 유일한 가치인 신뢰가 깨지기 때문입니다.

## 데스크탑 앱으로 보기 (Electron)

`brief.html`을 브라우저 대신 진짜 창(윈도우)으로 띄웁니다. **1단계일 뿐입니다** — 이 창은
지금 `brief --html`이 만드는 화면을 그대로 보여주기만 하고, 데이터 수집·수정 기능은 없습니다.

```powershell
npm install       # electron 처음 설치
npm run build      # dist/src/cli.js 를 만든다 — 창이 이걸 실행해서 화면을 갱신한다
npm run electron
```

**메뉴 → 보기 → 새로고침** (또는 `Ctrl+R`)을 누르면 CLI의 `brief --html`을 다시 실행해서
최신 사건·시세로 갱신합니다. 뉴스 수집(`collect`)과 시세 수집(`market`)은 여전히 따로,
또는 작업 스케줄러로 돌립니다 — 이 창은 수집기가 아니라 뷰어입니다.

**왜 이렇게 만들었는지:** Electron은 자체 Node 버전을 내장하는데, 지금 코드가 쓰는
`node:sqlite`(실험적 기능)를 그 버전이 지원하는지는 이 환경에서 미리 확인할 수 없었습니다.
그래서 Electron 창은 DB를 직접 열지 않고, 이미 검증된 시스템 `node`로 기존 CLI를
그대로 실행시켜 결과 파일만 읽습니다 — Electron의 역할은 "보여주고 새로고침 버튼을
누르면 다시 실행하는 것"뿐입니다.

이 방식이 로컬에서 실제로 문제없이 열리는지 확인해주세요. 창이 안 뜨거나 에러가 나면
메시지 그대로 알려주시면 원인을 봐드리겠습니다.

### 설정 화면 (시장 항목 켜고 끄기, 관심자산 추가)

"보여주고 새로고침만 하는 뷰어"라는 원칙에 예외가 하나 생겼습니다 — `mystock.config.json`을
실제로 고치는 유일한 경로입니다. 홈 화면의 시장 톱니바퀴 아이콘, 관심자산 + 버튼을 누르면
설정 화면(`#settings`)으로 이동하고, 여기서:

- 시장 항목 체크박스를 켜고 끄면 즉시 `config.json`에 저장되고 화면이 새로고침됩니다.
- 종목 코드·이름을 입력해서 관심자산을 추가하면 마찬가지로 저장되고, 다음 `collect`/`market`
  실행부터 자동으로 수집 대상에 들어갑니다.

**보안 구조:** Electron 창은 `contextIsolation: true, nodeIntegration: false`(파일 시스템에
직접 접근 못 함)를 그대로 유지합니다. `electron/preload.cjs`가 `toggleInstrument`/`addAsset`
딱 두 가지 동작만 `window.mystock`으로 좁게 열어주고, 실제 파일 읽기/쓰기는 `electron/main.js`의
IPC 핸들러에서만 일어납니다. 저장 로직 자체(`src/config-edit.ts`)는 순수 함수라 Electron 없이도
`npm test`로 검증됩니다 — main.js는 그 함수를 호출하고 파일에 쓰는 얇은 껍데기일 뿐입니다.

브라우저로 `brief.html`을 직접 열면 `window.mystock`이 없으니 체크박스·추가 버튼이
비활성화되고 안내 문구가 뜹니다 — 편집은 Electron 창에서만 됩니다.

**이 부분은 이 샌드박스에서 실제 Electron 창을 띄워 클릭까지 검증하지 못했습니다** (GUI가 없는
환경입니다). 저장 로직 자체는 단위 테스트로 검증했지만, 실제로 체크박스를 눌렀을 때 파일이
저장되고 화면이 새로고침되는지는 로컬에서 확인해주세요.

## 작업 스케줄러 등록 (Windows)

앱이 꺼져 있어도 수집이 돌아야 합니다. 이게 안 되면 "지난 일주일 요약"이 성립하지 않습니다
(설계서 §3 — 이 프로젝트의 가장 큰 구조적 함정).

**작업 디렉터리를 반드시 지정해야 합니다.** `mystock.config.json`, `mystock.db`, `.cache`가 전부
현재 디렉터리 기준이고, 작업 스케줄러는 프로젝트 폴더에서 시작하지 않습니다. 지정하지 않으면
설정을 못 찾아 기본값으로 엉뚱한 자산을 수집하고 DB를 다른 곳에 만듭니다.
(그래서 `schtasks` 대신 `-WorkingDirectory`를 받는 PowerShell cmdlet을 씁니다.)

뉴스(`collect`)와 시세(`market`)는 서로 다른 소스이고 실패 방식도 달라서, 스케줄러 작업도
따로 둔다 — 하나가 막혀도 다른 하나의 성공/실패를 가린다. `calendar`는 수동 입력을 DB에
반영만 하는 명령이라 네트워크를 안 쓰고, 설정을 바꿨을 때만 다시 돌리면 되므로 스케줄러에
넣지 않는다.

```powershell
npm run build   # dist/src/cli.js 생성

$dir      = "C:\projects\MyStockApp"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

# collect — 3시간마다. 미국 정규장 마감(한국 시간 이른 아침)이 자연히 포함됩니다.
$collectAction  = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "--disable-warning=ExperimentalWarning dist\src\cli.js collect" `
  -WorkingDirectory $dir
$collectTrigger = New-ScheduledTaskTrigger -Once -At 7am `
  -RepetitionInterval (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName "mystock collect" `
  -Action $collectAction -Trigger $collectTrigger -Settings $settings

# market — 1시간마다. 대시보드 숫자라 뉴스보다 더 자주 갱신할 값어치가 있다.
$marketAction  = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "--disable-warning=ExperimentalWarning dist\src\cli.js market" `
  -WorkingDirectory $dir
$marketTrigger = New-ScheduledTaskTrigger -Once -At 7am `
  -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "mystock market" `
  -Action $marketAction -Trigger $marketTrigger -Settings $settings
```

확인·관리:

```powershell
Start-ScheduledTask   -TaskName "mystock collect"   # 즉시 한 번 실행
Start-ScheduledTask   -TaskName "mystock market"
Get-ScheduledTaskInfo -TaskName "mystock collect"   # 마지막 실행 시각/결과
Get-ScheduledTaskInfo -TaskName "mystock market"
Unregister-ScheduledTask -TaskName "mystock collect"
Unregister-ScheduledTask -TaskName "mystock market"
```

스케줄러는 콘솔 출력을 보여주지 않으므로, 실제로 수집이 되고 있는지는 DB로 확인합니다:

```powershell
npm run mystock -- brief --window 7d
```

수집이 멈춰 있었다면 `brief`가 `⚠ ... 사이 뉴스를 수집하지 못했습니다`로 알려줍니다 —
이 앱이 조용한 것과 고장난 것을 구분하는 방식입니다.

## 설정

`mystock.config.json` (git에 올라가지 않습니다). 전부 Phase 0 튜닝 노브입니다:

| 항목 | 기본값 | 의미 |
|---|---|---|
| `aiProvider` | `mock` | Stage 4 백엔드. `mock`(무료) 또는 `anthropic`(유료) |
| `assets[].aliases` | — | **중요.** 기사가 이 자산에 대한 것인지 판정하는 근거. 아래 참조 |
| `market[]` | 지수 6 + 환율/코인 2 | 대시보드 항목. `enabled`로 켜고 끄고, 순서가 표시 순서 |
| `calendarEvents[]` | `[]` | 실적·CPI·FOMC 등 수동 입력 일정. 아래 참조 |
| `nearDuplicateThreshold` | 0.7 | 제목 토큰 Jaccard가 이 이상이면 같은 기사 |
| `clusterThreshold` | 0.95 | 코사인이 이 이상이면 같은 사건. **임베딩 모델을 바꾸면 반드시 재측정** |
| `eventMatchThreshold` | 0.75 | 이 이상이면 신규 사건이 아니라 후속 |
| `eventCloseDays` | 7 | 이만큼 후속이 없으면 사건 종료 |
| `maxArticleAgeDays` | 7 | 수집 대상 기간 |
| `model` | `claude-opus-5` | `aiProvider`가 `anthropic`일 때만 사용 |

### aliases를 제대로 채워야 하는 이유

Yahoo의 종목별 피드는 **그 종목에 대한 피드가 아닙니다.** DELL 피드 12건 중 Dell 이야기는
3~5건뿐이고 나머지는 Sandisk, Micron, Cisco 기사입니다. 잡음이 아니라 남의 회사 뉴스입니다.

Stage 1은 제목이나 리드에 **심볼·한글명·별칭 중 하나가 있는 기사만** 통과시킵니다.
별칭이 부실하면 진짜 기사를 놓치고, 비어 있으면 브리핑이 남의 회사로 채워집니다.

```json
{ "symbol": "DELL", "name": "델", "aliases": ["Dell", "Dell Technologies", "Alienware"] }
```

자회사·브랜드명(예: Dell의 `Alienware`)까지 넣어주세요. 뭘 놓치고 있는지는
`collect --verbose`의 `off_topic` 개수로 확인합니다.

### 예정 이벤트(캘린더)

**전부 수동 입력입니다** — 실적 발표일도, CPI·FOMC도. 처음엔 실적 발표일을 Yahoo에서
자동으로 받으려 했는데, 그 엔드포인트(`quoteSummary`)는 시세 API와 달리 별도 인증을
요구해서 401로 막혔습니다. 대신 애초에 CPI·FOMC에 적용했던 원칙 — "연 몇 번뿐인 일정은
손으로 넣는 게 정직한 자동화" — 을 실적 발표일에도 그대로 적용했습니다. 실적은 분기당
1번(연 4회)이라 FOMC(연 8회)보다도 드뭅니다.

`mystock.config.json`에 추가하세요:

```json
"calendarEvents": [
  { "id": "fomc-sep",  "kind": "fomc",     "title": "FOMC 금리 결정",
    "scheduledAt": "2026-09-17T22:00:00Z" },
  { "id": "cpi-aug",   "kind": "cpi",      "title": "미국 8월 CPI 발표",
    "scheduledAt": "2026-08-22T12:30:00Z" },
  { "id": "nvda-q2",   "kind": "earnings", "title": "NVDA 실적 발표", "assetSymbol": "NVDA",
    "scheduledAt": "2026-08-27T20:00:00Z",
    "consensus": { "epsAverage": 1.42 } }
]
```

- **`scheduledAt`은 UTC**입니다 (한국 시간 오전 8시 발표면 전날 23:00Z)
- **`id`가 같으면 갱신**되고 중복 생성되지 않습니다. 목록에서 지운다고 DB에서 지워지진
  않습니다 — 동기화는 추가/갱신만 합니다
- **`assetSymbol`은 실적처럼 특정 종목 일정일 때만** 넣습니다. CPI·FOMC 같은 시장 전체
  일정은 생략하세요
- **`consensus`는 선택**입니다. 애널리스트 예상치를 알고 있으면 적어 넣으세요 —
  `brief --html`에서 "시장 예상 EPS 1.42"로 표시됩니다

`brief --html`을 만들 때 앞으로 7일 이내 일정이 파란/노란 슬라이드로 자동으로 들어갑니다 —
**한 번도 `mystock calendar`를 실행한 적 없으면 그 자리는 아예 안 보입니다.** 확인도 안
했는데 "일정 없음"이라고 말하는 건 이 앱이 절대 하면 안 되는 거짓말이라서요.

### 한글 기사

`name`에 한글이 있으면 **Google 뉴스 한국어 검색 RSS가 자동으로 추가됩니다.**
`"name": "엔비디아"`면 한국 매체의 엔비디아 기사가 같이 들어옵니다. 별도 설정은 없습니다.

무료 mock은 번역을 하지 않으므로, **화면의 언어는 원문의 언어입니다.** 영문 기사는 영문으로
보입니다. 전부 한글로 보시려면 `aiProvider`를 `anthropic`으로 바꿔야 합니다(유료).

언론사 섹션 RSS를 직접 넣고 싶으면 `extraFeeds`에 추가하세요 — 전체 피드라도 관련성 필터가
자산별로 갈라줍니다:

```json
"extraFeeds": { "NVDA": ["https://www.hankyung.com/feed/it"] }
```

## 개발

```bash
npm test          # 206개
npm run typecheck
```

테스트는 네트워크 없이, API 키 없이 돕니다. Stage 2~3은 임베딩 벡터를 주입해서 검증하므로,
**클러스터링 로직은 검증되지만 임계값이 실제로 맞는지는 검증하지 않습니다.**

이건 이론적인 한계가 아니라 실제로 물린 적이 있습니다 — `clusterThreshold` 기본값이 0.78일 때
테스트는 전부 통과했지만 실제 모델로는 서로 다른 4개 사건이 하나로 뭉쳤습니다 (설계서 §4).
스텁은 주제별로 깔끔히 분리된 인위적 벡터를 쓰므로 정의상 이 문제를 재현할 수 없습니다.

그래서 테스트의 임계값은 프로덕션 기본값과 분리해서 고정되어 있습니다. 실제 임계값이 맞는지는
`collect --verbose`로 **눈으로** 확인해야 하고, 그게 2주 실전 실행의 핵심 작업입니다.

## 현재 상태

| | |
|---|---|
| Stage 1 (중복 제거·잡음) | 구현·검증 완료 |
| Stage 2~3 (클러스터링·매칭) | 구현 완료. threshold 0.95 — 실전 데이터의 과분할 사례까지 실측해서 유지로 확정 (설계서 §4) |
| Stage 4 mock | 구현·검증 완료 — 키 없이 end-to-end 동작 확인 |
| Stage 4 anthropic | 구현 완료, **실호출 미검증** — 유료라 아직 안 켬 |
| RSS 수집 | 구현 완료, **실전 검증 완료** — 관련성 필터·잡음 패턴 실전에서 튜닝됨 |
| 시세 수집 (market) | 구현 완료, **실전 검증 완료** — previousClose를 meta 대신 일봉 종가 배열에서 계산하도록 고침 (코스피/코스닥 등락률 버그) |
| 예정 이벤트 (calendar) | 구현 완료, **검증 완료** — 전부 수동 입력, 네트워크 없음 |
| Electron 뷰어 | 구현 완료, **실전 검증 완료** — 로컬에서 정상 구동 확인 |
| 작업 스케줄러 | **등록 완료** — collect 3시간, market 1시간 |
| 설정 화면 (시장 켜고 끄기·관심자산 추가) | 구현 완료, **실전 검증 미완료** — 저장 로직은 단위 테스트 완료, 실제 Electron 클릭은 이 환경에서 확인 불가 |
| 종목 상세 페이지 | 구현 완료 — 홈의 관심자산 행이 아코디언 대신 이 페이지로 이동. 가격, 주가 추이 차트, 최근 사건 3개(클릭해야 요약 펼침), 예정 이벤트, 사건 기록장 링크 |
| 주가 추이 차트 | 구현 완료 — Yahoo 일봉 5년치 1회 요청으로 1M/3M/6M/1Y/5Y 버튼 전부 커버, 클라이언트에서 배열만 잘라 다시 그림. 지표(RSI/MACD/볼린저/거래량/이동평균/캔들)는 의도적으로 없음 — 매매 신호가 아니라 거시적 추이만 |

**과분할은 실측으로 확인됐고, 임계값은 그대로 둔다.** 실전 데이터에서 같은 사건이 두 개로
쪼개진 사례가 나왔고, 실제 헤드라인 5쌍의 코사인을 재봤더니 "다른 사건" 쌍들의 유사도
(0.845~0.907)가 "같은 사건" 쌍(0.871)을 완전히 감싸고 있었다 — 즉 이 범위 안에는 중복만
잡고 무관한 사건은 안 합치는 임계값이 없다. 과병합(사건이 조용히 사라짐)이 과분할(같은
사건이 두 번 보임)보다 훨씬 나쁜 실패이므로 0.95를 유지한다. 상세 데이터는 설계서 §4.
