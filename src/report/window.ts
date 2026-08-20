import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../db.js";

export const LAST_VISIT_KEY = "last_visit_at";

export interface Window {
  days: number;
  label: string;
  /** True when the span came from the last visit rather than a fixed choice. */
  sinceLastVisit: boolean;
}

/**
 * "지난 8일 동안" rather than a fixed 24h/7d/30d tab (docs/DESIGN.md §12.3-①).
 *
 * The brainstorm's hardest scenario — away a week, opens the app, wants to know
 * what it missed — stops being a special case and becomes the default: the
 * window is however long it has been since the last look.
 */
export function resolveWindow(db: DatabaseSync, raw: string | undefined, now = new Date()): Window {
  if (raw === undefined || raw === "last") return sinceLastVisit(db, now);
  return { ...parseFixed(raw), sinceLastVisit: false };
}

function sinceLastVisit(db: DatabaseSync, now: Date): Window {
  const stored = getSetting(db, LAST_VISIT_KEY);
  const last = stored === null ? null : Date.parse(stored);

  // Never opened before: there is no "since" to measure from, so fall back to
  // a week. Any gap is reported separately, so this cannot silently overclaim.
  if (last === null || !Number.isFinite(last)) {
    return { days: 7, label: "7일", sinceLastVisit: false };
  }

  const days = (now.getTime() - last) / 86_400_000;

  // Opening twice in a minute should not produce an empty screen. Below a day,
  // show the day — a window of "0.02 days" answers nobody's question.
  if (days < 1) return { days: 1, label: "하루", sinceLastVisit: true };

  return { days, label: `${Math.round(days)}일`, sinceLastVisit: true };
}

/**
 * Recorded only when the user actually looked at a brief, and never by
 * `collect` — a scheduled run at 3am is the collector working, not a visit.
 * Marking it there would make the next real visit show an empty screen and
 * quietly swallow everything that had accumulated.
 */
export function markVisit(db: DatabaseSync, now = new Date()): void {
  setSetting(db, LAST_VISIT_KEY, now.toISOString());
}

/**
 * Marks an asset "seen up to now" — clears its 관심자산 badge, since the
 * badge means "an event first appeared after the last time you looked at
 * this asset". Called when the asset's own detail page is opened, not on
 * every visit to the home screen: skimming the home list shouldn't clear
 * anything, only actually looking at the asset should.
 */
export function markAssetSeen(db: DatabaseSync, symbol: string, now = new Date()): void {
  db.prepare(
    "INSERT INTO asset_seen (symbol, seen_at) VALUES (?, ?) ON CONFLICT(symbol) DO UPDATE SET seen_at = excluded.seen_at",
  ).run(symbol, now.toISOString());
}

export function getAssetSeen(db: DatabaseSync, symbol: string): string | null {
  const row = db.prepare("SELECT seen_at FROM asset_seen WHERE symbol = ?").get(symbol) as
    | { seen_at: string }
    | undefined;
  return row?.seen_at ?? null;
}

function parseFixed(raw: string): { days: number; label: string } {
  const m = /^(\d+)([hd])$/.exec(raw.trim());
  if (!m) throw new Error(`--window 형식이 잘못되었습니다: ${raw} (예: 24h, 7d, 30d, last)`);
  const n = Number(m[1]);
  return m[2] === "h" ? { days: n / 24, label: `${n}시간` } : { days: n, label: `${n}일` };
}
