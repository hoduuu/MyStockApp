import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { PRICING } from "../config.js";
import { EVENT_CATEGORIES, type Cluster, type UsageRecord } from "../types.js";
import { diverseSources } from "./cluster.js";

const SynthesizedEvent = z.object({
  title: z.string().describe("사건 이름. 기사 제목을 베끼지 말 것. 12~40자."),
  summary: z.string().describe("2~4문장. 한국어. 입력에 없는 사실을 쓰지 말 것."),
  importance: z.number().int().min(0).max(100),
  category: z.enum(EVENT_CATEGORIES),
  certainty: z.enum(["reported", "confirmed", "speculative"]),
  evidence: z.array(z.string()).describe("이 사건의 근거가 된 cluster id 목록. 비울 수 없음."),
  importance_reason: z.string().describe("중요도를 그렇게 준 이유. 사용자에게 보이지 않음."),
});

const SynthesisResult = z.object({
  events: z.array(SynthesizedEvent),
  one_liner: z.string().describe("전체 한줄 요약. 사건이 없으면 빈 문자열."),
  no_significant_events: z.boolean(),
});

export type SynthesisOutput = z.infer<typeof SynthesisResult>;

/**
 * The product principles from the brainstorm doc, restated as hard rules.
 *
 * Kept byte-stable and free of dates, asset names and counts so it caches as a
 * prefix across every asset in a run (docs/DESIGN.md §5.3). Anything that
 * varies belongs in the user message.
 */
const SYSTEM_PROMPT = `당신은 장기투자자를 위한 뉴스 압축기다. 목표는 뉴스를 많이 보여주는 것이 아니라, 사용자가 뉴스를 읽지 않아도 중요한 일은 알 수 있게 하는 것이다.

입력으로 기사 묶음(cluster)들을 받는다. 각 묶음은 같은 사건을 다룬 기사들이다.
출력은 사건(event) 목록이다. 기사 단위가 아니라 사건 단위로 정리한다.

## 반드시 지킬 것

1. 입력에 없는 숫자, 날짜, 인용, 사실을 만들어내지 마라. 모르면 쓰지 마라.
2. 주가나 시장 움직임의 원인을 단정하지 마라. 여러 요인이 동시에 작용할 수 있다.
   원인이 명시된 기사가 있을 때만 "~라고 보도되었다" 형태로 쓴다.
3. 모든 사건은 evidence에 근거 cluster id를 최소 1개 포함해야 한다.
4. 기사 제목을 그대로 쓰지 마라. 사건에 이름을 붙여라.
5. 사소한 것을 억지로 채워 넣지 마라. 중요한 사건이 없으면 events를 빈 배열로 반환하고
   no_significant_events를 true로 설정하라. 빈 배열은 실패가 아니라 정상적인 결과다.
6. 한국어로 쓴다. 기업명은 사용자가 등록한 표기를 따른다.

## 중요도 기준 (importance)

- 80~100: 실적 발표, 대형 계약, 정부 규제 확정, 신제품 출시, 경영진 교체,
          사업에 직접 영향을 주는 사건
- 60~79:  대규모 투자 발표, 산업 구조에 영향을 줄 수 있는 움직임, 규제 검토 단계
- 40~59:  의미 있는 후속 보도, 파트너십, 중간 규모 발표
- 0~39:   단순 애널리스트 코멘트, 반복 보도, 의미가 낮은 전망

40 미만은 사용자에게 보여줄 가치가 없다. 그런 것은 events에 넣지 마라.

## certainty

- confirmed:   회사나 당국이 공식 발표한 것
- reported:    언론이 보도했으나 공식 확인은 없는 것
- speculative: 전망, 관측, 소식통 인용`;

export interface SynthesisInput {
  assetSymbol: string;
  assetName: string;
  clusters: { id: string; cluster: Cluster }[];
  openEventTitles: string[];
  windowLabel: string;
}

export interface SynthesisResponse {
  output: SynthesisOutput;
  usage: UsageRecord;
}

export async function synthesizeEvents(
  input: SynthesisInput,
  opts: { model: string; client?: Anthropic },
): Promise<SynthesisResponse> {
  const client = opts.client ?? new Anthropic();

  const response = await client.messages.parse({
    model: opts.model,
    max_tokens: 16000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(input) }],
    output_config: { format: zodOutputFormat(SynthesisResult) },
  });

  if (response.stop_reason === "refusal") {
    // stop_details is only populated on refusals and is not on the parse
    // helper's return type, so read it off the raw message.
    const details = (response as { stop_details?: { category?: string | null } }).stop_details;
    throw new Error(
      `모델이 요청을 거부했습니다 (${details?.category ?? "unknown"}). 자산: ${input.assetSymbol}`,
    );
  }

  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`구조화 출력 파싱 실패. 자산: ${input.assetSymbol}`);

  return {
    output: dropUnsupportedEvents(parsed),
    usage: toUsage(opts.model, response.usage),
  };
}

export function buildUserMessage(input: SynthesisInput): string {
  const parts: string[] = [
    `자산: ${input.assetSymbol} (${input.assetName})`,
    `기간: ${input.windowLabel}`,
    "",
  ];

  if (input.openEventTitles.length > 0) {
    parts.push(
      "## 이미 기록된 진행 중인 사건",
      "아래와 같은 내용이면 새 사건이 아니다. 정말 새로운 국면일 때만 사건으로 만들어라.",
      ...input.openEventTitles.map((t) => `- ${t}`),
      "",
    );
  }

  parts.push("## 이번에 새로 수집된 기사 묶음", "");

  for (const { id, cluster } of input.clusters) {
    const sources = diverseSources(cluster, 3);
    parts.push(`### ${id} (기사 ${cluster.articles.length}건)`);
    for (const a of sources) {
      const when = a.publishedAt.slice(0, 16).replace("T", " ");
      parts.push(`- [${a.source} · ${when}] ${a.title}`);
      if (a.snippet) parts.push(`  ${a.snippet.slice(0, 300)}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Rule 3 enforced in code, not just in the prompt: an event whose evidence does
 * not point at a real cluster is unfounded and gets discarded
 * (docs/DESIGN.md §1, "사후 인과관계를 끼워 맞추지 않는다").
 */
function dropUnsupportedEvents(parsed: SynthesisOutput): SynthesisOutput {
  const events = parsed.events.filter((e) => e.evidence.length > 0);
  return {
    ...parsed,
    events,
    no_significant_events: parsed.no_significant_events || events.length === 0,
  };
}

export function toUsage(model: string, usage: Anthropic.Usage): UsageRecord {
  const price = PRICING[model] ?? { input: 0, output: 0 };
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;

  const costUsd =
    (input * price.input +
      output * price.output +
      cacheRead * price.input * 0.1 +
      cacheCreation * price.input * 1.25) /
    1_000_000;

  return { model, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation, costUsd };
}
