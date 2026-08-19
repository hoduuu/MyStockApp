import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";

export type BriefState = "HAS_EVENTS" | "NO_SIGNIFICANT" | "ONLY_FOLLOWUPS" | "NO_DATA";

export interface AssetBrief {
  symbol: string;
  name: string;
  state: BriefState;
  events: {
    id: string;
    title: string;
    summary: string;
    importance: number;
    certainty: string;
    firstSeenAt: string;
    followupCount: number;
    articles: { source: string; title: string; url: string }[];
  }[];
  /** Stretch of the window the collector did not cover, if any. */
  gap: Gap | null;
}

/**
 * `never` — this asset has never been collected successfully. Not a gap in
 * history so much as an absence of history; the fix is to run `collect`.
 * `cold_start` — collection has begun, but the window reaches back before it.
 * Nothing failed; the app simply was not watching yet.
 * `outage` — collection had started and then stopped for a while.
 *
 * All three mean "we don't know", but only one is a malfunction. Telling a
 * user their collector broke when they just added the asset would be a lie,
 * and this app's whole value rests on that distinction being trustworthy.
 */
export interface Gap {
  from: string;
  to: string;
  kind: "never" | "cold_start" | "outage";
}

export function buildBrief(
  db: DatabaseSync,
  config: Config,
  windowDays: number,
  minImportance = 40,
  now = new Date(),
): AssetBrief[] {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  return config.assets.map((asset) => {
    const events = db
      .prepare(
        `SELECT id, title, summary, importance, certainty, first_seen_at, followup_count
         FROM events
         WHERE asset_symbol = ? AND first_seen_at >= ? AND importance >= ?
         ORDER BY importance DESC, first_seen_at DESC`,
      )
      .all(asset.symbol, since, minImportance) as {
      id: string; title: string; summary: string; importance: number;
      certainty: string; first_seen_at: string; followup_count: number;
    }[];

    const articleStmt = db.prepare(
      `SELECT a.source, a.title, a.url_canonical
       FROM event_articles ea JOIN articles a ON a.id = ea.article_id
       WHERE ea.event_id = ?
       ORDER BY ea.is_primary DESC, a.published_at ASC`,
    );

    const gap = findGap(db, asset.symbol, since, now);
    const followupsOnly = countFollowups(db, asset.symbol, since);

    return {
      symbol: asset.symbol,
      name: asset.name,
      state: resolveState(events.length, followupsOnly, gap),
      gap,
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        summary: e.summary,
        importance: e.importance,
        certainty: e.certainty,
        firstSeenAt: e.first_seen_at,
        followupCount: e.followup_count,
        articles: dedupeBySource(
          articleStmt.all(e.id) as { source: string; title: string; url_canonical: string }[],
        ),
      })),
    };
  });
}

/**
 * The distinction docs/DESIGN.md §1 insists on: "nothing happened" and
 * "we failed to look" must never render the same way.
 */
function resolveState(
  eventCount: number,
  followupCount: number,
  gap: Gap | null,
): BriefState {
  if (eventCount > 0) return "HAS_EVENTS";
  if (gap) return "NO_DATA";
  if (followupCount > 0) return "ONLY_FOLLOWUPS";
  return "NO_SIGNIFICANT";
}

/**
 * A gap is any stretch longer than 36h inside the window with no successful
 * run. 36h rather than 24h so a laptop left off overnight is not flagged.
 */
function findGap(db: DatabaseSync, symbol: string, since: string, now: Date): Gap | null {
  const firstEver = db
    .prepare("SELECT MIN(started_at) AS t FROM job_runs WHERE asset_symbol = ? AND ok = 1")
    .get(symbol) as { t: string | null } | undefined;
  const firstRun = firstEver?.t ?? null;

  if (firstRun === null) {
    return { from: since, to: now.toISOString(), kind: "never" };
  }

  // The window opens before this asset was ever collected.
  if (Date.parse(firstRun) > Date.parse(since) + MAX_GAP_MS) {
    return { from: since, to: firstRun, kind: "cold_start" };
  }

  const runs = db
    .prepare(
      `SELECT started_at FROM job_runs
       WHERE asset_symbol = ? AND ok = 1 AND started_at >= ?
       ORDER BY started_at ASC`,
    )
    .all(symbol, since) as { started_at: string }[];

  let cursor = Date.parse(since);
  for (const run of runs) {
    const t = Date.parse(run.started_at);
    if (t - cursor > MAX_GAP_MS) {
      return { from: new Date(cursor).toISOString(), to: new Date(t).toISOString(), kind: "outage" };
    }
    cursor = t;
  }

  if (now.getTime() - cursor > MAX_GAP_MS) {
    return { from: new Date(cursor).toISOString(), to: now.toISOString(), kind: "outage" };
  }
  return null;
}

const MAX_GAP_MS = 36 * 3_600_000;

function countFollowups(db: DatabaseSync, symbol: string, since: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE asset_symbol = ? AND last_updated_at >= ? AND followup_count > 0`,
    )
    .get(symbol, since) as { n: number } | undefined;
  return row?.n ?? 0;
}

function dedupeBySource(
  rows: { source: string; title: string; url_canonical: string }[],
  limit = 3,
): { source: string; title: string; url: string }[] {
  const seen = new Set<string>();
  const out: { source: string; title: string; url: string }[] = [];
  for (const r of rows) {
    const key = r.source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: r.source, title: r.title, url: r.url_canonical });
    if (out.length >= limit) break;
  }
  return out;
}

const STATE_TEXT: Record<BriefState, string> = {
  HAS_EVENTS: "",
  NO_SIGNIFICANT: "특별히 새로운 중요한 사건은 없습니다.",
  ONLY_FOLLOWUPS: "최근 뉴스는 대부분 기존 이슈의 후속 보도입니다.",
  NO_DATA: "",
};

export function renderBrief(briefs: AssetBrief[], windowLabel: string): string {
  const lines: string[] = ["", `━━ 지난 ${windowLabel} 동안 ━━`, ""];

  for (const b of briefs) {
    const badge =
      b.state === "HAS_EVENTS" ? `중요 사건 ${b.events.length}건`
      : b.state === "NO_DATA" ? "확인되지 않음"
      : "특별한 변화 없음";

    lines.push(`${b.symbol} — ${b.name}   [${badge}]`);

    if (b.state === "NO_DATA" && b.gap) {
      lines.push(
        ...(b.gap.kind === "never"
          ? ["  ℹ 아직 수집한 적이 없습니다. `mystock collect`를 먼저 실행하세요."]
          : b.gap.kind === "cold_start"
          ? [
              `  ℹ ${fmt(b.gap.to)}부터 수집을 시작했습니다.`,
              "     그 이전 기간은 확인되지 않았습니다.",
            ]
          : [
              `  ⚠ ${fmt(b.gap.from)} ~ ${fmt(b.gap.to)} 사이 뉴스를 수집하지 못했습니다.`,
              "     이 기간의 사건은 누락되었을 수 있습니다.",
            ]),
      );
    } else if (b.state !== "HAS_EVENTS") {
      lines.push(`  ${STATE_TEXT[b.state]}`);
    }

    for (const [i, e] of b.events.entries()) {
      const mark = e.certainty === "speculative" ? " (전망)" : "";
      lines.push(`  ${circled(i + 1)} ${e.title}${mark}`);
      for (const line of wrap(e.summary, 68)) lines.push(`     ${line}`);
      if (e.followupCount > 0) lines.push(`     후속 보도 ${e.followupCount}건`);
      lines.push(`     관련 기사 ${e.articles.length}`);
      for (const a of e.articles) lines.push(`       · ${a.source} — ${a.url}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function circled(n: number): string {
  return "①②③④⑤⑥⑦⑧⑨".charAt(n - 1) || `${n}.`;
}

function fmt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width && line.length > 0) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}
