import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import type { CalendarEvent } from "../types.js";

/**
 * Every calendar entry — earnings included — is hand-maintained in
 * `config.calendarEvents`. There was an earlier version of this that fetched
 * earnings dates from Yahoo's quoteSummary endpoint, but that endpoint
 * (unlike the chart endpoint market.ts uses) requires a crumb/cookie auth
 * flow Yahoo's public chart data does not, and returned a flat 401 in local
 * testing (docs/DESIGN.md §0.7b). Chasing that auth flow would trade a
 * working feature for a fragile one.
 *
 * Per-asset earnings happen four times a year — even less often than the
 * FOMC's eight — so the same argument that put macro releases in config
 * applies at least as strongly here. This isn't a downgrade from what was
 * planned; it's the same principle applied consistently.
 */
export interface CalendarSyncStats {
  synced: number;
}

/**
 * Re-syncs `config.calendarEvents` into the DB and records that this ran, via
 * a `job_runs` row with job='calendar' — buildUpcoming uses it to tell
 * "checked, nothing upcoming" apart from "never checked", the same
 * distinction §1 insists on for the news brief.
 */
export function syncCalendar(
  db: DatabaseSync,
  config: Config,
  opts: { now?: Date } = {},
): CalendarSyncStats {
  const now = opts.now ?? new Date();

  for (const e of config.calendarEvents) {
    storeEvent(
      db,
      {
        id: e.id,
        assetSymbol: e.assetSymbol ?? null,
        kind: e.kind,
        title: e.title,
        scheduledAt: e.scheduledAt,
        consensus: e.consensus ?? null,
        status: Date.parse(e.scheduledAt) <= now.getTime() ? "occurred" : "scheduled",
      },
      now,
    );
  }

  db.prepare(
    "INSERT INTO job_runs (job, started_at, finished_at, ok) VALUES ('calendar', ?, ?, 1)",
  ).run(now.toISOString(), now.toISOString());

  return { synced: config.calendarEvents.length };
}

function storeEvent(db: DatabaseSync, e: CalendarEvent, now: Date): void {
  db.prepare(
    `INSERT INTO calendar_events (id, asset_symbol, kind, title, scheduled_at, consensus_json, status, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       asset_symbol = excluded.asset_symbol,
       kind = excluded.kind,
       title = excluded.title,
       scheduled_at = excluded.scheduled_at,
       status = excluded.status,
       fetched_at = excluded.fetched_at`,
  ).run(
    e.id, e.assetSymbol, e.kind, e.title, e.scheduledAt,
    e.consensus ? JSON.stringify(e.consensus) : null, e.status, now.toISOString(),
  );
}

export interface Upcoming {
  /** Whether `calendar` has ever synced. Distinguishes silence from absence. */
  everCollected: boolean;
  entries: CalendarEvent[];
}

/**
 * Events within [now, now+days] plus anything that occurred within the last
 * day — a same-day earnings release should stay visible for a few hours after
 * it happens, not vanish the instant the clock ticks past it.
 */
export function buildUpcoming(db: DatabaseSync, days = 7, now = new Date()): Upcoming {
  const everCollected = !!db
    .prepare("SELECT 1 FROM job_runs WHERE job = 'calendar' LIMIT 1")
    .get();

  const from = new Date(now.getTime() - 86_400_000).toISOString();
  const to = new Date(now.getTime() + days * 86_400_000).toISOString();

  const rows = db
    .prepare(
      `SELECT id, asset_symbol, kind, title, scheduled_at, consensus_json, status
       FROM calendar_events
       WHERE scheduled_at >= ? AND scheduled_at <= ?
       ORDER BY scheduled_at ASC`,
    )
    .all(from, to) as {
    id: string; asset_symbol: string | null; kind: string; title: string;
    scheduled_at: string; consensus_json: string | null; status: string;
  }[];

  return {
    everCollected,
    entries: rows.map((r) => ({
      id: r.id,
      assetSymbol: r.asset_symbol,
      kind: r.kind as CalendarEvent["kind"],
      title: r.title,
      scheduledAt: r.scheduled_at,
      consensus: r.consensus_json ? JSON.parse(r.consensus_json) : null,
      status: r.status as CalendarEvent["status"],
    })),
  };
}

export function renderCalendar(up: Upcoming, now = new Date()): string {
  if (!up.everCollected) {
    return "\n예정 이벤트를 아직 동기화하지 않았습니다. `mystock calendar` 를 먼저 실행하세요.\n";
  }
  if (up.entries.length === 0) {
    return "\n앞으로 예정된 주요 일정이 없습니다.\n";
  }

  const lines: string[] = ["", "━━ 예정 이벤트 ━━", ""];
  for (const e of up.entries) {
    lines.push(`  ${dday(e.scheduledAt, now)}  ${e.title}${e.status === "occurred" ? " (발표 완료)" : ""}`);
    if (e.consensus?.epsAverage !== undefined) {
      lines.push(`        시장 예상 EPS ${e.consensus.epsAverage}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** D-0 for something happening today; days-of-week labels get confusing past a week. */
function dday(iso: string, now: Date): string {
  const days = Math.floor((Date.parse(iso) - startOfDay(now)) / 86_400_000);
  if (days === 0) {
    const hh = iso.slice(11, 16);
    return `오늘 ${hh}`.padEnd(10);
  }
  if (days < 0) return "발표됨".padEnd(10);
  return `D-${days}`.padEnd(10);
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
