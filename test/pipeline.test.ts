import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { openDb, vecToBlob } from "../src/db.js";
import type { Embedder } from "../src/pipeline/embed.js";
import { collectAsset, collectMarketNews } from "../src/pipeline/run.js";
import { buildBrief } from "../src/report/brief.js";
import { parseFeed } from "../src/sources/rss.js";

/**
 * Orchestration tests. The real embedder needs a model download and Stage 4
 * needs an API key, so this exercises Stages 1–3 plus persistence with a stub
 * embedder and `skipLlm`.
 *
 * The stub is a bag-of-words indicator over a fixed vocabulary — crude, but it
 * produces genuine cosine geometry, so cluster and match thresholds are really
 * being tested. It says nothing about whether the actual multilingual model
 * separates these stories; that is what the 2-week local run is for.
 */
const VOCAB = [
  "h200", "china", "supply", "regulator", "review",
  "oracle", "data center", "expansion", "capacity", "billion",
  "automotive", "chip",
];

const stubEmbedder: Embedder = {
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((raw) => {
      const text = raw.toLowerCase();
      const v = Float32Array.from(VOCAB, (term) => (text.includes(term) ? 1 : 0));
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm) as Float32Array;
    });
  },
};

const NOW = new Date("2026-08-19T18:00:00Z");

/**
 * Thresholds are pinned here rather than inherited from DEFAULT_CONFIG on
 * purpose. The production values are calibrated against the real e5 model's
 * similarity distribution; the stub above is a bag-of-words indicator whose
 * geometry is unrelated (the Oracle pair sits at ~0.89 here, ~0.96 there).
 *
 * Coupling these tests to the production constant would mean every threshold
 * retune breaks them for reasons that say nothing about the code. What is
 * under test is the orchestration — does Stage 2 merge what clears the bar,
 * does Stage 3 file the result as a follow-up — not the bar itself. Whether
 * the bar is right can only be checked against the real model, by eye, with
 * `collect --verbose` (docs/DESIGN.md §4).
 */
const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  assets: [{ symbol: "NVDA", name: "엔비디아", aliases: ["Nvidia"] }],
  clusterThreshold: 0.78,
  eventMatchThreshold: 0.75,
};

function fixtureItems() {
  return parseFeed(fs.readFileSync("fixtures/nvda-sample.xml", "utf8"), "fixture");
}

async function runCollect(db: ReturnType<typeof openDb>, extra: Partial<Parameters<typeof collectAsset>[2]> = {}) {
  return collectAsset(db, "NVDA", {
    config: CONFIG,
    embedder: stubEmbedder,
    skipLlm: true,
    itemsOverride: fixtureItems(),
    now: NOW,
    ...extra,
  });
}

test("stage2 merges the two Oracle reports that stage1 could not", async () => {
  const db = openDb(":memory:");
  const stats = await runCollect(db);

  assert.equal(stats.kept, 5, "stage1 output");
  assert.equal(stats.clusters, 4, "the Reuters and FT Oracle reports become one cluster");
  assert.equal(stats.newEventCandidates, 4);
  assert.equal(stats.followups, 0, "no prior events exist on a first run");
  db.close();
});

test("collected articles are persisted and re-collection adds nothing", async () => {
  const db = openDb(":memory:");
  await runCollect(db);
  const after = db.prepare("SELECT COUNT(*) AS n FROM articles").get() as { n: number };
  assert.equal(after.n, 5);

  const second = await runCollect(db);
  assert.equal(second.kept, 0, "every article is already known");
  assert.equal(second.clusters, 0);
  db.close();
});

test("a cluster matching an existing event is recorded as a follow-up, not a new candidate", async () => {
  const db = openDb(":memory:");

  // Seed an open event whose embedding is the H200 story itself.
  const [h200] = await stubEmbedder.embed([
    "Nvidia weighs new approach to China H200 chip supply, sources say. Nvidia is evaluating changes to how it supplies H200 accelerators to Chinese customers.",
  ]);
  db.prepare(
    `INSERT INTO events (id, asset_symbol, title, summary, importance, category, certainty,
       status, first_seen_at, last_updated_at, followup_count, importance_reason, embedding)
     VALUES ('evt_seed','NVDA','중국향 H200 공급 관련 움직임','요약',75,'regulation','reported',
       'open','2026-08-18T00:00:00Z','2026-08-18T00:00:00Z',0,'', ?)`,
  ).run(vecToBlob(h200!));

  const stats = await runCollect(db);

  assert.equal(stats.followups, 1, "the H200 cluster continues the seeded event");
  assert.equal(stats.newEventCandidates, 3);

  const seeded = db.prepare("SELECT followup_count, importance FROM events WHERE id='evt_seed'").get() as {
    followup_count: number; importance: number;
  };
  assert.equal(seeded.followup_count, 1);
  assert.equal(seeded.importance, 75, "importance is frozen at creation (docs/DESIGN.md §4)");

  const linked = db.prepare("SELECT COUNT(*) AS n FROM event_articles WHERE event_id='evt_seed'").get() as { n: number };
  assert.ok(linked.n >= 1, "the follow-up articles are attached to the event");
  db.close();
});

/**
 * Regression: dropped near-duplicates are never stored, so a URL-only memory
 * lets the next run admit the next copy of a story already covered. Feeds
 * re-serve the same window every few hours, so this leaked one duplicate
 * article — and eventually one duplicate event — per run.
 */
test("re-collecting the same feed does not admit the syndicated copies", async () => {
  const db = openDb(":memory:");
  await runCollect(db);
  await runCollect(db);
  await runCollect(db);

  const total = db.prepare("SELECT COUNT(*) AS n FROM articles").get() as { n: number };
  assert.equal(total.n, 5, "three runs of an unchanged feed must still hold 5 articles");

  const h200 = db
    .prepare("SELECT COUNT(*) AS n FROM articles WHERE title LIKE '%H200 chip supply%'")
    .get() as { n: number };
  assert.equal(h200.n, 1, "only one copy of the wire story, ever");
  db.close();
});

/**
 * Regression: closing used to run over a recent slice of open events, so an
 * event older than that slice was never evaluated and stayed open forever,
 * quietly absorbing unrelated clusters as "follow-ups".
 */
test("an event stale for longer than the matchable slice is still closed", async () => {
  const db = openDb(":memory:");
  const [vec] = await stubEmbedder.embed(["unrelated topic entirely"]);
  db.prepare(
    `INSERT INTO events (id, asset_symbol, title, summary, importance, category, certainty,
       status, first_seen_at, last_updated_at, followup_count, importance_reason, embedding)
     VALUES ('evt_stale','NVDA','오래된 사건','요약',80,'other','reported',
       'open','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z',0,'', ?)`,
  ).run(vecToBlob(vec!));

  const stats = await runCollect(db);
  assert.equal(stats.closedEvents, 1);

  const row = db.prepare("SELECT status FROM events WHERE id='evt_stale'").get() as { status: string };
  assert.equal(row.status, "closed");
  db.close();
});

test("every run is recorded in job_runs, so gaps stay visible", async () => {
  const db = openDb(":memory:");
  await runCollect(db);

  const run = db.prepare("SELECT job, ok, finished_at, stats_json FROM job_runs").get() as {
    job: string; ok: number; finished_at: string | null; stats_json: string;
  };
  assert.equal(run.job, "collect");
  assert.equal(run.ok, 1);
  assert.ok(run.finished_at);
  assert.equal(JSON.parse(run.stats_json).kept, 5);
  db.close();
});

test("a failing feed still records the run, marked failed", async () => {
  const db = openDb(":memory:");
  const exploding: Embedder = {
    embed() {
      return Promise.reject(new Error("embedding backend down"));
    },
  };

  await assert.rejects(
    collectAsset(db, "NVDA", {
      config: CONFIG, embedder: exploding, skipLlm: true,
      itemsOverride: fixtureItems(), now: NOW,
    }),
    /embedding backend down/,
  );

  const run = db.prepare("SELECT ok, error FROM job_runs").get() as { ok: number; error: string };
  assert.equal(run.ok, 0);
  assert.match(run.error, /embedding backend down/);
  db.close();
});

test("dry-run leaves no events behind but does store articles", async () => {
  const db = openDb(":memory:");
  await runCollect(db);

  const events = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  const articles = db.prepare("SELECT COUNT(*) AS n FROM articles").get() as { n: number };
  assert.equal(events.n, 0, "stage 4 was skipped");
  assert.equal(articles.n, 5);
  db.close();
});

test("after a successful run with no events the brief says 'nothing happened', not 'no data'", async () => {
  const db = openDb(":memory:");
  await runCollect(db);

  const brief = buildBrief(db, CONFIG, 1, 40, NOW)[0]!;
  assert.equal(brief.state, "NO_SIGNIFICANT");
  assert.equal(brief.gap, null, "the run just happened, so there is no gap");
  db.close();
});

// --- market-instrument news (나스닥/코스피 등도 뉴스를 받는다) -------------------

test("collectAsset accepts relevance terms for a symbol that isn't a config.assets entry", async () => {
  const db = openDb(":memory:");
  const items = [
    { title: "코스피, 금리 발표 앞두고 관망세", link: "https://e.com/a", source: "Reuters", snippet: "", publishedAt: NOW.toISOString() },
    { title: "Apple unveils new iPhone at annual event", link: "https://e.com/b", source: "Reuters", snippet: "", publishedAt: NOW.toISOString() },
  ];
  const stats = await collectAsset(db, "kospi", {
    config: CONFIG,
    embedder: stubEmbedder,
    skipLlm: true,
    itemsOverride: items,
    now: NOW,
    relevance: { name: "코스피", aliases: ["코스피지수"] },
  });
  assert.equal(stats.kept, 1, "only the KOSPI article is relevant");
  db.close();
});

/**
 * collectMarketNews is the wrapper cli.ts actually calls — it should derive
 * relevance terms from config.ts's MARKET_NEWS_TERMS on its own, and store
 * everything under the instrument's id (not its Yahoo ticker), matching how
 * its price/history are already keyed.
 */
test("collectMarketNews filters by the instrument's own relevance terms and stores under its id", async () => {
  const db = openDb(":memory:");
  const items = [
    { title: "코스피, 금리 발표 앞두고 관망세", link: "https://e.com/a", source: "Reuters", snippet: "", publishedAt: NOW.toISOString() },
    { title: "Apple unveils new iPhone at annual event", link: "https://e.com/b", source: "Reuters", snippet: "", publishedAt: NOW.toISOString() },
  ];
  const stats = await collectMarketNews(
    db,
    { id: "kospi", symbol: "^KS11", name: "코스피" },
    { config: CONFIG, embedder: stubEmbedder, skipLlm: true, itemsOverride: items, now: NOW },
  );
  assert.equal(stats.assetSymbol, "kospi");
  assert.equal(stats.kept, 1);
  db.close();
});
