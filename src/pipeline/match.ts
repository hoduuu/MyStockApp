import type { Cluster, MatchResult } from "../types.js";
import { cosine } from "./embed.js";

export interface OpenEvent {
  id: string;
  title: string;
  embedding: Float32Array;
  lastUpdatedAt: string;
}

/**
 * Stage 3 — decide whether each cluster is a new event or a follow-up.
 *
 * This is what makes the app quiet. A cluster that matches an open event never
 * reaches the LLM: its articles are attached to the existing event and the
 * follow-up counter ticks up (brainstorm doc §4, "반복/후속").
 *
 * A cluster matches at most one event, and each event absorbs at most one
 * cluster per run — otherwise two distinct new stories about one running theme
 * would collapse into a single follow-up.
 */
export function matchClusters(
  clusters: Cluster[],
  openEvents: OpenEvent[],
  opts: { threshold: number },
): MatchResult[] {
  const pairs: { ci: number; ei: number; score: number }[] = [];
  clusters.forEach((cluster, ci) => {
    openEvents.forEach((event, ei) => {
      const score = cosine(cluster.centroid, event.embedding);
      if (score >= opts.threshold) pairs.push({ ci, ei, score });
    });
  });

  pairs.sort((a, b) => b.score - a.score);

  const clusterTaken = new Set<number>();
  const eventTaken = new Set<number>();
  const assigned = new Map<number, { eventId: string; score: number }>();

  for (const { ci, ei, score } of pairs) {
    if (clusterTaken.has(ci) || eventTaken.has(ei)) continue;
    clusterTaken.add(ci);
    eventTaken.add(ei);
    assigned.set(ci, { eventId: openEvents[ei]!.id, score });
  }

  return clusters.map((cluster, ci) => {
    const hit = assigned.get(ci);
    return {
      cluster,
      matchedEventId: hit?.eventId ?? null,
      similarity: hit?.score ?? 0,
    };
  });
}

/**
 * docs/DESIGN.md §4: an event with no new coverage for `days` stops being
 * matchable, so a theme that resurfaces later becomes a new event.
 */
export function closeStaleEvents(
  events: { id: string; lastUpdatedAt: string }[],
  days: number,
  now = new Date(),
): string[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return events.filter((e) => Date.parse(e.lastUpdatedAt) < cutoff).map((e) => e.id);
}
