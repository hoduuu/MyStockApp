import assert from "node:assert/strict";
import test from "node:test";
import { openDb, getSetting } from "../src/db.js";
import { LAST_VISIT_KEY, markVisit, resolveWindow } from "../src/report/window.js";

const NOW = new Date("2026-08-19T18:00:00Z");

function db() {
  return openDb(":memory:");
}

test("an explicit window is used as given", () => {
  const d = db();
  assert.deepEqual(resolveWindow(d, "7d", NOW), { days: 7, label: "7일", sinceLastVisit: false });
  assert.deepEqual(resolveWindow(d, "24h", NOW), { days: 1, label: "24시간", sinceLastVisit: false });
  assert.deepEqual(resolveWindow(d, "30d", NOW), { days: 30, label: "30일", sinceLastVisit: false });
  d.close();
});

test("a malformed window is rejected rather than guessed at", () => {
  const d = db();
  assert.throws(() => resolveWindow(d, "일주일", NOW), /형식/);
  d.close();
});

/**
 * The scenario the app exists for: away a week, opens it, wants the week.
 * docs/DESIGN.md §12.3-① — this is the default, not a mode to select.
 */
test("the default window spans the time since the last visit", () => {
  const d = db();
  markVisit(d, new Date("2026-08-11T18:00:00Z"));

  const win = resolveWindow(d, undefined, NOW);
  assert.equal(win.sinceLastVisit, true);
  assert.equal(Math.round(win.days), 8);
  assert.equal(win.label, "8일");
  d.close();
});

test("a first-ever visit falls back to a week and says so", () => {
  const d = db();
  const win = resolveWindow(d, undefined, NOW);
  assert.equal(win.sinceLastVisit, false);
  assert.equal(win.days, 7);
  d.close();
});

/**
 * Opening twice in a minute must not produce an empty screen — a window of
 * "0.02 days" answers nobody's question.
 */
test("reopening straight away still shows a day", () => {
  const d = db();
  markVisit(d, new Date("2026-08-19T17:58:00Z"));

  const win = resolveWindow(d, undefined, NOW);
  assert.equal(win.days, 1);
  assert.equal(win.label, "하루");
  d.close();
});

test("a stored timestamp that cannot be read falls back rather than throwing", () => {
  const d = db();
  d.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(LAST_VISIT_KEY, "쓰레기값");

  const win = resolveWindow(d, undefined, NOW);
  assert.equal(win.days, 7);
  assert.equal(win.sinceLastVisit, false);
  d.close();
});

test("marking a visit overwrites the previous one", () => {
  const d = db();
  markVisit(d, new Date("2026-08-11T18:00:00Z"));
  markVisit(d, NOW);
  assert.equal(getSetting(d, LAST_VISIT_KEY), NOW.toISOString());
  d.close();
});
