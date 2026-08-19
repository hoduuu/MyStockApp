import type { CalendarEvent } from "../types.js";

/**
 * Earnings dates and analyst consensus, from the same unofficial Yahoo
 * surface as sources/market.ts (docs/DESIGN.md §0.7b) — free, no key, same
 * footing as everything else this app already depends on.
 *
 * Macro releases (CPI, FOMC, jobs, GDP) are not fetched from anywhere: the
 * brainstorm doc itself concluded a live feed for these isn't worth chasing
 * — FOMC meets eight times a year, and a config entry updated by hand a
 * couple of times a year is the honest amount of engineering for that
 * (docs/DESIGN.md §7.1b). Those come from `config.macroEvents` instead;
 * see report/calendar.ts.
 */
const QUOTE_SUMMARY_URL = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/";

export interface EarningsInfo {
  symbol: string;
  /** Null when Yahoo has no upcoming date on file for this symbol. */
  scheduledAt: string | null;
  consensus: Record<string, number> | null;
}

export async function fetchEarnings(symbol: string, timeoutMs = 15_000): Promise<EarningsInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${QUOTE_SUMMARY_URL}${encodeURIComponent(symbol)}?modules=calendarEvents`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) mystock/0.0 (personal use)",
        accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return parseEarnings(symbol, await res.text());
  } finally {
    clearTimeout(timer);
  }
}

export function parseEarnings(symbol: string, body: string): EarningsInfo {
  const doc: unknown = JSON.parse(body);
  const summary = (doc as { quoteSummary?: { result?: unknown; error?: unknown } })?.quoteSummary;

  // Same shape of failure as the chart endpoint: a delisted or mistyped
  // symbol comes back as HTTP 200 with an error object, not a 4xx.
  if (summary?.error != null) {
    const desc = (summary.error as { description?: string })?.description;
    throw new Error(desc ?? "알 수 없는 오류");
  }

  const first = Array.isArray(summary?.result) ? summary.result[0] : undefined;
  const earnings = (first as { calendarEvents?: { earnings?: RawEarnings } } | undefined)
    ?.calendarEvents?.earnings;
  if (!earnings) throw new Error("응답에 calendarEvents가 없습니다");

  const dates = Array.isArray(earnings.earningsDate) ? earnings.earningsDate : [];
  const next = dates.map((d) => raw(d)).find((n): n is number => n !== null);

  const consensus: Record<string, number> = {};
  set(consensus, "epsAverage", raw(earnings.earningsAverage));
  set(consensus, "epsLow", raw(earnings.earningsLow));
  set(consensus, "epsHigh", raw(earnings.earningsHigh));
  set(consensus, "revenueAverage", raw(earnings.revenueAverage));
  set(consensus, "revenueLow", raw(earnings.revenueLow));
  set(consensus, "revenueHigh", raw(earnings.revenueHigh));

  return {
    symbol,
    scheduledAt: next === undefined ? null : new Date(next * 1000).toISOString(),
    consensus: Object.keys(consensus).length > 0 ? consensus : null,
  };
}

interface RawField {
  raw?: unknown;
}
interface RawEarnings {
  earningsDate?: RawField[];
  earningsAverage?: RawField;
  earningsLow?: RawField;
  earningsHigh?: RawField;
  revenueAverage?: RawField;
  revenueLow?: RawField;
  revenueHigh?: RawField;
}

function raw(v: RawField | undefined): number | null {
  return typeof v?.raw === "number" && Number.isFinite(v.raw) ? v.raw : null;
}

function set(target: Record<string, number>, key: string, v: number | null): void {
  if (v !== null) target[key] = v;
}

export function toCalendarEvent(
  info: EarningsInfo,
  assetName: string,
  now: Date,
): CalendarEvent | null {
  if (info.scheduledAt === null) return null;
  return {
    id: `cal_earnings_${info.symbol}`,
    assetSymbol: info.symbol,
    kind: "earnings",
    title: `${assetName} 실적 발표`,
    scheduledAt: info.scheduledAt,
    consensus: info.consensus,
    status: Date.parse(info.scheduledAt) <= now.getTime() ? "occurred" : "scheduled",
  };
}
