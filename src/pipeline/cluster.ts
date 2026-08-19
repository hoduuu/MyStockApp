import type { Article, Cluster } from "../types.js";
import { centroid, cosine } from "./embed.js";

/**
 * Stage 2 — group articles that describe the same happening.
 *
 * Greedy single-pass agglomeration in publication order. Each article joins the
 * best-matching open cluster above threshold, or starts its own. Deliberately
 * not k-means: the number of events per day is exactly what we don't know.
 */
export function clusterArticles(
  articles: Article[],
  vectors: Map<string, Float32Array>,
  opts: { threshold: number; windowHours: number },
): Cluster[] {
  const ordered = [...articles].sort(
    (a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt),
  );

  const groups: { articles: Article[]; vectors: Float32Array[]; centroid: Float32Array; latest: number }[] = [];
  const windowMs = opts.windowHours * 3_600_000;

  for (const article of ordered) {
    const vec = vectors.get(article.id);
    if (!vec) continue;
    const published = Date.parse(article.publishedAt);

    let best: (typeof groups)[number] | null = null;
    let bestScore = opts.threshold;

    for (const g of groups) {
      if (published - g.latest > windowMs) continue;
      const score = cosine(vec, g.centroid);
      if (score >= bestScore) {
        best = g;
        bestScore = score;
      }
    }

    if (best) {
      best.articles.push(article);
      best.vectors.push(vec);
      best.centroid = centroid(best.vectors);
      best.latest = Math.max(best.latest, published);
    } else {
      groups.push({
        articles: [article],
        vectors: [vec],
        centroid: vec,
        latest: published,
      });
    }
  }

  return groups.map((g) => ({
    articles: g.articles,
    centroid: g.centroid,
    representative: pickRepresentative(g.articles),
  }));
}

/**
 * The article shown to the LLM as the cluster's stand-in. Earliest wins: the
 * first report of a story states the facts, later ones add commentary.
 */
function pickRepresentative(articles: Article[]): Article {
  return [...articles].sort((a, b) => {
    const t = Date.parse(a.publishedAt) - Date.parse(b.publishedAt);
    if (t !== 0) return t;
    return b.snippet.length - a.snippet.length;
  })[0]!;
}

/**
 * Up to `limit` articles from distinct publishers, for the "관련 기사" block
 * (brainstorm doc §7 asks for 2–3 different outlets).
 */
export function diverseSources(cluster: Cluster, limit = 3): Article[] {
  const seen = new Set<string>();
  const out: Article[] = [];
  const ordered = [cluster.representative, ...cluster.articles.filter((a) => a.id !== cluster.representative.id)];
  for (const a of ordered) {
    const key = a.source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}
