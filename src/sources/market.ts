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
    const res = await fetch(`${CHART_URL}${encodeURIComponent(inst.symbol)}?range=1d&interval=1d`, {
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

  // Yahoo gives the prior close under either name depending on the instrument.
  // Without it there is no change to show, which is a missing field rather than
  // a failure — the price is still worth storing.
  const prev = num(meta.chartPreviousClose) ?? num(meta.previousClose);

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
  const chart = (doc as { chart?: { result?: unknown; error?: unknown } })?.chart;

  // Yahoo reports a bad symbol as HTTP 200 with an error object, so a silent
  // empty tile would otherwise be the only symptom of a typo in the config.
  if (chart?.error != null) {
    const desc = (chart.error as { description?: string })?.description;
    throw new Error(desc ?? "알 수 없는 오류");
  }

  const first = Array.isArray(chart?.result) ? chart.result[0] : undefined;
  const meta = (first as { meta?: Meta } | undefined)?.meta;
  if (!meta) throw new Error("응답에 meta가 없습니다");
  return meta;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function epochToIso(v: unknown): string {
  const secs = num(v);
  return secs === null ? new Date().toISOString() : new Date(secs * 1000).toISOString();
}
