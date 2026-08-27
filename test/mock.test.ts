import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { Embedder } from "../src/pipeline/embed.js";
import { mockSynthesize } from "../src/pipeline/mock.js";
import { collectAsset } from "../src/pipeline/run.js";
import { buildBrief, renderBrief } from "../src/report/brief.js";
import { parseFeed } from "../src/sources/rss.js";
import type { Article, Cluster, SynthesisInput } from "../src/types.js";

/**
 * Mock Stage 4 — the free path. These tests are what makes "runs without an
 * API key" a checked property rather than a claim.
 */

const stubEmbedder: Embedder = {
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((raw) => {
      const text = raw.toLowerCase();
      const v = Float32Array.from(["china", "earnings", "oracle", "chip"], (t) =>
        text.includes(t) ? 1 : 0,
      );
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm) as Float32Array;
    });
  },
};

const NOW = new Date("2026-08-19T18:00:00Z");
const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  assets: [{ symbol: "NVDA", name: "엔비디아", aliases: ["Nvidia"] }],
};

function article(over: Partial<Article> = {}): Article {
  return {
    id: over.id ?? "art_1",
    urlCanonical: over.urlCanonical ?? "https://example.com/1",
    title: over.title ?? "Some company news",
    titleNorm: over.titleNorm ?? "some company news",
    source: over.source ?? "Reuters",
    snippet: over.snippet ?? "",
    publishedAt: over.publishedAt ?? "2026-08-19T10:00:00Z",
  };
}

function cluster(articles: Article[]): Cluster {
  return { articles, centroid: new Float32Array([1]), representative: articles[0]! };
}

function input(clusters: { id: string; cluster: Cluster }[]): SynthesisInput {
  return {
    assetSymbol: "NVDA",
    assetName: "엔비디아",
    clusters,
    openEventTitles: [],
    windowLabel: "최근 7일",
  };
}

test("mock needs no API key and reports zero cost", async () => {
  const res = await mockSynthesize(
    input([{ id: "cluster_1", cluster: cluster([article({ title: "Nvidia quarterly earnings beat" })]) }]),
  );

  assert.equal(res.provider, "mock");
  assert.equal(res.usage.costUsd, 0);
  assert.equal(res.usage.inputTokens, 0);
  assert.equal(res.usage.model, "mock");
});

test("a keyword-matching story becomes an event, scored by category", async () => {
  const res = await mockSynthesize(
    input([
      { id: "cluster_1", cluster: cluster([article({ title: "Nvidia Q3 earnings top estimates" })]) },
    ]),
  );

  assert.equal(res.output.events.length, 1);
  assert.equal(res.output.events[0]!.category, "earnings");
  assert.deepEqual(res.output.events[0]!.evidence, ["cluster_1"]);
});

test("a generic single-source story falls below the floor and is dropped", async () => {
  const res = await mockSynthesize(
    input([{ id: "cluster_1", cluster: cluster([article({ title: "Why this stock moved today" })]) }]),
  );

  assert.deepEqual(res.output.events, []);
  assert.equal(res.output.no_significant_events, true);
  assert.equal(res.output.one_liner, "");
});

test("wider coverage scores higher than a lone report of the same kind", async () => {
  const one = await mockSynthesize(
    input([{ id: "c", cluster: cluster([article({ title: "Nvidia unveils new chip", source: "Reuters" })]) }]),
  );
  const many = await mockSynthesize(
    input([
      {
        id: "c",
        cluster: cluster([
          article({ id: "a1", title: "Nvidia unveils new chip", source: "Reuters" }),
          article({ id: "a2", title: "Nvidia launches next-gen part", source: "Bloomberg" }),
          article({ id: "a3", title: "Nvidia introduces accelerator", source: "CNBC" }),
        ]),
      },
    ]),
  );

  assert.ok(many.output.events[0]!.importance > one.output.events[0]!.importance);
});

test("mock summaries never invent text beyond the article fields", async () => {
  const res = await mockSynthesize(
    input([
      {
        id: "c",
        cluster: cluster([
          article({ title: "Nvidia signs $8 billion supply contract", source: "Reuters", snippet: "The deal covers 2027." }),
        ]),
      },
    ]),
  );

  // Just the representative article's own lede — no clustering commentary
  // ("N건의 기사가 같은 사건으로 묶였습니다") and no source name, since that's
  // already shown next to the event as a real link, not restated in prose.
  assert.equal(res.output.events[0]!.summary, "The deal covers 2027.");
});

test("a snippet-less article says so rather than leaving the summary blank", async () => {
  const res = await mockSynthesize(
    input([{ id: "c", cluster: cluster([article({ title: "Nvidia CEO appoints new lead", snippet: "" })]) }]),
  );
  assert.equal(res.output.events[0]!.summary, "본문 요약이 제공되지 않았습니다.");
});

test("events are ordered by importance", async () => {
  const res = await mockSynthesize(
    input([
      { id: "c1", cluster: cluster([article({ id: "a1", title: "Nvidia CEO appoints new lead" })]) },
      { id: "c2", cluster: cluster([article({ id: "a2", title: "Nvidia quarterly revenue jumps" })]) },
    ]),
  );

  const scores = res.output.events.map((e) => e.importance);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("a full collect run works end to end with no key, and the brief flags it as sample text", async () => {
  const db = openDb(":memory:");
  const items = parseFeed(fs.readFileSync("fixtures/nvda-sample.xml", "utf8"), "fixture");

  const stats = await collectAsset(db, "NVDA", {
    config: CONFIG, // aiProvider defaults to "mock"
    embedder: stubEmbedder,
    itemsOverride: items,
    now: NOW,
  });

  assert.equal(stats.provider, "mock");
  assert.equal(stats.costUsd, 0);

  const rendered = renderBrief(buildBrief(db, CONFIG, 7, 40, NOW), "7일");
  if (stats.eventsCreated > 0) {
    assert.match(rendered, /\[샘플\]/);
    assert.match(rendered, /실제 AI 분석이 아닙니다/);
  }
  db.close();
});
