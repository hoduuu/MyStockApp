import type { DatabaseSync } from "node:sqlite";

/**
 * 사건 기록장 (brainstorm doc §6) — every event for one asset in date order,
 * so a month can be reviewed at a glance.
 *
 * Two things separate this from the brief, and both are the point:
 *
 *  · No importance floor. The brief shows what was worth interrupting you for;
 *    the record shows what happened. Something judged minor at the time is
 *    exactly what you go looking for when a story turns out to matter later.
 *  · Closed events included. An event closes after a week without coverage
 *    (§4); that ends its matching life, not its existence.
 */
export interface TimelineEntry {
  id: string;
  date: string;
  title: string;
  summary: string;
  importance: number;
  category: string;
  certainty: string;
  status: string;
  followupCount: number;
  provider: string;
  articles: { source: string; title: string; url: string }[];
}

export interface Timeline {
  symbol: string;
  name: string;
  days: number;
  entries: TimelineEntry[];
}

export function buildTimeline(
  db: DatabaseSync,
  asset: { symbol: string; name: string },
  days: number,
  now = new Date(),
): Timeline {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();

  const rows = db
    .prepare(
      `SELECT id, title, summary, importance, category, certainty, status,
              first_seen_at, followup_count, provider
       FROM events
       WHERE asset_symbol = ? AND first_seen_at >= ?
       ORDER BY first_seen_at DESC`,
    )
    .all(asset.symbol, since) as {
    id: string; title: string; summary: string; importance: number; category: string;
    certainty: string; status: string; first_seen_at: string; followup_count: number;
    provider: string;
  }[];

  const articleStmt = db.prepare(
    `SELECT a.source, a.title, a.url_canonical
     FROM event_articles ea JOIN articles a ON a.id = ea.article_id
     WHERE ea.event_id = ?
     ORDER BY ea.is_primary DESC, a.published_at ASC`,
  );

  return {
    symbol: asset.symbol,
    name: asset.name,
    days,
    entries: rows.map((r) => ({
      id: r.id,
      date: r.first_seen_at,
      title: r.title,
      summary: r.summary,
      importance: r.importance,
      category: r.category,
      certainty: r.certainty,
      status: r.status,
      followupCount: r.followup_count,
      provider: r.provider,
      articles: (articleStmt.all(r.id) as { source: string; title: string; url_canonical: string }[])
        .map((a) => ({ source: a.source, title: a.title, url: a.url_canonical })),
    })),
  };
}

export function renderTimeline(t: Timeline): string {
  const lines: string[] = ["", `━━ ${t.symbol} — ${t.name} · 최근 ${t.days}일 ━━`, ""];

  if (t.entries.length === 0) {
    lines.push("  기록된 사건이 없습니다.", "");
    return lines.join("\n");
  }

  let lastMonth = "";
  for (const e of t.entries) {
    const month = e.date.slice(0, 7);
    if (month !== lastMonth) {
      lines.push(`${month.replace("-", "년 ")}월`, "");
      lastMonth = month;
    }

    const flags = [
      e.status === "closed" ? "종료" : null,
      e.certainty === "speculative" ? "전망" : null,
      e.provider === "mock" ? "규칙 요약" : null,
    ].filter(Boolean);

    lines.push(
      `  ${e.date.slice(8, 10)}일  ${e.title}` +
        (flags.length > 0 ? `  [${flags.join(" · ")}]` : ""),
    );
    lines.push(`        중요도 ${e.importance} · ${e.category}` +
      (e.followupCount > 0 ? ` · 후속 ${e.followupCount}건` : ""));
    lines.push("");
  }

  lines.push(`  총 ${t.entries.length}건`, "");
  return lines.join("\n");
}
