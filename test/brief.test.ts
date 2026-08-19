import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildBrief, renderBrief } from "../src/report/brief.js";

/**
 * docs/DESIGN.md §1 and §14 #3: "nothing happened" and "we failed to look"
 * are different facts and must never render alike. These tests exist to make
 * that regression loud.
 */
const NOW = new Date("2026-08-19T18:00:00Z");
const CONFIG: Config = { ...DEFAULT_CONFIG, assets: [{ symbol: "NVDA", name: "엔비디아", aliases: [] }] };

function db() {
  return openDb(":memory:");
}

function addRun(d: ReturnType<typeof db>, startedAt: string, ok = 1) {
  d.prepare("INSERT INTO job_runs (job, asset_symbol, started_at, finished_at, ok) VALUES ('collect','NVDA',?,?,?)")
    .run(startedAt, startedAt, ok);
}

function addEvent(
  d: ReturnType<typeof db>,
  id: string,
  importance: number,
  firstSeenAt: string,
  followups = 0,
) {
  d.prepare(
    `INSERT INTO events (id, asset_symbol, title, summary, importance, category, certainty,
       status, first_seen_at, last_updated_at, followup_count, importance_reason)
     VALUES (?, 'NVDA', ?, '요약', ?, 'other', 'reported', 'open', ?, ?, ?, '')`,
  ).run(id, `사건 ${id}`, importance, firstSeenAt, firstSeenAt, followups);
}

/** Runs every 12h across the window, so no gap is ever detected. */
function fillRuns(d: ReturnType<typeof db>, days: number) {
  for (let h = days * 24; h >= 0; h -= 12) {
    addRun(d, new Date(NOW.getTime() - h * 3_600_000).toISOString());
  }
}

test("events present → HAS_EVENTS", () => {
  const d = db();
  fillRuns(d, 7);
  addEvent(d, "evt_1", 80, "2026-08-18T09:00:00Z");
  assert.equal(buildBrief(d, CONFIG, 7, 40, NOW)[0]!.state, "HAS_EVENTS");
  d.close();
});

test("collector ran throughout but found nothing → NO_SIGNIFICANT", () => {
  const d = db();
  fillRuns(d, 7);
  assert.equal(buildBrief(d, CONFIG, 7, 40, NOW)[0]!.state, "NO_SIGNIFICANT");
  d.close();
});

test("only follow-ups arrived → ONLY_FOLLOWUPS", () => {
  const d = db();
  fillRuns(d, 7);
  addEvent(d, "evt_old", 80, "2026-08-01T09:00:00Z", 3); // outside window, but touched inside it
  d.prepare("UPDATE events SET last_updated_at = ? WHERE id = 'evt_old'").run("2026-08-18T09:00:00Z");
  assert.equal(buildBrief(d, CONFIG, 7, 40, NOW)[0]!.state, "ONLY_FOLLOWUPS");
  d.close();
});

test("collector never ran → NO_DATA, not NO_SIGNIFICANT", () => {
  const d = db();
  const brief = buildBrief(d, CONFIG, 7, 40, NOW)[0]!;
  assert.equal(brief.state, "NO_DATA");
  assert.equal(brief.gap?.kind, "never");

  const text = renderBrief([brief], "7일");
  assert.match(text, /아직 수집한 적이 없습니다/);
  assert.ok(!text.includes("수집을 시작했습니다"), "nothing has started yet");
  d.close();
});

test("a multi-day outage inside the window → NO_DATA marked as an outage", () => {
  const d = db();
  addRun(d, "2026-08-12T20:00:00Z"); // just after the window opens
  addRun(d, "2026-08-13T09:00:00Z");
  addRun(d, "2026-08-19T09:00:00Z"); // 6-day hole
  const brief = buildBrief(d, CONFIG, 7, 40, NOW)[0]!;
  assert.equal(brief.state, "NO_DATA");
  assert.equal(brief.gap?.kind, "outage");
  d.close();
});

/**
 * A first run must not accuse the collector of failing. Nothing broke — the
 * app was not watching yet, and saying otherwise would undermine the one
 * signal this app cannot afford to get wrong.
 */
test("a window reaching back before the first ever run is a cold start, not an outage", () => {
  const d = db();
  addRun(d, "2026-08-19T17:00:00Z"); // the very first run, an hour ago
  const brief = buildBrief(d, CONFIG, 7, 40, NOW)[0]!;
  assert.equal(brief.state, "NO_DATA");
  assert.equal(brief.gap?.kind, "cold_start");

  const text = renderBrief([brief], "7일");
  assert.match(text, /수집을 시작했습니다/);
  assert.ok(!text.includes("수집하지 못했습니다"), "must not read as a failure");
  d.close();
});

test("cold start ends once collection covers the whole window", () => {
  const d = db();
  fillRuns(d, 7);
  assert.equal(buildBrief(d, CONFIG, 7, 40, NOW)[0]!.gap, null);
  d.close();
});

test("a laptop off overnight is not reported as a gap", () => {
  const d = db();
  fillRuns(d, 7);
  assert.equal(buildBrief(d, CONFIG, 7, 40, NOW)[0]!.gap, null);
  d.close();
});

test("failed runs do not count as coverage", () => {
  const d = db();
  for (let h = 7 * 24; h >= 0; h -= 12) {
    addRun(d, new Date(NOW.getTime() - h * 3_600_000).toISOString(), 0);
  }
  assert.equal(buildBrief(d, CONFIG, 7, 40, NOW)[0]!.state, "NO_DATA");
  d.close();
});

test("events below the importance floor are not surfaced", () => {
  const d = db();
  fillRuns(d, 7);
  addEvent(d, "evt_minor", 20, "2026-08-18T09:00:00Z");
  assert.equal(buildBrief(d, CONFIG, 7, 40, NOW)[0]!.events.length, 0);
  d.close();
});

test("the rendered gap warning is visibly different from 'nothing happened'", () => {
  const quiet = db();
  fillRuns(quiet, 7);
  const quietText = renderBrief(buildBrief(quiet, CONFIG, 7, 40, NOW), "7일");
  quiet.close();

  const broken = db();
  addRun(broken, "2026-08-13T09:00:00Z");
  addRun(broken, "2026-08-19T09:00:00Z");
  const brokenText = renderBrief(buildBrief(broken, CONFIG, 7, 40, NOW), "7일");
  broken.close();

  assert.match(quietText, /특별히 새로운 중요한 사건은 없습니다/);
  assert.match(brokenText, /수집하지 못했습니다/);
  assert.ok(!brokenText.includes("특별히 새로운 중요한 사건은 없습니다"));
});

/**
 * Observed on 2026-08-19: four assets were collected in the same first run,
 * and the two with no events disclosed the cold start while the two with
 * events said nothing about it. The limitation was identical for all four.
 *
 * Reporting three events found in six hours as though they covered the week
 * is the same class of error as calling an outage a quiet week — a short
 * list looks like a complete one.
 */
test("a gap is disclosed even when events were found in the observed part", () => {
  const d = db();
  addRun(d, "2026-08-19T15:36:00Z"); // collection began today; window opens 7d back
  addEvent(d, "evt_1", 80, "2026-08-19T16:00:00Z");

  const brief = buildBrief(d, CONFIG, 7, 40, NOW)[0]!;
  const text = renderBrief([brief], "7일");
  d.close();

  assert.equal(brief.state, "HAS_EVENTS");
  assert.equal(brief.gap?.kind, "cold_start");
  assert.match(text, /중요 사건 1건/);
  assert.match(text, /수집을 시작했습니다/);
});
