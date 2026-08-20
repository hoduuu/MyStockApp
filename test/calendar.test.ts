import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildUpcoming, renderCalendar, syncCalendar } from "../src/report/calendar.js";

const NOW = new Date("2026-08-19T18:00:00Z");

function db() {
  return openDb(":memory:");
}

function config(over: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...over };
}

test("never synced is distinguished from synced-but-empty", () => {
  const d = db();
  assert.match(renderCalendar(buildUpcoming(d, 7, NOW), NOW), /아직 동기화하지 않았습니다/);

  syncCalendar(d, config({ calendarEvents: [] }), { now: NOW });
  assert.match(renderCalendar(buildUpcoming(d, 7, NOW), NOW), /예정된 주요 일정이 없습니다/);
  d.close();
});

/**
 * Both macro releases and per-asset earnings are the same manual mechanism
 * now (docs/DESIGN.md §0.7c) — assetSymbol is what tells them apart, not a
 * separate code path.
 */
test("macro and per-asset entries sync from config with no network call", () => {
  const d = db();
  const cfg = config({
    calendarEvents: [
      { id: "fomc-sep", kind: "fomc", title: "FOMC 금리 결정", scheduledAt: "2026-08-20T22:00:00Z" },
      {
        id: "nvda-q2",
        assetSymbol: "NVDA",
        kind: "earnings",
        title: "NVDA 실적 발표",
        scheduledAt: "2026-08-22T19:00:00Z",
      },
    ],
  });

  const stats = syncCalendar(d, cfg, { now: NOW });
  assert.equal(stats.synced, 2);

  const up = buildUpcoming(d, 7, NOW);
  assert.equal(up.entries.length, 2);
  assert.equal(up.entries.find((e) => e.id === "fomc-sep")?.assetSymbol, null);
  assert.equal(up.entries.find((e) => e.id === "nvda-q2")?.assetSymbol, "NVDA");
  d.close();
});

test("events outside the window are excluded, and a same-day past event stays visible", () => {
  const d = db();
  syncCalendar(
    d,
    config({
      calendarEvents: [
        { id: "far", kind: "earnings", assetSymbol: "AAA", title: "먼 미래 실적", scheduledAt: "2026-12-01T09:00:00Z" },
        { id: "today-earlier", kind: "earnings", assetSymbol: "NVDA", title: "오늘 아침 실적", scheduledAt: "2026-08-19T08:00:00Z" },
      ],
    }),
    { now: NOW },
  );

  const up = buildUpcoming(d, 7, NOW);
  assert.deepEqual(up.entries.map((e) => e.id), ["today-earlier"]);
  assert.equal(up.entries[0]!.status, "occurred");
  d.close();
});

test("re-syncing the same id updates it rather than duplicating it", () => {
  const d = db();
  const base = { id: "cpi", kind: "cpi" as const, title: "CPI 발표", scheduledAt: "2026-08-25T12:30:00Z" };
  syncCalendar(d, config({ calendarEvents: [base] }), { now: NOW });
  syncCalendar(d, config({ calendarEvents: [{ ...base, title: "CPI 발표 (수정)" }] }), { now: NOW });

  const up = buildUpcoming(d, 30, NOW);
  assert.equal(up.entries.length, 1);
  assert.equal(up.entries[0]!.title, "CPI 발표 (수정)");
  d.close();
});

test("removing an entry from config does not remove it from the DB", () => {
  // Sync is additive/updating only — it has no way to know a missing id was
  // deleted on purpose versus just not reached yet, so it never deletes.
  const d = db();
  syncCalendar(d, config({ calendarEvents: [{ id: "a", kind: "cpi", title: "A", scheduledAt: "2026-08-25T00:00:00Z" }] }), { now: NOW });
  syncCalendar(d, config({ calendarEvents: [] }), { now: NOW });

  assert.equal(buildUpcoming(d, 30, NOW).entries.length, 1);
  d.close();
});

test("rendering shows D-day without fabricating anything not stored", () => {
  const d = db();
  syncCalendar(
    d,
    config({
      calendarEvents: [
        { id: "e1", assetSymbol: "NVDA", kind: "earnings", title: "NVDA 실적 발표", scheduledAt: "2026-08-22T19:00:00Z" },
      ],
    }),
    { now: NOW },
  );

  const text = renderCalendar(buildUpcoming(d, 7, NOW), NOW);
  assert.match(text, /D-3/);
  assert.match(text, /NVDA 실적 발표/);
  d.close();
});
