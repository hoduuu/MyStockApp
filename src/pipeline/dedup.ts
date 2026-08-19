import { createHash } from "node:crypto";
import type { Article, RawItem, Stage1Result } from "../types.js";
import { canonicalUrl, jaccard, normalizeTitle, titleTokens } from "./normalize.js";
import { classifyNoise } from "./noise.js";

/**
 * Stage 1 — rule-based reduction. No LLM, no network, no embeddings.
 *
 * docs/DESIGN.md §4 calls for SimHash here; token-Jaccard is used instead.
 * SimHash is the right tool for millions of documents, but on headline-length
 * strings its bit signature is dominated by a handful of tokens and it both
 * misses real duplicates and merges unrelated ones. At Phase 0 volume
 * (hundreds of items per run) the O(n²) exact comparison is a few milliseconds
 * and is markedly more accurate. Revisit if a run ever exceeds ~5k articles.
 */
export function stage1(
  items: RawItem[],
  opts: {
    nearDuplicateThreshold: number;
    maxAgeDays: number;
    now?: Date;
    /** Canonical URLs already stored, so re-fetches are cheap no-ops. */
    knownUrls?: Set<string>;
    /**
     * Normalized titles already stored. Required for correctness, not speed:
     * a near-duplicate is dropped rather than stored, so on the next run its
     * URL is unknown and — without this — it would be admitted as the "first"
     * copy of a story we already have. Feeds re-serve the same window every
     * few hours, so that leaks one extra copy per run.
     */
    knownTitleNorms?: { id: string; titleNorm: string }[];
  },
): Stage1Result {
  const now = opts.now ?? new Date();
  const oldestAllowed = now.getTime() - opts.maxAgeDays * 86_400_000;

  const kept: Article[] = [];
  const dropped: Stage1Result["dropped"] = [];
  const seenUrls = new Set(opts.knownUrls ?? []);
  const keptTokens: { id: string; tokens: Set<string> }[] = (opts.knownTitleNorms ?? []).map(
    (k) => ({ id: k.id, tokens: titleTokens(k.titleNorm) }),
  );

  // Oldest first, so the earliest report of a story is the one we keep.
  const ordered = [...items].sort(
    (a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt),
  );

  for (const item of ordered) {
    const published = Date.parse(item.publishedAt);
    if (Number.isFinite(published) && published < oldestAllowed) {
      dropped.push({ item, reason: "too_old" });
      continue;
    }

    const url = canonicalUrl(item.link);
    if (seenUrls.has(url)) {
      dropped.push({ item, reason: "duplicate_url", duplicateOf: url });
      continue;
    }

    const noise = classifyNoise(item.title);
    if (noise.isNoise) {
      dropped.push({ item, reason: "noise", duplicateOf: noise.pattern });
      continue;
    }

    const titleNorm = normalizeTitle(item.title);
    const tokens = titleTokens(titleNorm);

    const dup = keptTokens.find(
      (k) => jaccard(k.tokens, tokens) >= opts.nearDuplicateThreshold,
    );
    if (dup) {
      dropped.push({ item, reason: "near_duplicate", duplicateOf: dup.id });
      continue;
    }

    const article: Article = {
      id: articleId(url),
      urlCanonical: url,
      title: item.title.trim(),
      titleNorm,
      source: item.source,
      snippet: item.snippet.trim(),
      publishedAt: item.publishedAt,
    };
    kept.push(article);
    seenUrls.add(url);
    keptTokens.push({ id: article.id, tokens });
  }

  return { kept, dropped };
}

export function articleId(canonical: string): string {
  return "art_" + createHash("sha1").update(canonical).digest("hex").slice(0, 16);
}
