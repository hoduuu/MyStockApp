import assert from "node:assert/strict";
import test from "node:test";
import type { AssetBrief } from "../src/report/brief.js";
import { renderBriefHtml } from "../src/report/html.js";
import type { Upcoming } from "../src/report/calendar.js";
import type { AssetQuote, MarketRow } from "../src/report/market.js";
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
  assert.match(html, /<span class="dt">●●●<\/span>/);
  assert.ok(!html.includes("●●●●"));
});

test("an asset with no events gets the quiet mark", () => {
  const html = render([brief()]);
  assert.match(html, /<span class="dt">─<\/span>/);
  assert.match(html, /class="arow quiet"/);
});

/**
 * The collapsed row has to say enough to make expanding it a choice rather
 * than a guess, without becoming the wall of text that expanding is for.
 */
test("a collapsed row summarises itself in one line", () => {
  const moved = render([
    brief({
      state: "HAS_EVENTS",
      events: [event({ title: "중국 규제 조사" }), event({ id: "e2", title: "오라클 계약" })],
    }),
  ]);
  assert.match(moved, /중국 규제 조사, 오라클 계약/);

  assert.match(render([brief()]), /변화 없음/);
  assert.match(
    render([brief({ state: "NO_DATA", gap: { from: "", to: "", kind: "never" } })]),
    /아직 수집 전/,
  );
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
  assert.match(html, /<span class="flag">샘플<\/span>/);
  assert.match(html, /실제 AI 분석이 아닙니다/);

  const real = render([brief({ state: "HAS_EVENTS", events: [event()] })]);
  assert.ok(!real.includes("실제 AI 분석이 아닙니다"));
});

/**
 * §7: the original article must not become the main event. The home row is a
 * plain link with no sources at all now; reaching one takes navigating to the
 * asset's own page and opening the event there, and even there it's the
 * outlet name — enough to judge the source, not enough to start reading here.
 */
test("the home row carries no sources; the asset page holds them behind a click", () => {
  const html = render([
    brief({
      state: "HAS_EVENTS",
      events: [
        event({
          articles: [{ source: "Reuters", title: "긴 기사 제목입니다", url: "https://e.com/a" }],
        }),
      ],
    }),
  ]);

  assert.match(html, /<a class="arow" href="#asset-NVDA">/);
  assert.match(html, /<details class="ev">/);
  assert.match(html, /href="https:\/\/e\.com\/a"[^>]*>Reuters</);
  assert.ok(!html.includes("긴 기사 제목입니다"), "headline should not be repeated here");
});

// --- asset detail page ---------------------------------------------------------

function quote(over: Partial<AssetQuote> = {}): AssetQuote {
  return {
    price: 187.32,
    change: 3.14,
    changePct: 1.71,
    currency: "USD",
    ts: "2026-08-19T20:00:00Z",
    stale: false,
    ...over,
  };
}

test("the asset page shows its own price when a quote exists, nothing when it doesn't", () => {
  const withQuote = renderBriefHtml([brief()], {
    windowLabel: "7일",
    generatedAt: AT,
    assetQuotes: new Map([["NVDA", quote()]]),
  });
  assert.match(withQuote, /class="stat-price up"/);
  assert.match(withQuote, /187\.32/);

  // "stat-price" always appears once in the static <style> block — what must
  // be absent is an actual rendered element with that class.
  const without = renderBriefHtml([brief()], { windowLabel: "7일", generatedAt: AT });
  assert.ok(!without.includes('<p class="stat-price'));
});

test("only the top 3 events show on the asset page, with a link for the rest", () => {
  const events = Array.from({ length: 5 }, (_, i) => event({ id: `e${i}`, title: `사건 ${i + 1}` }));
  const html = renderBriefHtml([brief({ state: "HAS_EVENTS", events })], {
    windowLabel: "7일",
    generatedAt: AT,
    timelines: [timeline([])],
  });
  const count = (html.match(/<details class="ev">/g) ?? []).length;
  assert.equal(count, 3);
  assert.match(html, /이 외 2건은 사건 기록장에서/);
});

test("no events and no gap reads as a clean quiet state on the asset page", () => {
  const html = render([brief()]);
  assert.match(html, /특별한 변화가 없었습니다/);
});

test("a gap on the asset page explains itself instead of also saying 'quiet'", () => {
  const html = render([
    brief({ state: "NO_DATA", gap: { from: "2026-08-12", to: "2026-08-19", kind: "cold_start" } }),
  ]);
  assert.match(html, /수집을 시작했습니다/);
  assert.ok(!html.includes("특별한 변화가 없었습니다"));
});

test("upcoming entries only appear on the asset they belong to", () => {
  const html = renderBriefHtml(
    [brief({ symbol: "NVDA" }), brief({ symbol: "DELL", name: "델" })],
    {
      windowLabel: "7일",
      generatedAt: AT,
      upcoming: {
        everCollected: true,
        entries: [calEntry({ assetSymbol: "DELL", title: "DELL 실적 발표" })],
      },
    },
  );
  const dellSection = html.slice(html.indexOf('id="asset-DELL"'));
  const nvdaSection = html.slice(html.indexOf('id="asset-NVDA"'), html.indexOf('id="asset-DELL"'));
  assert.match(dellSection, /DELL 실적 발표/);
  assert.ok(!nvdaSection.includes("DELL 실적 발표"));
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
  assert.match(html, /body:has\(\.view\.detail:target\)\s*#home\s*\{\s*display:none;/);
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

// --- market ------------------------------------------------------------------

function row(over: Partial<MarketRow> = {}): MarketRow {
  return {
    instrument: { id: "dow", name: "다우", symbol: "^DJI", slot: "index", icon: "us", enabled: true },
    price: 53343.4,
    change: 116.38,
    changePct: 0.2186,
    currency: "USD",
    ts: "2026-08-19T17:00:00Z",
    stale: false,
    ...over,
  };
}

function withMarket(market: MarketRow[]): string {
  return renderBriefHtml([brief()], { windowLabel: "7일", generatedAt: AT, market });
}

test("no market data means no market block at all", () => {
  assert.ok(!render([brief()]).includes("시장"));
});

test("a rising figure is marked up as rising", () => {
  const html = withMarket([row()]);
  assert.match(html, /class="tile up"/);
  assert.match(html, /▲/);
  assert.match(html, /0\.22%/);
});

test("a falling figure is marked separately from a flat one", () => {
  assert.match(withMarket([row({ change: -46.73, changePct: -0.61 })]), /class="tile down"/);
  assert.match(withMarket([row({ change: 0, changePct: 0 })]), /class="tile flat"/);
});

/**
 * Rendering 0.00% with no previous close would be a claim that the market did
 * not move. It says the comparison is missing instead.
 */
test("a missing previous close says so rather than showing zero", () => {
  const html = withMarket([row({ change: null, changePct: null })]);
  assert.match(html, /전일 대비 없음/);
  assert.ok(!html.includes("0.00%"));
});

test("flags are drawn, since Windows has no flag emoji", () => {
  const html = withMarket([row()]);
  assert.match(html, /<use href="#f-us"\/>/);
  assert.match(html, /<symbol id="f-us"/);
});

test("a non-country instrument gets a badge instead of a flag", () => {
  const html = withMarket([
    row({ instrument: { id: "btc", name: "비트코인", symbol: "BTC-USD", slot: "pair", icon: "btc", enabled: true } }),
  ]);
  assert.match(html, /<span class="chip btc">₿<\/span>/);
});

test("indices and pairs render in their own shapes", () => {
  const html = withMarket([
    row(),
    row({ instrument: { id: "usdkrw", name: "원/달러", symbol: "KRW=X", slot: "pair", icon: "us", enabled: true } }),
  ]);
  assert.match(html, /<div class="grid">/);
  assert.match(html, /<div class="pair">/);
});

/**
 * Dots that cannot go anywhere are decoration pretending to be a control.
 */
test("page dots appear only once there is a second page", () => {
  const six = Array.from({ length: 6 }, (_, i) => row({ instrument: { ...row().instrument, id: `i${i}` } }));
  assert.ok(!withMarket(six).includes('id="mktDots"'));

  const seven = [...six, row({ instrument: { ...row().instrument, id: "i6" } })];
  assert.match(withMarket(seven), /id="mktDots"/);
});

test("a stale figure is flagged with its date", () => {
  const html = withMarket([row({ stale: true, ts: "2026-08-15T09:00:00Z" })]);
  assert.match(html, /class="stale" title="8\/15 기준"/);
});

// --- 오늘의 브리핑 (real events + upcoming calendar, one shared deck) -----------

function calEntry(over: Partial<Upcoming["entries"][number]> = {}): Upcoming["entries"][number] {
  return {
    id: "cal_1",
    assetSymbol: "NVDA",
    kind: "earnings",
    title: "NVDA 실적 발표",
    scheduledAt: "2026-08-22T19:00:00Z",
    consensus: null,
    status: "scheduled",
    ...over,
  };
}

function withUpcoming(up: Upcoming): string {
  return renderBriefHtml([brief()], { windowLabel: "7일", generatedAt: AT, upcoming: up });
}

test("a real event becomes a briefing card, linked to its asset's record", () => {
  const html = renderBriefHtml(
    [brief({ state: "HAS_EVENTS", events: [event({ title: "중국 규제 조사" })] })],
    { windowLabel: "7일", generatedAt: AT, timelines: [timeline([entry()])] },
  );
  assert.match(html, /id="brief"/);
  assert.match(html, /class="notice-slide event" href="#tl-NVDA"/);
  assert.match(html, /NVDA · 엔비디아/);
  assert.match(html, /중국 규제 조사/);
});

test("without a record for that asset, the card links to the article instead", () => {
  const html = renderBriefHtml(
    [brief({ state: "HAS_EVENTS", events: [event()] })],
    { windowLabel: "7일", generatedAt: AT },
  );
  assert.match(html, /class="notice-slide event" href="https:\/\/example\.com\/a" target="_blank"/);
});

test("events and upcoming calendar entries share one deck, events first", () => {
  const html = renderBriefHtml(
    [brief({ state: "HAS_EVENTS", events: [event({ title: "중국 규제 조사" })] })],
    { windowLabel: "7일", generatedAt: AT, upcoming: { everCollected: true, entries: [calEntry()] } },
  );
  const eventPos = html.indexOf("중국 규제 조사");
  const calPos = html.indexOf("NVDA 실적 발표");
  assert.ok(eventPos > 0 && calPos > eventPos, "the calendar slide should follow the event slide");
  assert.match(html, /id="briefDots"/);
});

test("never collected contributes no calendar slide, only the quiet fallback", () => {
  // A brief with no events and calendar data that was never synced has
  // nothing true to say about either — the shared "오늘의 브리핑" deck falls
  // back to its own generic quiet card rather than a calendar-specific one.
  const html = withUpcoming({ everCollected: false, entries: [] });
  assert.match(html, /오늘은 특별한 소식이 없습니다/);
  assert.ok(!html.includes("D-"));
});

test("collected but nothing upcoming falls back to the same quiet card as no events", () => {
  const html = withUpcoming({ everCollected: true, entries: [] });
  assert.match(html, /오늘은 특별한 소식이 없습니다/);
  assert.ok(!html.includes('notice-slide warn"'));
});

test("an upcoming earnings date shows D-day and its consensus", () => {
  const html = withUpcoming({ everCollected: true, entries: [calEntry()] });
  assert.match(html, /D-3/);
  assert.match(html, /class="notice-slide notice"/);
});

test("FOMC gets the warm tone; a past event fades to neutral", () => {
  const fomc = withUpcoming({
    everCollected: true,
    entries: [calEntry({ kind: "fomc", assetSymbol: null, title: "FOMC 금리 결정" })],
  });
  assert.match(fomc, /class="notice-slide warn"/);

  const past = withUpcoming({
    everCollected: true,
    entries: [calEntry({ scheduledAt: "2026-08-10T09:00:00Z", status: "occurred" })],
  });
  assert.match(past, /class="notice-slide flat"/);
  assert.match(past, /발표 완료/);
});

/**
 * §16: a glance, not a repeating alarm. Nothing here should read as more
 * urgent the closer the date gets — same tone at D-5 as at D-0.
 */
test("no consensus figure is shown when the source did not provide one", () => {
  const html = withUpcoming({ everCollected: true, entries: [calEntry({ consensus: null })] });
  assert.ok(!html.includes("시장 예상"));
});

test("titles in calendar slides are escaped", () => {
  const html = withUpcoming({
    everCollected: true,
    entries: [calEntry({ title: `<script>alert(1)</script>` })],
  });
  assert.ok(!html.includes("<script>alert(1)"));
});

test("more than five upcoming events still renders only five slides with dots", () => {
  // assetSymbol left off NVDA so these don't also land on its detail page —
  // this test is about the home carousel's cap, not the per-asset section.
  const entries = Array.from({ length: 7 }, (_, i) => calEntry({ id: `e${i}`, assetSymbol: null }));
  const html = withUpcoming({ everCollected: true, entries });
  const count = (html.match(/class="notice-slide notice"/g) ?? []).length;
  assert.equal(count, 5);
  assert.match(html, /id="briefDots"/);
});
