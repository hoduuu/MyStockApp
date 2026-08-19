import fs from "node:fs";

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
  model: string;
  /** Ignore articles older than this when collecting. */
  maxArticleAgeDays: number;
  /** Stage 1: token-Jaccard above this means "same story, restyled headline". */
  nearDuplicateThreshold: number;
  /** Stage 2: cosine above this puts two articles in one cluster. */
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

export const DEFAULT_CONFIG: Config = {
  dbPath: "mystock.db",
  assets: [{ symbol: "NVDA", name: "엔비디아", aliases: ["Nvidia", "NVIDIA"] }],
  extraFeeds: {},
  model: "claude-opus-5",
  maxArticleAgeDays: 7,
  nearDuplicateThreshold: 0.7,
  clusterThreshold: 0.78,
  eventMatchThreshold: 0.75,
  eventCloseDays: 7,
  clusterWindowHours: 72,
  embeddingModel: "Xenova/multilingual-e5-small",
};

export function loadConfig(path = "mystock.config.json"): Config {
  if (!fs.existsSync(path)) return DEFAULT_CONFIG;
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
