import type { Config } from "../config.js";

/**
 * Phase 0 runs on RSS only — no API keys, nothing to sign up for
 * (docs/DESIGN.md §16).
 *
 * Two feeds per asset, for different reasons:
 *   · Yahoo's per-ticker headline feed — English, wide, and noisy.
 *   · Google News search in Korean — the only free way to reach Korean
 *     coverage of a foreign ticker. Publisher section feeds (한경, 이데일리)
 *     carry Korean articles too, but they are whole-section firehoses with no
 *     per-company filter; a search feed asks the question directly. Add those
 *     through `extraFeeds` if you want them — Stage 1 relevance filtering
 *     already sorts out what belongs to which asset.
 */
export function feedsForAsset(symbol: string, config: Config): string[] {
  const asset = config.assets.find((a) => a.symbol === symbol);
  const feeds = [yahooTicker(symbol)];

  // Searching the English name would just re-fetch what Yahoo already gave us.
  if (asset && hasHangul(asset.name)) feeds.push(googleNewsKo(asset.name));

  return [...feeds, ...(config.extraFeeds[symbol] ?? [])];
}

/**
 * Same shape as feedsForAsset, for a market instrument (나스닥, 코스피, …)
 * instead of a config.assets entry — the Korean query comes from the
 * caller (config.ts's MARKET_NEWS_TERMS) rather than an asset's own name,
 * since a market instrument has no aliases field of its own.
 */
export function feedsForMarketInstrument(tickerSymbol: string, koreanQuery: string, config: Config): string[] {
  return [yahooTicker(tickerSymbol), googleNewsKo(koreanQuery), ...(config.extraFeeds[tickerSymbol] ?? [])];
}

function yahooTicker(symbol: string): string {
  return `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
}

/** `ceid` is the locale pair Google requires; `hl`/`gl` alone return English. */
function googleNewsKo(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR%3Ako`;
}

function hasHangul(s: string): boolean {
  return /[가-힣]/.test(s);
}
