import assert from "node:assert/strict";
import test from "node:test";
import { openDb } from "../src/db.js";
import { buildTimeline, renderTimeline } from "../src/report/timeline.js";

const NOW = new Date("2026-08-19T18:00:00Z");
const NVDA = { symbol: "NVDA", name: "엔비디아" };

function db() {
  return openDb(":memory:");
}

function addEvent(
  d: ReturnType<typeof db>,
  over: {
    id: string;
    importance?: number;
    firstSeenAt: string;
    status?: string;
    title?: string;
    followups?: number;
  },
) {
  d.prepare(
    `INSERT INTO events (id, asset_symbol, title, summary, importance, category, certainty,
       status, first_seen_at, last_updated_at, followup_count, importance_reason, provider)
     VALUES (?, 'NVDA', ?, '요약', ?, 'other', 'reported', ?, ?, ?, ?, '', 'mock')`,
  ).run(
    over.id,
    over.title ?? `사건 ${over.id}`,
    over.importance ?? 70,
    over.status ?? "open",
    over.firstSeenAt,
    over.firstSeenAt,
    over.followups ?? 0,
  );
}

/**
 * The record answers "what happened", the brief answers "what deserved your
 * attention". Something filtered out of the brief as minor is exactly what
 * gets looked up later, once a story turns out to matter.
 */
test("events below the brief's importance floor still appear", () => {
  const d = db();
  addEvent(d, { id: "evt_minor", importance: 12, firstSeenAt: "2026-08-18T09:00:00Z" });

  const t = buildTimeline(d, NVDA, 30, NOW);
  assert.equal(t.entries.length, 1);
  assert.equal(t.entries[0]!.importance, 12);
  d.close();
});

test("closed events still appear", () => {
  const d = db();
  addEvent(d, { id: "evt_done", status: "closed", firstSeenAt: "2026-07-30T09:00:00Z" });

  const t = buildTimeline(d, NVDA, 30, NOW);
  assert.equal(t.entries.length, 1);
  assert.equal(t.entries[0]!.status, "closed");
  assert.match(renderTimeline(t), /종료/);
  d.close();
});

test("entries run newest first", () => {
  const d = db();
  addEvent(d, { id: "evt_old", firstSeenAt: "2026-08-02T09:00:00Z" });
  addEvent(d, { id: "evt_new", firstSeenAt: "2026-08-18T09:00:00Z" });
  addEvent(d, { id: "evt_mid", firstSeenAt: "2026-08-10T09:00:00Z" });

  const t = buildTimeline(d, NVDA, 30, NOW);
  assert.deepEqual(t.entries.map((e) => e.id), ["evt_new", "evt_mid", "evt_old"]);
  d.close();
});

test("events outside the window are excluded", () => {
  const d = db();
  addEvent(d, { id: "evt_ancient", firstSeenAt: "2026-05-01T09:00:00Z" });
  assert.equal(buildTimeline(d, NVDA, 30, NOW).entries.length, 0);
  d.close();
});

test("an empty record says so instead of rendering nothing", () => {
  const d = db();
  assert.match(renderTimeline(buildTimeline(d, NVDA, 30, NOW)), /기록된 사건이 없습니다/);
  d.close();
});

test("the rendering groups by month and counts the total", () => {
  const d = db();
  addEvent(d, { id: "evt_a", firstSeenAt: "2026-08-18T09:00:00Z", title: "중국 규제 조사" });
  addEvent(d, { id: "evt_b", firstSeenAt: "2026-07-28T09:00:00Z", title: "오라클 계약" });

  const out = renderTimeline(buildTimeline(d, NVDA, 60, NOW));
  assert.match(out, /2026년 08월/);
  assert.match(out, /2026년 07월/);
  assert.match(out, /중국 규제 조사/);
  assert.match(out, /총 2건/);
  d.close();
});

test("follow-up counts are carried through", () => {
  const d = db();
  addEvent(d, { id: "evt_f", firstSeenAt: "2026-08-18T09:00:00Z", followups: 3 });
  assert.match(renderTimeline(buildTimeline(d, NVDA, 30, NOW)), /후속 3건/);
  d.close();
});
