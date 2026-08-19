import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import { fetchEarnings, toCalendarEvent } from "../sources/calendar.js";
import type { CalendarEvent } from "../types.js";

export interface CalendarFetchStats {
  ok: number;
  failed: { symbol: string; reason: string }[];
}

/**
 * Pulls each asset's next earnings date and re-syncs the hand-maintained
 * macro list from config. One `job_runs` row records that this ran at all —
 * buildUpcoming uses it to tell "checked, nothing upcoming" apart from
 * "never checked", the same distinction §1 insists on for the news brief.
 */
export async function collectCalendar(
  db: DatabaseSync,
  config: Config,
  opts: { now?: Date; onLog?: (line: string) => void } = {},
): Promise<CalendarFetchStats> {
  const now = opts.now ?? new Date();
  const log = opts.onLog ?? (() => {});
  const stats: CalendarFetchStats = { ok: 0, failed: [] };

  for (const asset of config.assets) {
    try {
      const info = await fetchEarnings(asset.symbol);
      const event = toCalendarEvent(info, asset.name, now);
      if (event) {
        storeEvent(db, event, now);
        log(`  ✓ ${asset.symbol} — ${fmtDate(event.scheduledAt)}`);
      } else {
        log(`  · ${asset.symbol} — 예정된 실적 발표 없음`);
      }
      stats.ok++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stats.failed.push({ symbol: asset.symbol, reason });
      log(`  ✕ ${asset.symbol} — ${reason}`);
    }
  }

  for (const m of config.macroEvents) {
    storeEvent(
      db,
      {
        id: `cal_macro_${m.id}`,
        assetSymbol: null,
        kind: m.kind,
        title: m.title,
        scheduledAt: m.scheduledAt,
        consensus: null,
        status: Date.parse(m.scheduledAt) <= now.getTime() ? "occurred" : "scheduled",
      },
      now,
    );
  }

  db.prepare(
    "INSERT INTO job_runs (job, started_at, finished_at, ok) VALUES ('calendar', ?, ?, ?)",
  ).run(now.toISOString(), now.toISOString(), stats.failed.length < stats.ok + stats.failed.length ? 1 : 0);

  return stats;
}

function storeEvent(db: DatabaseSync, e: CalendarEvent, now: Date): void {
  db.prepare(
    `INSERT INTO calendar_events (id, asset_symbol, kind, title, scheduled_at, consensus_json, status, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       scheduled_at = excluded.scheduled_at,
       consensus_json = excluded.consensus_json,
       status = excluded.status,
       fetched_at = excluded.fetched_at`,
  ).run(
    e.id, e.assetSymbol, e.kind, e.title, e.scheduledAt,
    e.consensus ? JSON.stringify(e.consensus) : null, e.status, now.toISOString(),
  );
}

export interface Upcoming {
  /** Whether `collect calendar` has ever run. Distinguishes silence from absence. */
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
    return "\n예정 이벤트를 아직 수집하지 않았습니다. `mystock calendar` 를 먼저 실행하세요.\n";
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

function fmtDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
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
