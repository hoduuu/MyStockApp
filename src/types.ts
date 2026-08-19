/** Shared shapes for the collection pipeline. */

/** One item as it comes off an RSS feed, before any normalization. */
export interface RawItem {
  title: string;
  link: string;
  source: string;
  snippet: string;
  publishedAt: string; // ISO-8601 UTC
}

/** An article after Stage 1 normalization, as stored in `articles`. */
export interface Article {
  id: string;
  urlCanonical: string;
  title: string;
  titleNorm: string;
  source: string;
  snippet: string;
  publishedAt: string;
}

/** Why Stage 1 rejected an item. Kept for tuning — see docs/DESIGN.md Phase 0. */
export type DropReason =
  | "duplicate_url"
  | "near_duplicate"
  | "noise"
  | "too_old"
  /** Real news, but about some other company — see pipeline/relevance.ts. */
  | "off_topic";

export interface Stage1Result {
  kept: Article[];
  dropped: { item: RawItem; reason: DropReason; duplicateOf?: string }[];
}

/** A group of articles Stage 2 believes describe the same happening. */
export interface Cluster {
  articles: Article[];
  centroid: Float32Array;
  /** Article chosen to represent the cluster to the LLM. */
  representative: Article;
}

/** Stage 3 verdict for one cluster. */
export interface MatchResult {
  cluster: Cluster;
  /** Existing event this cluster continues, if any. */
  matchedEventId: string | null;
  similarity: number;
  /**
   * Closest open event and its score, whether or not it cleared the threshold.
   * Tuning needs the rejected scores too — seeing only accepted matches tells
   * you nothing about how near the misses were.
   */
  bestSimilarity: number;
  bestEventTitle: string | null;
}

/** An event row as stored. */
export interface EventRow {
  id: string;
  assetSymbol: string;
  title: string;
  summary: string;
  importance: number;
  category: string;
  certainty: Certainty;
  status: "open" | "closed";
  firstSeenAt: string;
  lastUpdatedAt: string;
  followupCount: number;
  importanceReason: string;
}

export type Certainty = "reported" | "confirmed" | "speculative";

export const EVENT_CATEGORIES = [
  "regulation",
  "earnings",
  "product",
  "deal",
  "management",
  "macro",
  "other",
] as const;

/** Token/cost accounting for one LLM call. */
export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

// --- market ------------------------------------------------------------------

/**
 * Where an instrument sits on the dashboard. `index` is the 3-across grid,
 * `pair` the wider two-across row beneath it — the two shapes the layout has.
 */
export type Slot = "index" | "pair";

export interface Instrument {
  id: string;
  name: string;
  /** Provider-specific ticker, e.g. "^DJI", "KRW=X", "BTC-USD". */
  symbol: string;
  slot: Slot;
  /** Flag or badge to draw beside the name: us | kr | eu | jp | cn | btc | … */
  icon: string;
  /** Off instruments stay in the config so they can be switched back on. */
  enabled: boolean;
}

export interface Quote {
  instrumentId: string;
  symbol: string;
  price: number;
  /** Absent when the provider did not give one; the price is still usable. */
  previousClose: number | null;
  currency: string | null;
  ts: string;
  source: string;
}

// --- Stage 4 -----------------------------------------------------------------

/**
 * Which backend produced an event. Stored on every row so a sample summary can
 * never be mistaken for real analysis — the same rule as "별일 없음" vs
 * "수집 실패" in docs/DESIGN.md §1: the app must not blur what it knows.
 */
export type ProviderName = "mock" | "anthropic";

export interface SynthesizedEvent {
  title: string;
  summary: string;
  importance: number;
  category: (typeof EVENT_CATEGORIES)[number];
  certainty: Certainty;
  /** Cluster ids this event rests on. An event with none is discarded. */
  evidence: string[];
  importance_reason: string;
}

export interface SynthesisOutput {
  events: SynthesizedEvent[];
  one_liner: string;
  no_significant_events: boolean;
}

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
  provider: ProviderName;
}

/**
 * Stage 4, as far as the pipeline is concerned. Swapping mock for a paid API is
 * choosing a different function — nothing upstream changes.
 */
export type Synthesizer = (input: SynthesisInput) => Promise<SynthesisResponse>;
