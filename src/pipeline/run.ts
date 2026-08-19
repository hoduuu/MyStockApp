import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import { blobToVec, vecToBlob } from "../db.js";
import { feedsForAsset } from "../sources/feeds.js";
import { fetchFeed } from "../sources/rss.js";
import type {
  Article,
  Cluster,
  ProviderName,
  RawItem,
  Stage1Result,
  SynthesisOutput,
  Synthesizer,
} from "../types.js";
import { clusterArticles } from "./cluster.js";
import { stage1 } from "./dedup.js";
import { centroid, embeddingText, type Embedder } from "./embed.js";
import { closeStaleEvents, matchClusters, type OpenEvent } from "./match.js";
import { createSynthesizer } from "./provider.js";

export interface CollectStats {
  assetSymbol: string;
  fetched: number;
  dropped: Record<string, number>;
  kept: number;
  clusters: number;
  followups: number;
  newEventCandidates: number;
  eventsCreated: number;
  closedEvents: number;
  llmCalled: boolean;
  provider: ProviderName | null;
  costUsd: number;
  noSignificantEvents: boolean;
}

export interface CollectOptions {
  config: Config;
  embedder: Embedder;
  /** Skip Stage 4 entirely — `--dry-run`, for tuning Stages 1–3. */
  skipLlm?: boolean;
  /** Override the collected items, for offline runs against a fixture. */
  itemsOverride?: RawItem[];
  /** Stage 4 backend. Defaults to the config's provider (mock unless changed). */
  synthesizer?: Synthesizer;
  /** Print what landed in each cluster. The tool for tuning clusterThreshold. */
  verbose?: boolean;
  model?: string;
  now?: Date;
  onLog?: (line: string) => void;
}

export async function collectAsset(
  db: DatabaseSync,
  symbol: string,
  opts: CollectOptions,
): Promise<CollectStats> {
  const { config, embedder } = opts;
  const now = opts.now ?? new Date();
  const log = opts.onLog ?? (() => {});
  const asset = config.assets.find((a) => a.symbol === symbol);
  const assetName = asset?.name ?? symbol;

  const jobRunId = startJobRun(db, "collect", symbol, now);
  const stats: CollectStats = {
    assetSymbol: symbol,
    fetched: 0,
    dropped: {},
    kept: 0,
    clusters: 0,
    followups: 0,
    newEventCandidates: 0,
    eventsCreated: 0,
    closedEvents: 0,
    llmCalled: false,
    provider: null,
    costUsd: 0,
    noSignificantEvents: false,
  };

  try {
    // --- collect -----------------------------------------------------------
    const items = opts.itemsOverride ?? (await fetchAll(symbol, config, log));
    stats.fetched = items.length;

    // --- Stage 1 -----------------------------------------------------------
    const known = knownArticles(db, symbol, config.maxArticleAgeDays, now);
    const result = stage1(items, {
      nearDuplicateThreshold: config.nearDuplicateThreshold,
      maxAgeDays: config.maxArticleAgeDays,
      now,
      knownUrls: known.urls,
      knownTitleNorms: known.titles,
      relevance: asset
        ? { symbol: asset.symbol, name: asset.name, aliases: asset.aliases }
        : undefined,
    });
    stats.dropped = countReasons(result);
    stats.kept = result.kept.length;
    log(`stage1: ${items.length} → ${result.kept.length} (${formatDrops(stats.dropped)})`);

    // What was dropped, not just how much. "off_topic 7" is indistinguishable
    // from a broken alias list until you can read the seven headlines — and
    // the expensive mistake here is discarding a real story, which leaves no
    // other trace anywhere in the pipeline.
    if (opts.verbose) {
      for (const d of result.dropped) {
        const why = d.duplicateOf ? `${d.reason}:${d.duplicateOf}` : d.reason;
        log(`  ✕ [${why}] ${d.item.title}`);
      }
      for (const a of result.kept) log(`  ✓ ${a.title}`);
    }

    insertArticles(db, symbol, result.kept, now);

    // --- close stale events before matching --------------------------------
    // Read every open event, not a recent slice: an event older than the slice
    // would otherwise never be evaluated and would stay open forever.
    const allOpen = readOpenEvents(db, symbol);
    const stale = closeStaleEvents(allOpen, config.eventCloseDays, now);
    if (stale.length > 0) {
      const stmt = db.prepare("UPDATE events SET status = 'closed' WHERE id = ?");
      for (const id of stale) stmt.run(id);
      stats.closedEvents = stale.length;
    }
    const openEvents = allOpen.filter((e) => !stale.includes(e.id));

    if (result.kept.length === 0) {
      log("새 기사가 없습니다.");
      stats.noSignificantEvents = true;
      finishJobRun(db, jobRunId, true, null, stats, now);
      return stats;
    }

    // --- Stage 2 -----------------------------------------------------------
    const vectors = await embedArticles(embedder, result.kept);
    const clusters = clusterArticles(result.kept, vectors, {
      threshold: config.clusterThreshold,
      windowHours: config.clusterWindowHours,
    });
    stats.clusters = clusters.length;
    log(`stage2: ${result.kept.length}건 → 클러스터 ${clusters.length}개`);

    // The cluster count alone cannot tell over-merging from under-merging —
    // 5 articles landing in 4 clusters is correct only if the *right* pair
    // merged. Threshold tuning needs to see composition, not totals.
    if (opts.verbose) {
      clusters.forEach((c, i) => {
        log(`  [${i + 1}] ${c.articles.length}건`);
        for (const a of c.articles) log(`      · ${a.source} — ${a.title}`);
      });
    }

    // --- Stage 3 -----------------------------------------------------------
    const matches = matchClusters(clusters, openEvents, {
      threshold: config.eventMatchThreshold,
    });
    const followups = matches.filter((m) => m.matchedEventId !== null);
    const fresh = matches.filter((m) => m.matchedEventId === null);
    stats.followups = followups.length;
    stats.newEventCandidates = fresh.length;
    log(`stage3: 후속 ${followups.length} / 신규 후보 ${fresh.length}`);

    // Every cluster's nearest open event, accepted or not. A follow-up that
    // should not have been one, and a new event that should have been a
    // follow-up, both look identical in the counts above.
    if (opts.verbose) {
      for (const m of matches) {
        const verdict = m.matchedEventId ? "후속" : "신규";
        const near = m.bestEventTitle
          ? `최근접 ${m.bestSimilarity.toFixed(3)} — ${m.bestEventTitle}`
          : "비교할 열린 사건 없음";
        log(`  [${verdict}] ${m.cluster.representative.title}`);
        log(`         ${near}`);
      }
    }

    for (const m of followups) {
      attachFollowup(db, m.matchedEventId!, m.cluster, now);
    }

    if (fresh.length === 0) {
      log("신규 사건 후보가 없습니다 — LLM 호출을 건너뜁니다.");
      stats.noSignificantEvents = true;
      finishJobRun(db, jobRunId, true, null, stats, now);
      return stats;
    }

    if (opts.skipLlm) {
      log(`stage4: 건너뜀 (--dry-run). 신규 후보 ${fresh.length}개가 LLM에 갈 예정이었습니다.`);
      finishJobRun(db, jobRunId, true, null, stats, now);
      return stats;
    }

    // --- Stage 4 -----------------------------------------------------------
    const labelled = fresh.map((m, i) => ({ id: `cluster_${i + 1}`, cluster: m.cluster }));
    const model = opts.model ?? config.model;
    const synthesize =
      opts.synthesizer ?? createSynthesizer(config.aiProvider, { model });

    const { output, usage, provider } = await synthesize({
      assetSymbol: symbol,
      assetName,
      clusters: labelled,
      openEventTitles: openEvents.map((e) => e.title),
      windowLabel: `최근 ${config.maxArticleAgeDays}일`,
    });

    stats.llmCalled = true;
    stats.provider = provider;
    stats.costUsd = usage.costUsd;
    stats.noSignificantEvents = output.no_significant_events;
    recordUsage(db, jobRunId, symbol, usage, now);

    const created = await persistEvents(db, symbol, output, labelled, provider, embedder, now);
    stats.eventsCreated = created;
    log(
      output.no_significant_events && created === 0
        ? `stage4[${provider}]: 특별히 새로운 중요한 사건은 없습니다.`
        : `stage4[${provider}]: 사건 ${created}개 생성 ($${usage.costUsd.toFixed(4)})`,
    );

    finishJobRun(db, jobRunId, true, null, stats, now);
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJobRun(db, jobRunId, false, message, stats, now);
    throw err;
  }
}

// --- collection --------------------------------------------------------------

async function fetchAll(symbol: string, config: Config, log: (s: string) => void): Promise<RawItem[]> {
  const urls = feedsForAsset(symbol, config);
  const all: RawItem[] = [];
  for (const url of urls) {
    try {
      const items = await fetchFeed(url);
      log(`  feed ok (${items.length}건): ${url}`);
      all.push(...items);
    } catch (err) {
      // One dead feed must not lose the whole run; the gap is recorded in job_runs.
      log(`  feed 실패: ${url} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return all;
}

async function embedArticles(embedder: Embedder, articles: Article[]): Promise<Map<string, Float32Array>> {
  const vectors = await embedder.embed(articles.map(embeddingText));
  return new Map(articles.map((a, i) => [a.id, vectors[i]!]));
}

// --- persistence -------------------------------------------------------------

/**
 * URLs are checked across all history (cheap, and a repost of a year-old link
 * is still a repost); titles only within the collection window, since two
 * unrelated stories months apart may legitimately share a headline shape.
 */
function knownArticles(
  db: DatabaseSync,
  symbol: string,
  windowDays: number,
  now: Date,
): { urls: Set<string>; titles: { id: string; titleNorm: string }[] } {
  const urlRows = db
    .prepare("SELECT url_canonical FROM articles WHERE asset_symbol = ?")
    .all(symbol) as { url_canonical: string }[];

  const cutoff = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const titleRows = db
    .prepare("SELECT id, title_norm FROM articles WHERE asset_symbol = ? AND published_at >= ?")
    .all(symbol, cutoff) as { id: string; title_norm: string }[];

  return {
    urls: new Set(urlRows.map((r) => r.url_canonical)),
    titles: titleRows.map((r) => ({ id: r.id, titleNorm: r.title_norm })),
  };
}

function insertArticles(db: DatabaseSync, symbol: string, articles: Article[], now: Date): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO articles
      (id, url_canonical, title, title_norm, source, snippet, published_at, fetched_at, asset_symbol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of articles) {
    stmt.run(a.id, a.urlCanonical, a.title, a.titleNorm, a.source, a.snippet, a.publishedAt, now.toISOString(), symbol);
  }
}

function readOpenEvents(db: DatabaseSync, symbol: string): OpenEvent[] {
  const rows = db
    .prepare(
      `SELECT id, title, last_updated_at, embedding FROM events
       WHERE asset_symbol = ? AND status = 'open'`,
    )
    .all(symbol) as { id: string; title: string; last_updated_at: string; embedding: Uint8Array | null }[];

  return rows
    .filter((r) => r.embedding !== null)
    .map((r) => ({
      id: r.id,
      title: r.title,
      embedding: blobToVec(r.embedding!),
      lastUpdatedAt: r.last_updated_at,
    }));
}

function attachFollowup(db: DatabaseSync, eventId: string, cluster: Cluster, now: Date): void {
  const link = db.prepare(
    "INSERT OR IGNORE INTO event_articles (event_id, article_id, is_primary) VALUES (?, ?, 0)",
  );
  for (const a of cluster.articles) link.run(eventId, a.id);

  // Importance stays frozen at creation time (docs/DESIGN.md §4) so the
  // timeline does not reshuffle every run.
  db.prepare(
    `UPDATE events SET followup_count = followup_count + 1, last_updated_at = ? WHERE id = ?`,
  ).run(now.toISOString(), eventId);
}

async function persistEvents(
  db: DatabaseSync,
  symbol: string,
  output: SynthesisOutput,
  labelled: { id: string; cluster: Cluster }[],
  provider: ProviderName,
  embedder: Embedder,
  now: Date,
): Promise<number> {
  if (output.events.length === 0) return 0;

  const byLabel = new Map(labelled.map((l) => [l.id, l.cluster]));
  const embeddings = await embedder.embed(
    output.events.map((e) => `${e.title}. ${e.summary}`),
  );

  const insertEvent = db.prepare(`
    INSERT INTO events
      (id, asset_symbol, title, summary, importance, category, certainty, status,
       first_seen_at, last_updated_at, followup_count, importance_reason, provider, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 0, ?, ?, ?)
  `);
  const linkArticle = db.prepare(
    "INSERT OR IGNORE INTO event_articles (event_id, article_id, is_primary) VALUES (?, ?, ?)",
  );

  let created = 0;
  output.events.forEach((e, i) => {
    const clusters = e.evidence.map((label) => byLabel.get(label)).filter((c): c is Cluster => c !== undefined);
    if (clusters.length === 0) return; // hallucinated evidence label — drop

    const earliest = clusters
      .flatMap((c) => c.articles)
      .reduce((min, a) => (Date.parse(a.publishedAt) < Date.parse(min) ? a.publishedAt : min), now.toISOString());

    const id = "evt_" + createHash("sha1").update(`${symbol}|${e.title}|${earliest}`).digest("hex").slice(0, 16);

    insertEvent.run(
      id, symbol, e.title, e.summary, e.importance, e.category, e.certainty,
      earliest, now.toISOString(), e.importance_reason, provider, vecToBlob(embeddings[i]!),
    );

    for (const cluster of clusters) {
      linkArticle.run(id, cluster.representative.id, 1);
      for (const a of cluster.articles) {
        if (a.id !== cluster.representative.id) linkArticle.run(id, a.id, 0);
      }
    }
    created++;
  });

  return created;
}

// --- job bookkeeping ---------------------------------------------------------

function startJobRun(db: DatabaseSync, job: string, symbol: string, now: Date): number {
  const info = db
    .prepare("INSERT INTO job_runs (job, asset_symbol, started_at) VALUES (?, ?, ?)")
    .run(job, symbol, now.toISOString());
  return Number(info.lastInsertRowid);
}

function finishJobRun(
  db: DatabaseSync,
  id: number,
  ok: boolean,
  error: string | null,
  stats: CollectStats,
  now: Date,
): void {
  db.prepare("UPDATE job_runs SET finished_at = ?, ok = ?, error = ?, stats_json = ? WHERE id = ?").run(
    now.toISOString(), ok ? 1 : 0, error, JSON.stringify(stats), id,
  );
}

function recordUsage(
  db: DatabaseSync,
  jobRunId: number,
  symbol: string,
  usage: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number },
  now: Date,
): void {
  db.prepare(`
    INSERT INTO llm_usage
      (ts, job_run_id, model, asset_symbol, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now.toISOString(), jobRunId, usage.model, symbol, usage.inputTokens,
    usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens, usage.costUsd,
  );
}

// --- helpers -----------------------------------------------------------------

function countReasons(result: Stage1Result): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of result.dropped) out[d.reason] = (out[d.reason] ?? 0) + 1;
  return out;
}

function formatDrops(dropped: Record<string, number>): string {
  const entries = Object.entries(dropped);
  return entries.length === 0 ? "제거 없음" : entries.map(([k, v]) => `${k} ${v}`).join(", ");
}

export function centroidOf(vectors: Float32Array[]): Float32Array {
  return centroid(vectors);
}
