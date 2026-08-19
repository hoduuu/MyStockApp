import assert from "node:assert/strict";
import test from "node:test";
import type { AssetBrief } from "../src/report/brief.js";
import { renderBriefHtml } from "../src/report/html.js";
import type { Timeline } from "../src/report/timeline.js";

const AT = new Date("2026-08-19T18:00:00Z");

function brief(over: Partial<AssetBrief> = {}): AssetBrief {
  return {
    symbol: "NVDA",
    name: "엔비디아",
    state: "NO_SIGNIFICANT",
    events: [],
    gap: null,
    ...over,
  };
}

function event(over: Partial<AssetBrief["events"][number]> = {}) {
  return {
    id: "evt_1",
    title: "중국향 H200 공급 관련 새로운 움직임",
    summary: "요약",
    importance: 78,
    certainty: "reported",
    firstSeenAt: "2026-08-19T09:00:00Z",
    followupCount: 0,
    provider: "anthropic",
    articles: [{ source: "Reuters", title: "기사", url: "https://example.com/a" }],
    ...over,
  };
}

function render(briefs: AssetBrief[]): string {
  return renderBriefHtml(briefs, { windowLabel: "7일", generatedAt: AT });
}

/**
 * Feed titles reach the page. An outlet that puts a quote or an angle bracket
 * in a headline must not be able to alter the document.
 */
test("titles and summaries are escaped", () => {
  const html = render([
    brief({
      state: "HAS_EVENTS",
      events: [
        event({
          title: `<img src=x onerror="alert(1)">`,
          summary: `"quoted" & <b>bold</b>`,
          articles: [{ source: "A&B", title: "<i>t</i>", url: "https://e.com/?a=1&b=2" }],
        }),
      ],
    }),
  ]);

  assert.ok(!html.includes("<img src=x"), "raw tag reached the document");
  assert.ok(!html.includes("<b>bold</b>"));
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&amp;/);
});

test("the opening line answers the whole page", () => {
  const quiet = render([brief(), brief({ symbol: "DELL", name: "델" })]);
  assert.match(quiet, /특별한 변화 없음/);

  const moved = render([
    brief({ state: "HAS_EVENTS", events: [event()] }),
    brief({ symbol: "DELL", name: "델" }),
  ]);
  assert.match(moved, /2개 자산 중 1개에 변화/);
});

/**
 * §12: a count or a colour would read as a price move. An asset with nothing
 * to report gets the quietest mark on the page, and three is the ceiling —
 * "many" is the useful fact, not the exact number.
 */
test("event counts render as dots, capped at three", () => {
  const html = render([
    brief({ state: "HAS_EVENTS", events: [event(), event(), event(), event(), event()] }),
  ]);
  assert.match(html, /<span class="dots">●●●<\/span>/);
  assert.ok(!html.includes("●●●●"));
});

test("an asset with no events gets the quiet mark", () => {
  const html = render([brief()]);
  assert.match(html, /<span class="dots">─<\/span>/);
  assert.match(html, /class="quiet"/);
});

test("the three no-data states read differently", () => {
  const never = render([brief({ state: "NO_DATA", gap: { from: "", to: "", kind: "never" } })]);
  const cold = render([
    brief({ state: "NO_DATA", gap: { from: "2026-08-12", to: "2026-08-19", kind: "cold_start" } }),
  ]);
  const outage = render([
    brief({ state: "NO_DATA", gap: { from: "2026-08-12", to: "2026-08-15", kind: "outage" } }),
  ]);

  assert.match(never, /아직 수집한 적이 없습니다/);
  assert.match(cold, /수집을 시작했습니다/);
  assert.match(outage, /수집하지 못했습니다/);

  // Only a real outage is a malfunction; the other two are not the app's fault
  // and must not borrow the alarming tone.
  assert.match(outage, /notice warn/);
  assert.ok(!never.includes("notice warn"));
  assert.ok(!cold.includes("notice warn"));
});

test("a gap shows next to events, not only instead of them", () => {
  const html = render([
    brief({
      state: "HAS_EVENTS",
      events: [event()],
      gap: { from: "2026-08-12", to: "2026-08-19", kind: "cold_start" },
    }),
  ]);
  assert.match(html, /수집을 시작했습니다/);
  assert.match(html, /중국향 H200/);
});

test("mock events are labelled and announced once at the top", () => {
  const html = render([
    brief({ state: "HAS_EVENTS", events: [event({ provider: "mock" })] }),
  ]);
  assert.match(html, /class="flag sample">샘플/);
  assert.match(html, /실제 AI 분석이 아닙니다/);

  const real = render([brief({ state: "HAS_EVENTS", events: [event()] })]);
  assert.ok(!real.includes("실제 AI 분석이 아닙니다"));
});

test("related articles stay behind a disclosure", () => {
  const html = render([brief({ state: "HAS_EVENTS", events: [event()] })]);
  assert.match(html, /<details>/);
  assert.match(html, /<summary>관련 기사 1<\/summary>/);
});

// --- the record (기록장) -----------------------------------------------------

function timeline(entries: Timeline["entries"] = []): Timeline {
  return { symbol: "NVDA", name: "엔비디아", days: 30, entries };
}

function entry(over: Partial<Timeline["entries"][number]> = {}): Timeline["entries"][number] {
  return {
    id: "evt_1",
    date: "2026-08-18T09:00:00Z",
    title: "중국 규제 조사",
    summary: "요약",
    importance: 70,
    category: "regulation",
    certainty: "reported",
    status: "open",
    followupCount: 0,
    provider: "anthropic",
    articles: [],
    ...over,
  };
}

function withRecord(entries: Timeline["entries"]): string {
  return renderBriefHtml([brief({ state: "HAS_EVENTS", events: [event()] })], {
    windowLabel: "7일",
    generatedAt: AT,
    timelines: [timeline(entries)],
  });
}

test("without timelines no record link is offered", () => {
  const html = render([brief({ state: "HAS_EVENTS", events: [event()] })]);
  assert.ok(!html.includes("기록장"));
});

test("the record is a separate view reached from the asset", () => {
  const html = withRecord([entry()]);
  assert.match(html, /href="#tl-NVDA"/);
  assert.match(html, /id="tl-NVDA"/);
  assert.match(html, /href="#home"/);
});

/**
 * The home screen must not carry the record's weight — that is the whole
 * reason it is a second view (§12.3-⑥).
 */
test("the home view stays hidden while a record is open", () => {
  const html = withRecord([entry()]);
  assert.match(html, /body:has\(\.view\.detail:target\) #home \{ display:none; \}/);
});

test("the record keeps what the brief filters out", () => {
  const html = withRecord([
    entry({ id: "a", importance: 8, title: "사소한 코멘트" }),
    entry({ id: "b", status: "closed", title: "종료된 사건", date: "2026-07-20T09:00:00Z" }),
  ]);
  assert.match(html, /사소한 코멘트/);
  assert.match(html, /종료된 사건/);
  assert.match(html, /중요도 8/);
  assert.match(html, />종료</);
});

test("record entries are grouped by month and totalled", () => {
  const html = withRecord([
    entry({ id: "a", date: "2026-08-18T09:00:00Z" }),
    entry({ id: "b", date: "2026-07-20T09:00:00Z" }),
  ]);
  assert.match(html, /2026년 08월/);
  assert.match(html, /2026년 07월/);
  assert.match(html, /총 2건/);
});

test("an empty record says so rather than rendering blank", () => {
  const html = withRecord([]);
  assert.match(html, /기록된 사건이 없습니다/);
  assert.ok(!html.includes("총 0건"));
});

test("record text is escaped too", () => {
  const html = withRecord([entry({ title: `<script>alert(1)</script>` })]);
  assert.ok(!html.includes("<script>alert(1)"));
  assert.match(html, /&lt;script&gt;/);
});
