import assert from "node:assert/strict";
import test from "node:test";
import { clusterArticles, diverseSources } from "../src/pipeline/cluster.js";
import { closeStaleEvents, matchClusters, type OpenEvent } from "../src/pipeline/match.js";
import type { Article, Cluster } from "../src/types.js";

/**
 * Vectors are injected rather than computed: the embedding model needs a
 * network download, and these tests are about the grouping logic, not the model.
 */
function vec(...xs: number[]): Float32Array {
  return Float32Array.from(xs);
}

function article(id: string, publishedAt: string, source = "Reuters", snippet = ""): Article {
  return {
    id, urlCanonical: `https://x/${id}`, title: `title ${id}`, titleNorm: `title ${id}`,
    source, snippet, publishedAt,
  };
}

test("groups near-identical vectors and separates distant ones", () => {
  const articles = [
    article("a", "2026-08-18T09:00:00Z"),
    article("b", "2026-08-18T10:00:00Z"),
    article("c", "2026-08-18T11:00:00Z"),
  ];
  const vectors = new Map([
    ["a", vec(1, 0, 0)],
    ["b", vec(0.98, 0.2, 0)],
    ["c", vec(0, 0, 1)],
  ]);

  const clusters = clusterArticles(articles, vectors, { threshold: 0.78, windowHours: 72 });
  assert.equal(clusters.length, 2);
  assert.equal(clusters.find((c) => c.articles.length === 2)?.articles.map((a) => a.id).join(","), "a,b");
});

test("does not group similar articles published outside the window", () => {
  const articles = [article("a", "2026-08-10T09:00:00Z"), article("b", "2026-08-18T09:00:00Z")];
  const vectors = new Map([["a", vec(1, 0)], ["b", vec(1, 0)]]);

  const clusters = clusterArticles(articles, vectors, { threshold: 0.78, windowHours: 72 });
  assert.equal(clusters.length, 2);
});

test("representative is the earliest article in the cluster", () => {
  const articles = [article("late", "2026-08-18T15:00:00Z"), article("early", "2026-08-18T09:00:00Z")];
  const vectors = new Map([["late", vec(1, 0)], ["early", vec(1, 0)]]);

  const clusters = clusterArticles(articles, vectors, { threshold: 0.78, windowHours: 72 });
  assert.equal(clusters[0]!.representative.id, "early");
});

test("articles without a vector are skipped rather than crashing", () => {
  const articles = [article("a", "2026-08-18T09:00:00Z"), article("novec", "2026-08-18T10:00:00Z")];
  const clusters = clusterArticles(articles, new Map([["a", vec(1, 0)]]), { threshold: 0.78, windowHours: 72 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.articles.length, 1);
});

test("diverseSources returns one article per publisher", () => {
  const cluster: Cluster = {
    articles: [
      article("a", "2026-08-18T09:00:00Z", "Reuters"),
      article("b", "2026-08-18T10:00:00Z", "Reuters"),
      article("c", "2026-08-18T11:00:00Z", "Bloomberg"),
      article("d", "2026-08-18T12:00:00Z", "CNBC"),
    ],
    centroid: vec(1, 0),
    representative: article("a", "2026-08-18T09:00:00Z", "Reuters"),
  };
  const picked = diverseSources(cluster, 3);
  assert.deepEqual(picked.map((p) => p.source), ["Reuters", "Bloomberg", "CNBC"]);
});

// --- Stage 3 -----------------------------------------------------------------

function cluster(centroid: Float32Array, id = "x"): Cluster {
  const a = article(id, "2026-08-19T09:00:00Z");
  return { articles: [a], centroid, representative: a };
}

function openEvent(id: string, embedding: Float32Array): OpenEvent {
  return { id, title: `event ${id}`, embedding, lastUpdatedAt: "2026-08-18T09:00:00Z" };
}

test("a cluster close to an open event is a follow-up, not a new event", () => {
  const results = matchClusters([cluster(vec(1, 0, 0))], [openEvent("evt_1", vec(0.99, 0.1, 0))], { threshold: 0.75 });
  assert.equal(results[0]!.matchedEventId, "evt_1");
});

test("a cluster unlike every open event becomes a new event candidate", () => {
  const results = matchClusters([cluster(vec(0, 0, 1))], [openEvent("evt_1", vec(1, 0, 0))], { threshold: 0.75 });
  assert.equal(results[0]!.matchedEventId, null);
});

test("two clusters never collapse onto the same open event", () => {
  const results = matchClusters(
    [cluster(vec(1, 0, 0), "c1"), cluster(vec(0.99, 0.05, 0), "c2")],
    [openEvent("evt_1", vec(1, 0, 0))],
    { threshold: 0.75 },
  );
  const matched = results.filter((r) => r.matchedEventId !== null);
  assert.equal(matched.length, 1, "only the best-scoring cluster may claim the event");
});

test("the higher-scoring cluster wins the contested event", () => {
  const results = matchClusters(
    [cluster(vec(0.8, 0.6, 0), "weak"), cluster(vec(1, 0, 0), "strong")],
    [openEvent("evt_1", vec(1, 0, 0))],
    { threshold: 0.75 },
  );
  assert.equal(results[1]!.matchedEventId, "evt_1");
  assert.equal(results[0]!.matchedEventId, null);
});

test("closeStaleEvents closes only events untouched past the cutoff", () => {
  const closed = closeStaleEvents(
    [
      { id: "old", lastUpdatedAt: "2026-08-01T00:00:00Z" },
      { id: "fresh", lastUpdatedAt: "2026-08-18T00:00:00Z" },
    ],
    7,
    new Date("2026-08-19T00:00:00Z"),
  );
  assert.deepEqual(closed, ["old"]);
});
