import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildUpcoming, renderCalendar } from "../src/report/calendar.js";
import { parseEarnings, toCalendarEvent } from "../src/sources/calendar.js";

const NOW = new Date("2026-08-19T18:00:00Z");
const fixture = (n: string) => fs.readFileSync(`fixtures/yahoo-earnings-${n}.json`, "utf8");

// --- parsing -----------------------------------------------------------------

test("the earliest upcoming earnings date is read, not the last one", () => {
  const info = parseEarnings("NVDA", fixture("nvda"));
  assert.equal(info.scheduledAt, new Date(1787331600 * 1000).toISOString());
});

test("consensus figures come through as a plain record", () => {
  const info = parseEarnings("NVDA", fixture("nvda"));
  assert.equal(info.consensus?.epsAverage, 1.42);
  assert.equal(info.consensus?.revenueAverage, 65_100_000_000);
});

test("no scheduled date is a valid answer, not an error", () => {
  const info = parseEarnings("XYZ", fixture("none"));
  assert.equal(info.scheduledAt, null);
  assert.equal(info.consensus, null);
});

/**
 * Same failure shape as the chart endpoint (market.test.ts): Yahoo answers a
 * bad symbol with HTTP 200 and an error object rather than a 4xx.
 */
test("an error payload raises rather than returning nothing", () => {
  assert.throws(() => parseEarnings("XYZ", fixture("error")), /calendarEvents/);
});

test("toCalendarEvent returns null when there is nothing scheduled", () => {
  const info = parseEarnings("XYZ", fixture("none"));
  assert.equal(toCalendarEvent(info, "엑시와이지", NOW), null);
});

test("a future date is scheduled; a past one is occurred", () => {
  const info = parseEarnings("NVDA", fixture("nvda"));
  const future = toCalendarEvent(info, "엔비디아", NOW)!;
  assert.equal(future.status, "scheduled");

  const past = toCalendarEvent(info, "엔비디아", new Date("2027-01-01T00:00:00Z"))!;
  assert.equal(past.status, "occurred");
});

// --- storage and reporting ---------------------------------------------------

function config(over: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...over };
}

test("never collected is distinguished from collected-but-empty", () => {
  const db = openDb(":memory:");
  const neverText = renderCalendar(buildUpcoming(db, 7, NOW), NOW);
  assert.match(neverText, /아직 수집하지 않았습니다/);

  db.prepare("INSERT INTO job_runs (job, started_at, finished_at, ok) VALUES ('calendar', ?, ?, 1)")
    .run(NOW.toISOString(), NOW.toISOString());
  const emptyText = renderCalendar(buildUpcoming(db, 7, NOW), NOW);
  assert.match(emptyText, /예정된 주요 일정이 없습니다/);
  db.close();
});

test("macro events from config are synced without any network call", async () => {
  const db = openDb(":memory:");
  const cfg = config({
    assets: [],
    macroEvents: [
      { id: "fomc-sep", kind: "fomc", title: "FOMC 금리 결정", scheduledAt: "2026-08-20T22:00:00Z" },
    ],
  });

  const { collectCalendar } = await import("../src/report/calendar.js");
  await collectCalendar(db, cfg, { now: NOW });

  const up = buildUpcoming(db, 7, NOW);
  assert.equal(up.entries.length, 1);
  assert.equal(up.entries[0]!.title, "FOMC 금리 결정");
  assert.equal(up.entries[0]!.assetSymbol, null);
  db.close();
});

test("events outside the window are excluded, and a same-day past event stays visible", () => {
  const db = openDb(":memory:");
  const insert = db.prepare(
    `INSERT INTO calendar_events (id, asset_symbol, kind, title, scheduled_at, status, fetched_at)
     VALUES (?, ?, 'earnings', ?, ?, ?, ?)`,
  );
  insert.run("far", "AAA", "먼 미래 실적", "2026-12-01T09:00:00Z", "scheduled", NOW.toISOString());
  insert.run("today-earlier", "NVDA", "오늘 아침 실적", "2026-08-19T08:00:00Z", "occurred", NOW.toISOString());
  db.prepare("INSERT INTO job_runs (job, started_at, finished_at, ok) VALUES ('calendar', ?, ?, 1)")
    .run(NOW.toISOString(), NOW.toISOString());

  const up = buildUpcoming(db, 7, NOW);
  assert.deepEqual(up.entries.map((e) => e.id), ["today-earlier"]);
  db.close();
});

test("re-collecting the same event updates it rather than duplicating it", async () => {
  const db = openDb(":memory:");
  const cfg = config({
    assets: [],
    macroEvents: [{ id: "cpi", kind: "cpi", title: "CPI 발표", scheduledAt: "2026-08-25T12:30:00Z" }],
  });
  const { collectCalendar } = await import("../src/report/calendar.js");
  await collectCalendar(db, cfg, { now: NOW });
  await collectCalendar(db, { ...cfg, macroEvents: [{ ...cfg.macroEvents[0]!, title: "CPI 발표 (수정)" }] }, { now: NOW });

  const up = buildUpcoming(db, 30, NOW);
  assert.equal(up.entries.length, 1);
  assert.equal(up.entries[0]!.title, "CPI 발표 (수정)");
  db.close();
});

test("rendering shows D-day and does not fabricate a consensus figure it lacks", () => {
  const db = openDb(":memory:");
  db.prepare(
    `INSERT INTO calendar_events (id, asset_symbol, kind, title, scheduled_at, consensus_json, status, fetched_at)
     VALUES ('e1', 'NVDA', 'earnings', 'NVDA 실적 발표', '2026-08-22T19:00:00Z', ?, 'scheduled', ?)`,
  ).run(JSON.stringify({ epsAverage: 1.42 }), NOW.toISOString());
  db.prepare("INSERT INTO job_runs (job, started_at, finished_at, ok) VALUES ('calendar', ?, ?, 1)")
    .run(NOW.toISOString(), NOW.toISOString());

  const text = renderCalendar(buildUpcoming(db, 7, NOW), NOW);
  assert.match(text, /D-3/);
  assert.match(text, /EPS 1\.42/);
  db.close();
});
