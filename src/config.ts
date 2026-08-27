import fs from "node:fs";
import type { CalendarEvent, Instrument, ProviderName } from "./types.js";

/**
 * Phase 0 keeps assets and thresholds in a JSON file rather than the DB.
 * Every number here is a tuning knob for the 2-week verification run
 * (docs/DESIGN.md, Phase 0).
 */
export interface Config {
  dbPath: string;
  assets: { symbol: string; name: string; aliases: string[] }[];
  /** Extra feed URLs merged with the per-ticker defaults. */
  extraFeeds: Record<string, string[]>;
  /**
   * Dashboard instruments, in display order. Disabled ones stay in the list so
   * they can be switched back on — that is the whole point of the edit screen,
   * and deleting them would lose the history already collected.
   */
  market: Instrument[];
  /**
   * Every calendar entry — macro releases (CPI, FOMC, jobs, GDP) and
   * per-asset earnings alike — maintained by hand. Macro releases have no
   * free live feed worth the engineering for something that happens maybe
   * eight times a year (docs/DESIGN.md §7.1b). Earnings dates were fetched
   * automatically at first, but Yahoo's earnings-calendar endpoint requires
   * an auth flow its price data does not and returned a flat 401 in local
   * testing — and per-asset earnings run four times a year, an even lower
   * cadence than macro releases, so the same reasoning applies at least as
   * strongly (docs/DESIGN.md §0.7b). `assetSymbol` is omitted for a macro
   * entry.
   */
  calendarEvents: (Pick<CalendarEvent, "id" | "kind" | "title" | "scheduledAt"> & {
    assetSymbol?: string;
    /** e.g. { "epsAverage": 1.42 } — typed in by hand, same as everything else here. */
    consensus?: Record<string, number>;
  })[];
  /**
   * Stage 4 backend. `mock` costs nothing and needs no key; `anthropic` calls
   * the paid API. Mock is the default so no run can spend money by accident —
   * paying is something you opt into (docs/DESIGN.md §0.6).
   */
  aiProvider: ProviderName;
  /** Only read when aiProvider is `anthropic`. */
  model: string;
  /** Ignore articles older than this when collecting. */
  maxArticleAgeDays: number;
  /** Stage 1: token-Jaccard above this means "same story, restyled headline". */
  nearDuplicateThreshold: number;
  /**
   * Stage 2: cosine above this puts two articles in one cluster.
   *
   * High because e5-family embeddings put every headline about one company in
   * the same neighbourhood — "Nvidia names automotive head" and "China reviews
   * Nvidia H200 supply" sit well above 0.8 despite sharing nothing but the
   * subject. Measured against the fixture, not guessed (docs/DESIGN.md §4).
   */
  clusterThreshold: number;
  /** Stage 3: cosine above this makes a cluster a follow-up, not a new event. */
  eventMatchThreshold: number;
  /**
   * An event with no new coverage for this many days is closed and stops being
   * matchable, so a theme that resurfaces later becomes a new event.
   * This is also what bounds the matchable set — open events are never staler
   * than this (docs/DESIGN.md §4).
   */
  eventCloseDays: number;
  /** Clustering only groups articles published within this many hours. */
  clusterWindowHours: number;
  embeddingModel: string;
}

/**
 * Six indices fill the grid and two fill the row below; the rest ship switched
 * off so they are one toggle away rather than something to look up.
 */
export const DEFAULT_MARKET: Instrument[] = [
  { id: "dow",    name: "다우",           symbol: "^DJI",      slot: "index", icon: "us",  enabled: true },
  { id: "nasdaq", name: "나스닥",         symbol: "^IXIC",     slot: "index", icon: "us",  enabled: true },
  { id: "sp500",  name: "S&P 500",        symbol: "^GSPC",     slot: "index", icon: "us",  enabled: true },
  { id: "kospi",  name: "코스피",         symbol: "^KS11",     slot: "index", icon: "kr",  enabled: true },
  { id: "kosdaq", name: "코스닥",         symbol: "^KQ11",     slot: "index", icon: "kr",  enabled: true },
  { id: "nq",     name: "나스닥100 선물", symbol: "NQ=F",      slot: "index", icon: "us",  enabled: true },
  { id: "nikkei", name: "니케이225",      symbol: "^N225",     slot: "index", icon: "jp",  enabled: false },
  { id: "sse",    name: "상해종합",       symbol: "000001.SS", slot: "index", icon: "cn",  enabled: false },
  { id: "ust10y", name: "미국 10년물",    symbol: "^TNX",      slot: "index", icon: "us",  enabled: false },

  { id: "usdkrw", name: "원/달러",        symbol: "KRW=X",     slot: "pair",  icon: "us",  enabled: true },
  { id: "btc",    name: "비트코인",       symbol: "BTC-USD",   slot: "pair",  icon: "btc", enabled: true },
  { id: "eurkrw", name: "원/유로",        symbol: "EURKRW=X",  slot: "pair",  icon: "eu",  enabled: false },
  { id: "jpykrw", name: "원/엔",          symbol: "JPYKRW=X",  slot: "pair",  icon: "jp",  enabled: false },
  { id: "eth",    name: "이더리움",       symbol: "ETH-USD",   slot: "pair",  icon: "eth", enabled: false },
  { id: "gold",   name: "금",             symbol: "GC=F",      slot: "pair",  icon: "gold", enabled: false },
  { id: "silver", name: "은",             symbol: "SI=F",      slot: "pair",  icon: "silver", enabled: false },
  { id: "oil",    name: "WTI 유가",       symbol: "CL=F",      slot: "pair",  icon: "oil", enabled: false },
];

/**
 * Relevance terms for collecting news about a market instrument (나스닥,
 * 코스피, …), keyed by id rather than DEFAULT_MARKET's own `name` — a
 * dashboard instrument has no `aliases` field of its own to filter with.
 *
 * A few of these deliberately avoid the instrument's display name: "금"
 * (gold) and "은" (silver) are exactly the short, common-word Hangul terms
 * the DELL/"사우델" bug (relevance.ts) was found from — "은" doubles as the
 * topic particle attached to any noun, so using it bare would match almost
 * every Korean sentence. Compounds like "금값"/"은값" carry the same meaning
 * without being ordinary words on their own.
 */
export const MARKET_NEWS_TERMS: Record<string, { name: string; aliases: string[] }> = {
  dow: { name: "다우존스", aliases: ["다우존스산업평균", "Dow Jones"] },
  nasdaq: { name: "나스닥", aliases: ["나스닥지수", "Nasdaq Composite"] },
  sp500: { name: "S&P500", aliases: ["S&P 500", "스탠더드앤드푸어스"] },
  kospi: { name: "코스피", aliases: ["코스피지수", "KOSPI"] },
  kosdaq: { name: "코스닥", aliases: ["코스닥지수", "KOSDAQ"] },
  nq: { name: "나스닥100 선물", aliases: ["나스닥 선물", "Nasdaq futures"] },
  nikkei: { name: "니케이225", aliases: ["니케이 지수", "Nikkei 225"] },
  sse: { name: "상해종합지수", aliases: ["상하이종합지수", "Shanghai Composite"] },
  ust10y: { name: "미국 10년물", aliases: ["미국채 10년물", "10-year Treasury yield"] },
  usdkrw: { name: "원달러 환율", aliases: ["달러/원", "원/달러 환율", "USD/KRW"] },
  btc: { name: "비트코인", aliases: ["비트코인 가격", "Bitcoin"] },
  eurkrw: { name: "원유로 환율", aliases: ["유로/원", "EUR/KRW"] },
  jpykrw: { name: "원엔 환율", aliases: ["엔/원", "JPY/KRW"] },
  eth: { name: "이더리움", aliases: ["이더리움 가격", "Ethereum"] },
  gold: { name: "국제 금값", aliases: ["금값", "금 시세", "gold price"] },
  silver: { name: "국제 은값", aliases: ["은값", "은 시세", "silver price"] },
  oil: { name: "국제유가", aliases: ["WTI 유가", "유가", "oil price"] },
};

export const DEFAULT_CONFIG: Config = {
  dbPath: "mystock.db",
  assets: [{ symbol: "NVDA", name: "엔비디아", aliases: ["Nvidia", "NVIDIA"] }],
  extraFeeds: {},
  market: DEFAULT_MARKET,
  // Empty by default: inventing a schedule when none is configured would be
  // exactly the fabrication docs/DESIGN.md §14 forbids.
  calendarEvents: [],
  aiProvider: "mock",
  model: "claude-opus-5",
  maxArticleAgeDays: 7,
  nearDuplicateThreshold: 0.7,
  clusterThreshold: 0.95,
  eventMatchThreshold: 0.75,
  eventCloseDays: 7,
  clusterWindowHours: 72,
  embeddingModel: "Xenova/multilingual-e5-small",
};

export function loadConfig(path = "mystock.config.json"): Config {
  if (!fs.existsSync(path)) {
    // Paths here are relative to the working directory, and a scheduled task
    // does not start in the project folder unless told to. Falling back to
    // defaults silently would collect the wrong assets into a database
    // somewhere else, and look like it worked.
    console.error(
      `설정 파일이 없어 기본값으로 실행합니다: ${path}\n` +
        `  (작업 디렉터리: ${process.cwd()})`,
    );
    return DEFAULT_CONFIG;
  }
  const raw: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return { ...DEFAULT_CONFIG, ...(raw as Partial<Config>) };
}

/** USD per 1M tokens. Source: docs/DESIGN.md §5.2 (2026-06 pricing). */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};
