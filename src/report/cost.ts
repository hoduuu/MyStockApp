import type { DatabaseSync } from "node:sqlite";

interface CostRow {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

/**
 * Phase 0's budget decision rests on this table (docs/DESIGN.md §0.5):
 * measure first, choose the model second.
 */
export function renderCost(db: DatabaseSync, days: number, assetCount: number): string {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const byModel = db
    .prepare(
      `SELECT model,
              COUNT(*)                    AS calls,
              SUM(input_tokens)           AS input_tokens,
              SUM(output_tokens)          AS output_tokens,
              SUM(cache_read_tokens)      AS cache_read_tokens,
              SUM(cost_usd)               AS cost_usd
       FROM llm_usage WHERE ts >= ? GROUP BY model ORDER BY cost_usd DESC`,
    )
    .all(since) as unknown as CostRow[];

  if (byModel.length === 0) {
    return `\n최근 ${days}일간 기록된 LLM 호출이 없습니다.\n`;
  }

  const lines: string[] = ["", `━━ 최근 ${days}일 LLM 사용량 ━━`, ""];
  let total = 0;
  let totalCalls = 0;

  for (const r of byModel) {
    total += r.cost_usd;
    totalCalls += r.calls;
    const cacheNote = r.cache_read_tokens > 0
      ? `  (캐시 적중 ${r.cache_read_tokens.toLocaleString()})`
      : "  (캐시 적중 없음)";
    lines.push(
      `${r.model}`,
      `  호출 ${r.calls}회   입력 ${r.input_tokens.toLocaleString()}   출력 ${r.output_tokens.toLocaleString()}${cacheNote}`,
      `  비용 $${r.cost_usd.toFixed(4)}`,
      "",
    );
  }

  const perDay = total / days;
  lines.push(
    `합계   $${total.toFixed(4)}   (하루 평균 $${perDay.toFixed(4)})`,
    `추정   자산 ${assetCount}개 기준 월 $${(perDay * 30).toFixed(2)}`,
    "",
  );

  if (byModel.every((r) => r.cache_read_tokens === 0) && totalCalls > 1) {
    lines.push(
      "⚠ 캐시 적중이 0입니다. 시스템 프롬프트에 날짜·자산명 같은 가변값이",
      "  섞였는지 확인하세요 (docs/DESIGN.md §5.3).",
      "",
    );
  }

  return lines.join("\n");
}
