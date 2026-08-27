import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import { fetchHistory, fetchQuote, type HistoryPoint } from "../sources/market.js";
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
  return collectQuotes(db, config.market.filter((m) => m.enabled), now, log);
}

/**
 * A watchlist asset's own ticker (e.g. NVDA) is just another Yahoo chart
 * symbol — same free endpoint, same `fetchQuote`. Stored under the ticker as
 * `instrument_id` in the same `market_points` table, separately from the
 * dashboard's `market[]` instruments, so it can power the asset detail page's
 * price line without adding a tile to the 6×2 grid.
 */
export async function collectAssetQuotes(
  db: DatabaseSync,
  config: Config,
  opts: { now?: Date; onLog?: (line: string) => void } = {},
): Promise<MarketFetchStats> {
  const now = opts.now ?? new Date();
  const log = opts.onLog ?? (() => {});
  return collectQuotes(
    db,
    config.assets.map((a) => ({ id: a.symbol, name: a.name, symbol: a.symbol })),
    now,
    log,
  );
}

async function collectQuotes(
  db: DatabaseSync,
  items: { id: string; name: string; symbol: string }[],
  now: Date,
  log: (line: string) => void,
): Promise<MarketFetchStats> {
  const stats: MarketFetchStats = { ok: 0, failed: [] };
  for (const item of items) {
    try {
      // slot/icon/enabled are unused by fetchQuote — only id/name/symbol matter.
      const quote = await fetchQuote({ ...item, slot: "index", icon: "us", enabled: true });
      storeQuote(db, quote, now);
      stats.ok++;
      log(`  ✓ ${item.name} ${quote.price}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stats.failed.push({ id: item.id, reason });
      log(`  ✕ ${item.name} (${item.symbol}) — ${reason}`);
    }
  }
  return stats;
}

/**
 * One 5-year daily-close fetch per item, re-upserted whole each time this
 * runs. Re-fetching the entire range instead of just the newest day is
 * simpler and cheap enough for this app's scale (a personal watchlist, a
 * few requests an hour) — no incremental-since-last-run bookkeeping needed.
 *
 * `id` is the price_history storage key — a watchlist asset has no id
 * distinct from its ticker, but a dashboard instrument does (e.g. "dow" for
 * "^DJI"), and using that slug keeps the key free of characters like ^ or =.
 */
async function collectHistoryFor(
  db: DatabaseSync,
  items: { id: string; symbol: string; name: string }[],
  log: (line: string) => void,
): Promise<MarketFetchStats> {
  const stats: MarketFetchStats = { ok: 0, failed: [] };
  for (const item of items) {
    try {
      const points = await fetchHistory(item.symbol);
      storeHistory(db, item.id, points);
      stats.ok++;
      log(`  ✓ ${item.name} 주가 추이 ${points.length}일치`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stats.failed.push({ id: item.id, reason });
      log(`  ✕ ${item.name} (${item.symbol}) 주가 추이 — ${reason}`);
    }
  }
  return stats;
}

export async function collectAssetHistory(
  db: DatabaseSync,
  config: Config,
  opts: { onLog?: (line: string) => void } = {},
): Promise<MarketFetchStats> {
  const log = opts.onLog ?? (() => {});
  return collectHistoryFor(
    db,
    config.assets.map((a) => ({ id: a.symbol, symbol: a.symbol, name: a.name })),
    log,
  );
}

/**
 * Same chart data for the dashboard's own instruments (나스닥, 코스피, …) —
 * powers a market tile's own detail page, the same way collectAssetHistory
 * powers a watchlist asset's.
 */
export async function collectMarketHistory(
  db: DatabaseSync,
  config: Config,
  opts: { onLog?: (line: string) => void } = {},
): Promise<MarketFetchStats> {
  const log = opts.onLog ?? (() => {});
  return collectHistoryFor(
    db,
    config.market.filter((m) => m.enabled).map((m) => ({ id: m.id, symbol: m.symbol, name: m.name })),
    log,
  );
}

function storeHistory(db: DatabaseSync, symbol: string, points: HistoryPoint[]): void {
  const stmt = db.prepare(
    `INSERT INTO price_history (symbol, date, close) VALUES (?, ?, ?)
     ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close`,
  );
  for (const p of points) stmt.run(symbol, p.date, p.close);
}

/** Ascending by date — oldest first, so the chart draws left-to-right. */
export function buildPriceHistory(db: DatabaseSync, symbol: string): HistoryPoint[] {
  return db
    .prepare(`SELECT date, close FROM price_history WHERE symbol = ? ORDER BY date ASC`)
    .all(symbol) as unknown as HistoryPoint[];
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

export interface AssetQuote {
  price: number;
  change: number | null;
  changePct: number | null;
  currency: string | null;
  ts: string;
  stale: boolean;
}

/** The same lookup as buildMarket's per-instrument row, for a single ticker not in config.market[]. */
export function buildAssetQuote(db: DatabaseSync, symbol: string, now = new Date()): AssetQuote | null {
  const row = db
    .prepare(
      `SELECT ts, price, previous_close, currency FROM market_points
       WHERE instrument_id = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(symbol) as
    | { ts: string; price: number; previous_close: number | null; currency: string | null }
    | undefined;
  if (!row) return null;

  const prev = row.previous_close;
  return {
    price: row.price,
    change: prev === null ? null : row.price - prev,
    changePct: prev === null || prev === 0 ? null : ((row.price - prev) / prev) * 100,
    currency: row.currency,
    ts: row.ts,
    stale: now.getTime() - Date.parse(row.ts) > STALE_AFTER_MS,
  };
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
