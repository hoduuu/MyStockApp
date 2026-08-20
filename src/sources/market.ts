import type { Instrument, Quote } from "../types.js";

/**
 * Market figures come from a data source and are stored as given. Nothing here
 * ever reaches the LLM, and the LLM never produces a number — the brainstorm
 * doc §19 draws that line, and this is the side of it that deals in facts.
 *
 * Yahoo's chart endpoint covers every instrument the dashboard needs from one
 * adapter: indices, futures, FX, crypto and treasury yields. Free, no key, no
 * signup — the same footing as the RSS feeds already in use. It is an
 * unofficial endpoint, so `Instrument.source` exists to let any single
 * instrument move to another provider later without touching the rest.
 */
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";

export async function fetchQuote(inst: Instrument, timeoutMs = 15_000): Promise<Quote> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // range=5d rather than 1d: for exchanges outside the US session (KOSPI,
    // KOSDAQ), Yahoo's own meta.previousClose has been observed off by a
    // trading day — the daily close series is the ground truth it's derived
    // from, so reading it directly sidesteps whatever Yahoo's shortcut does.
    const res = await fetch(`${CHART_URL}${encodeURIComponent(inst.symbol)}?range=5d&interval=1d`, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) mystock/0.0 (personal use)",
        accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return parseQuote(inst, await res.text());
  } finally {
    clearTimeout(timer);
  }
}

export function parseQuote(inst: Instrument, body: string): Quote {
  const doc: unknown = JSON.parse(body);
  const meta = readMeta(doc);

  const price = num(meta.regularMarketPrice);
  if (price === null) {
    throw new Error(`${inst.id}: 가격을 찾지 못했습니다 (${inst.symbol})`);
  }

  // Prefer the daily close series over meta's own previousClose (see the
  // range=5d comment above); fall back to meta for symbols that don't return
  // a usable series, so a missing field stays a missing field, not a failure.
  const prev = previousCloseFromSeries(doc) ?? num(meta.chartPreviousClose) ?? num(meta.previousClose);

  return {
    instrumentId: inst.id,
    symbol: inst.symbol,
    price,
    previousClose: prev,
    currency: typeof meta.currency === "string" ? meta.currency : null,
    ts: epochToIso(meta.regularMarketTime),
    source: "yahoo",
  };
}

interface Meta {
  regularMarketPrice?: unknown;
  chartPreviousClose?: unknown;
  previousClose?: unknown;
  currency?: unknown;
  regularMarketTime?: unknown;
}

function readMeta(doc: unknown): Meta {
  const meta = readResult(doc)?.meta;
  if (!meta) throw new Error("응답에 meta가 없습니다");
  return meta;
}

function readResult(
  doc: unknown,
): { meta?: Meta; timestamp?: unknown[]; indicators?: { quote?: { close?: unknown[] }[] } } | undefined {
  const chart = (doc as { chart?: { result?: unknown; error?: unknown } })?.chart;

  // Yahoo reports a bad symbol as HTTP 200 with an error object, so a silent
  // empty tile would otherwise be the only symptom of a typo in the config.
  if (chart?.error != null) {
    const desc = (chart.error as { description?: string })?.description;
    throw new Error(desc ?? "알 수 없는 오류");
  }

  return Array.isArray(chart?.result) ? chart.result[0] : undefined;
}

/**
 * The last bar can be today's still-forming session; the bar before it is the
 * most recent *completed* trading day, which is what "previous close" means
 * regardless of whether today has settled yet.
 */
function previousCloseFromSeries(doc: unknown): number | null {
  const raw = readResult(doc)?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(raw)) return null;
  const closes = raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return closes.length >= 2 ? closes[closes.length - 2]! : null;
}

export interface HistoryPoint {
  date: string;
  close: number;
}

/**
 * Daily closes for the "주가 추이" chart — 거시적 추이 only, on purpose: no
 * volume, no moving averages, no indicators. One request covers every period
 * toggle on the asset page (1M–5Y); the page slices the tail of this array
 * client-side rather than re-fetching per button.
 */
export async function fetchHistory(symbol: string, range = "5y", timeoutMs = 15_000): Promise<HistoryPoint[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${CHART_URL}${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
      {
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) mystock/0.0 (personal use)",
          accept: "application/json",
        },
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return parseHistory(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

export function parseHistory(body: string): HistoryPoint[] {
  const doc: unknown = JSON.parse(body);
  const result = readResult(doc);
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) return [];

  const points: HistoryPoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const t = num(timestamps[i]);
    const c = num(closes[i]);
    // A holiday/weekend bar comes back with a timestamp but a null close;
    // skipping it is correct, not a gap worth flagging — this is a chart of
    // trading days, not calendar days.
    if (t === null || c === null) continue;
    points.push({ date: epochToIso(t).slice(0, 10), close: c });
  }
  return points;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function epochToIso(v: unknown): string {
  const secs = num(v);
  return secs === null ? new Date().toISOString() : new Date(secs * 1000).toISOString();
}
