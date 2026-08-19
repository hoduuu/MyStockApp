import type { Config } from "../config.js";

/**
 * Phase 0 runs on RSS only — no API keys, nothing to sign up for
 * (docs/DESIGN.md §16). Finnhub gets added once the pipeline is tuned.
 */
export function feedsForAsset(symbol: string, config: Config): string[] {
  const yahoo = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  return [yahoo, ...(config.extraFeeds[symbol] ?? [])];
}
