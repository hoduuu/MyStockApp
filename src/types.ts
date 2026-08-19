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
export type DropReason = "duplicate_url" | "near_duplicate" | "noise" | "too_old";

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
