import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import { fetchQuote } from "../sources/market.js";
import type { Instrument, Quote, Slot } from "../types.js";

export interface MarketRow {
  instrument: Instrument;
  price: number;
  change: number | null;
  changePct: number | null;
  currency: string | null;
  ts: string;
  /** True when the newest stored figure is old enough to be worth flagging. */
  stale: boolean;
}

export interface MarketFetchStats {
  ok: number;
  failed: { id: string; reason: string }[];
}

/**
 * One request per enabled instrument. A provider that is down for one symbol
 * must not cost the others, so failures are collected rather than thrown —
 * a dashboard with five of six tiles beats a blank screen, and the missing
 * one shows as missing rather than as zero.
 */
export async function collectMarket(
  db: DatabaseSync,
  config: Config,
  opts: { now?: Date; onLog?: (line: string) => void } = {},
): Promise<MarketFetchStats> {
  const now = opts.now ?? new Date();
  const log = opts.onLog ?? (() => {});
  const stats: MarketFetchStats = { ok: 0, failed: [] };

  for (const inst of config.market.filter((m) => m.enabled)) {
    try {
      const quote = await fetchQuote(inst);
      storeQuote(db, quote, now);
      stats.ok++;
      log(`  ✓ ${inst.name} ${quote.price}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stats.failed.push({ id: inst.id, reason });
      log(`  ✕ ${inst.name} (${inst.symbol}) — ${reason}`);
    }
  }
  return stats;
}

export function storeQuote(db: DatabaseSync, q: Quote, now: Date): void {
  db.prepare(
    `INSERT INTO market_points (instrument_id, ts, price, previous_close, currency, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(instrument_id, ts) DO UPDATE SET
       price = excluded.price,
       previous_close = excluded.previous_close,
       fetched_at = excluded.fetched_at`,
  ).run(q.instrumentId, q.ts, q.price, q.previousClose, q.currency, q.source, now.toISOString());
}

const STALE_AFTER_MS = 24 * 3_600_000;

export function buildMarket(
  db: DatabaseSync,
  config: Config,
  slot?: Slot,
  now = new Date(),
): MarketRow[] {
  const stmt = db.prepare(
    `SELECT ts, price, previous_close, currency FROM market_points
     WHERE instrument_id = ? ORDER BY ts DESC LIMIT 1`,
  );

  const rows: MarketRow[] = [];
  for (const inst of config.market) {
    if (!inst.enabled) continue;
    if (slot && inst.slot !== slot) continue;

    const row = stmt.get(inst.id) as
      | { ts: string; price: number; previous_close: number | null; currency: string | null }
      | undefined;
    // Never collected: left out rather than shown as a zero. A tile reading
    // 0.00 would be a claim about the market; absence is not.
    if (!row) continue;

    const prev = row.previous_close;
    const change = prev === null ? null : row.price - prev;
    rows.push({
      instrument: inst,
      price: row.price,
      change,
      changePct: prev === null || prev === 0 ? null : ((row.price - prev) / prev) * 100,
      currency: row.currency,
      ts: row.ts,
      stale: now.getTime() - Date.parse(row.ts) > STALE_AFTER_MS,
    });
  }
  return rows;
}

export function renderMarket(rows: MarketRow[]): string {
  if (rows.length === 0) {
    return "\n시장 데이터가 없습니다. `mystock market` 을 먼저 실행하세요.\n";
  }

  const lines: string[] = ["", "━━ 시장 ━━", ""];
  for (const r of rows) {
    const arrow = r.change === null ? " " : r.change > 0 ? "▲" : r.change < 0 ? "▼" : "—";
    const pct = r.changePct === null ? "" : `${Math.abs(r.changePct).toFixed(2)}%`;
    const abs = r.change === null ? "" : fmtNum(Math.abs(r.change));
    lines.push(
      `  ${r.instrument.name.padEnd(16)} ${fmtNum(r.price).padStart(12)}  ${arrow} ${abs.padStart(9)}  ${pct.padStart(7)}` +
        (r.stale ? "  (오래됨)" : ""),
    );
  }
  lines.push("");
  return lines.join("\n");
}

function fmtNum(n: number): string {
  const digits = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 2 : 4;
  return n.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
