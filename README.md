# mystock — Phase 0 수집기

개인 투자 비서 앱의 뉴스 수집·사건 합성 파이프라인. 설계 배경은 [`docs/DESIGN.md`](docs/DESIGN.md).

**기본 설정으로는 돈이 들지 않습니다.** 뉴스는 무료 RSS, 임베딩은 로컬 모델, 사건 요약은 mock입니다.
API 키도, 가입도, 서버도 필요 없습니다. 유료 API는 나중에 `--provider anthropic` 하나로 켜집니다.

**이건 버리는 프로토타입이 아닙니다.** 이 CLI가 그대로 작업 스케줄러가 호출할 헤드리스 수집기이고,
나중에 배포로 갈 때 서버에 올라갈 공용 층입니다 (설계서 §0.5). 그래서 UI도 사용자 개념도 모릅니다.

## 무료인 것과 돈이 드는 것

| 구성요소 | 무엇을 쓰나 | 비용 | 필요한 것 |
|---|---|---|---|
| 뉴스 수집 | Yahoo Finance RSS | **무료** | 없음 — 키도 가입도 불필요 |
| Stage 1 중복 제거 | 규칙 (URL 정규화·제목 Jaccard) | **무료** | 없음 |
| Stage 2 클러스터링 | 로컬 ONNX 임베딩 모델 | **무료** | 첫 실행 시 ~120MB 1회 다운로드 |
| Stage 3 사건 매칭 | 로컬 벡터 비교 | **무료** | 없음 |
| Stage 4 사건 합성 | **mock (기본값)** | **무료** | 없음 |
| 저장소 | SQLite 파일 1개 | **무료** | 없음 — 서버 아님, Node 내장 |
| 금융 데이터 (시세·금리·환율) | *아직 구현 안 됨* | — | Phase 2 |
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

# 쌓인 사건 읽기
npm run mystock -- brief --window 7d

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

## 작업 스케줄러 등록 (Windows)

앱이 꺼져 있어도 수집이 돌아야 합니다. 이게 안 되면 "지난 일주일 요약"이 성립하지 않습니다
(설계서 §3 — 이 프로젝트의 가장 큰 구조적 함정).

```powershell
schtasks /create /tn "mystock collect" /sc hourly /mo 3 `
  /tr "node --disable-warning=ExperimentalWarning C:\path\to\dist\cli.js collect" `
  /st 07:00
```

`schtasks`의 `/z`나 작업 스케줄러 GUI의 **"예약 시간을 놓친 경우 가능한 한 빨리 시작"**(`StartWhenAvailable`)을
켜두면 PC를 껐던 동안 밀린 실행을 따라잡습니다.

## 설정

`mystock.config.json` (git에 올라가지 않습니다). 전부 Phase 0 튜닝 노브입니다:

| 항목 | 기본값 | 의미 |
|---|---|---|
| `aiProvider` | `mock` | Stage 4 백엔드. `mock`(무료) 또는 `anthropic`(유료) |
| `nearDuplicateThreshold` | 0.7 | 제목 토큰 Jaccard가 이 이상이면 같은 기사 |
| `clusterThreshold` | 0.95 | 코사인이 이 이상이면 같은 사건. **임베딩 모델을 바꾸면 반드시 재측정** |
| `eventMatchThreshold` | 0.75 | 이 이상이면 신규 사건이 아니라 후속 |
| `eventCloseDays` | 7 | 이만큼 후속이 없으면 사건 종료 |
| `maxArticleAgeDays` | 7 | 수집 대상 기간 |
| `model` | `claude-opus-5` | `aiProvider`가 `anthropic`일 때만 사용 |

## 개발

```bash
npm test          # 78개
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
| Stage 2~3 (클러스터링·매칭) | 구현 완료, 주입 벡터로 검증. 실제 모델 미검증 |
| Stage 4 mock | 구현·검증 완료 — 키 없이 end-to-end 동작 확인 |
| Stage 4 anthropic | 구현 완료, **실호출 미검증** — 유료라 아직 안 켬 |
| RSS 수집 | 구현 완료, 픽스처로만 검증 — 실제 피드 미검증 |

마지막 줄은 개발 환경에서 외부 네트워크가 막혀 있어서입니다. 로컬에서 첫 `collect`를 돌리는 게
Phase 0의 실질적인 첫 관문입니다.
