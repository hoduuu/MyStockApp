import assert from "node:assert/strict";
import test from "node:test";
import type { AssetBrief } from "../src/report/brief.js";
import { renderBriefHtml } from "../src/report/html.js";

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
