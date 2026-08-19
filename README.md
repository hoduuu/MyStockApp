# mystock — Phase 0 수집기

개인 투자 비서 앱의 뉴스 수집·사건 합성 파이프라인. 설계 배경은 [`docs/DESIGN.md`](docs/DESIGN.md).

**이건 버리는 프로토타입이 아닙니다.** 이 CLI가 그대로 작업 스케줄러가 호출할 헤드리스 수집기이고,
나중에 배포로 갈 때 서버에 올라갈 공용 층입니다 (설계서 §0.5). 그래서 UI도 사용자 개념도 모릅니다.

## Phase 0의 목표

> **뉴스 30개 → 사건 3개가 실제로 되는가?**

이게 안 되면 나머지는 의미가 없습니다. 2주간 매일 돌려보고 눈으로 검증하는 게 이 단계의 본체입니다.
검증 항목 7가지는 설계서 §15 Phase 0에 있습니다.

## 시작하기

```bash
npm install
cp mystock.config.example.json mystock.config.json   # 관심자산 편집
export ANTHROPIC_API_KEY=sk-...                      # Stage 4에만 필요
```

첫 실행은 임베딩 모델(~120MB)을 `./.cache`로 내려받습니다. 이후에는 오프라인으로 동작합니다.

```bash
# 돈 안 쓰고 Stage 1~3만 — 임계값 튜닝용. 여기서 대부분의 시간을 씁니다.
npm run mystock -- collect --dry-run

# 실제 수집 (Stage 4 포함, LLM 호출)
npm run mystock -- collect

# 쌓인 사건 읽기
npm run mystock -- brief --window 7d

# 비용 확인 — Phase 0의 예산 결정 근거
npm run mystock -- cost

# 같은 입력으로 두 모델 비교
npm run mystock -- compare --model claude-opus-5,claude-haiku-4-5
```

네트워크 없이 파이프라인만 보려면 픽스처를 씁니다:

```bash
npm run mystock -- collect --fixture fixtures/nvda-sample.xml --dry-run
```

## 파이프라인

```
RSS 16건
  ↓ Stage 1  규칙 기반          URL 정규화 · 제목 Jaccard · 잡음 패턴   (LLM 0원)
    5건
  ↓ Stage 2  임베딩 클러스터링   로컬 ONNX 다국어 모델                  (비용 0)
    클러스터 4개
  ↓ Stage 3  기존 사건 매칭      후속이면 여기서 끝 — LLM에 안 감        (비용 0)
    신규 후보 N개
  ↓ Stage 4  LLM 사건 합성      구조화 출력, 자산당 하루 1회            ← 여기서만 과금
    사건
```

Stage 1~3이 하는 일은 전부 **Stage 4에 도달하는 양을 줄이는 것**입니다.
후속 보도는 Stage 3에서 걸러져 LLM을 아예 안 거칩니다.

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
| `nearDuplicateThreshold` | 0.7 | 제목 토큰 Jaccard가 이 이상이면 같은 기사 |
| `clusterThreshold` | 0.78 | 코사인이 이 이상이면 같은 사건 |
| `eventMatchThreshold` | 0.75 | 이 이상이면 신규 사건이 아니라 후속 |
| `eventCloseDays` | 7 | 이만큼 후속이 없으면 사건 종료 |
| `maxArticleAgeDays` | 7 | 수집 대상 기간 |
| `model` | `claude-opus-5` | Stage 4 모델 |

## 개발

```bash
npm test          # 71개
npm run typecheck
```

테스트는 네트워크 없이 돕니다. Stage 2~3은 임베딩 벡터를 주입해서 검증하므로,
**클러스터링 로직은 검증되지만 실제 모델이 이 기사들을 잘 가르는지는 검증하지 않습니다.**
그건 2주 실전 실행에서 확인할 몫입니다.

## 현재 상태

| | |
|---|---|
| Stage 1 (중복 제거·잡음) | 구현·검증 완료 |
| Stage 2~3 (클러스터링·매칭) | 구현 완료, 주입 벡터로 검증. 실제 모델 미검증 |
| Stage 4 (LLM 합성) | 구현 완료, **실호출 미검증** — API 키 필요 |
| RSS 수집 | 구현 완료, 픽스처로만 검증 — 실제 피드 미검증 |

마지막 두 줄은 개발 환경에서 외부 네트워크가 막혀 있어서입니다. 로컬에서 첫 `collect`를 돌리는 게
Phase 0의 실질적인 첫 관문입니다.
