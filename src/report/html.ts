import type { AssetBrief, Gap } from "./brief.js";
import type { Upcoming } from "./calendar.js";
import type { AssetQuote, MarketRow } from "./market.js";
import type { HistoryPoint } from "../sources/market.js";
import type { Timeline } from "./timeline.js";
import type { Instrument } from "../types.js";

/**
 * The home screen as a single self-contained HTML file — no server, no
 * bundler, no dependencies. Written to disk and opened in a browser.
 *
 * It exists to test one claim from docs/DESIGN.md §12 before committing to a
 * desktop stack: can the reader separate "nothing happened" from "something
 * happened" in about five seconds, without scrolling? If a static page cannot
 * do that, the problem is the information layout and no framework fixes it.
 *
 * Load-bearing decisions, all from §12 and the review that followed:
 *   · Market first, then watchlist. The market is the backdrop you glance at;
 *     the events are what you came for.
 *   · One line per asset, events behind a click. Summaries on the home screen
 *     made it a wall of text, which is the opposite of the point.
 *   · Dots, not counts, for event volume — "several" is the useful fact.
 *   · The no-events row is the quietest thing on the page. A screen of "─"
 *     means close the tab: that is the app working, not failing.
 *   · Index moves use the Korean convention (red up, blue down) with the
 *     percentage in a filled box. Events carry no colour — they have no
 *     direction for colour to encode.
 *   · The record rides along as a second view, switched by :target, so the
 *     back button works without a router.
 */
export function renderBriefHtml(
  briefs: AssetBrief[],
  opts: {
    windowLabel: string;
    generatedAt: Date;
    timelines?: Timeline[];
    market?: MarketRow[];
    upcoming?: Upcoming;
    assetQuotes?: Map<string, AssetQuote | null>;
    priceHistory?: Map<string, HistoryPoint[]>;
    allInstruments?: Instrument[];
    assetSeenAt?: Map<string, string | null>;
  },
): string {
  const timelines = opts.timelines ?? [];
  const market = opts.market ?? [];
  const upcoming = opts.upcoming;
  const assetQuotes = opts.assetQuotes;
  const priceHistory = opts.priceHistory;
  const allInstruments = opts.allInstruments ?? [];
  const assetSeenAt = opts.assetSeenAt;
  const indices = market.filter((r) => r.instrument.slot === "index");
  const pairs = market.filter((r) => r.instrument.slot === "pair");
  const withRecord = new Set(timelines.map((t) => t.symbol));

  const moved = briefs.filter((b) => b.events.length > 0).length;
  const anyMock =
    briefs.some((b) => b.events.some((e) => e.provider === "mock")) ||
    timelines.some((t) => t.entries.some((e) => e.provider === "mock"));

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>브리핑 — 지난 ${esc(opts.windowLabel)}</title>
<style>${STYLE}</style>
</head>
<body>
${FLAGS}
<div class="view" id="home">
  <div class="app">
    <p class="lede">${esc(headline(moved, briefs.length))}</p>
    <p class="sub">지난 ${esc(opts.windowLabel)}${anyMock ? " · [샘플]은 규칙으로 조립한 mock 요약이며 실제 AI 분석이 아닙니다" : ""}</p>

${briefingBlock(briefs, upcoming, opts.generatedAt, withRecord)}
${market.length > 0 ? marketBlock(indices, pairs) : ""}

    <div class="head"><h2>관심자산</h2><a class="head-action" href="#settings" aria-label="관심자산 추가">+</a></div>
    <div class="wcards">
${briefs
  .map((b) => assetRow(b, assetQuotes?.get(b.symbol) ?? null, hasUnseen(b, assetSeenAt?.get(b.symbol) ?? null)))
  .join("\n")}
    </div>

    <p class="foot">${fmtTime(opts.generatedAt)} 기준</p>
  </div>
</div>
${settingsView(allInstruments, briefs)}
${briefs
  .map((b) =>
    assetDetailView(
      b,
      assetQuotes?.get(b.symbol) ?? null,
      priceHistory?.get(b.symbol) ?? [],
      upcoming?.entries.filter((e) => e.assetSymbol === b.symbol) ?? [],
      withRecord.has(b.symbol),
      opts.generatedAt,
      hasUnseen(b, assetSeenAt?.get(b.symbol) ?? null),
    ),
  )
  .join("\n")}
${timelines.map(timelineView).join("\n")}
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** The first line, and the only one that has to be read. */
function headline(moved: number, total: number): string {
  if (total === 0) return "관심자산이 없습니다.";
  if (moved === 0) return "특별한 변화 없음.";
  return `${total}개 자산 중 ${moved}개에 변화가 있습니다.`;
}

/**
 * The badge, unlike the plain "moved" count above, is about what's *new since
 * you looked at this asset* — never seen at all counts as new (there's
 * something to see and nothing recorded that you've seen it yet).
 */
function hasUnseen(b: AssetBrief, seenAt: string | null): boolean {
  if (b.events.length === 0) return false;
  if (seenAt === null) return true;
  const cutoff = Date.parse(seenAt);
  return b.events.some((e) => Date.parse(e.firstSeenAt) > cutoff);
}

// --- 오늘의 브리핑 --------------------------------------------------------------

/**
 * The home screen's first content, above the market grid. Every card here is
 * either a real event that was found (AssetBrief.events) or a real scheduled
 * date (Upcoming.entries) — never a written-sounding characterization like
 * "반도체주 중심으로 상승" or "FOMC 전망에 변화 없음", because neither is a fact
 * this pipeline has. The market numbers already say what moved; this deck
 * says what happened and what's coming, nothing invented in between.
 *
 * Calendar slides used to live in their own deck between the headline and the
 * market grid. They're folded in here instead, so there is one carousel to
 * skim rather than two, and the market grid stays the very next thing down
 * regardless of how many cards precede it.
 */
function briefingBlock(
  briefs: AssetBrief[],
  up: Upcoming | undefined,
  now: Date,
  withRecord: Set<string>,
): string {
  const eventSlides = briefs
    .flatMap((b) => b.events.map((e) => ({ b, e })))
    .sort((a, z) => z.e.importance - a.e.importance)
    .slice(0, 8)
    .map(({ b, e }) => briefEventSlide(b, e, withRecord.has(b.symbol)));

  const calendarSlides =
    up && up.everCollected ? up.entries.slice(0, 5).map((e) => upcomingSlide(e, now)) : [];

  const slides = [...eventSlides, ...calendarSlides];

  if (slides.length === 0) {
    return [
      `    <div class="head"><h2>오늘의 브리핑</h2></div>`,
      `    <div class="deck" id="brief">`,
      `      <div class="notice-slide flat"><p class="line">오늘은 특별한 소식이 없습니다.</p></div>`,
      `    </div>`,
    ].join("\n");
  }

  return [
    `    <div class="head"><h2>오늘의 브리핑</h2></div>`,
    `    <div class="deck" id="brief">`,
    ...slides,
    `    </div>`,
    dots("briefDots", slides.length),
  ].join("\n");
}

/**
 * A real event, condensed. Links to the asset's record when one exists
 * (true whenever `brief --html` built it, which is always in practice);
 * falls back to the first article so the card is never a dead end.
 */
function briefEventSlide(
  b: AssetBrief,
  e: AssetBrief["events"][number],
  hasRecord: boolean,
): string {
  const url = hasRecord ? `#tl-${b.symbol}` : (e.articles[0]?.url ?? null);
  const tag = url ? "a" : "div";
  const attrs = url
    ? ` href="${esc(url)}"${hasRecord ? "" : ' target="_blank" rel="noreferrer noopener"'}`
    : "";
  return `      <${tag} class="notice-slide event"${attrs}>
        <p class="kicker">${esc(b.symbol)} · ${esc(b.name)}</p>
        <p class="line">${esc(e.title)}</p>
        <p class="sub2 clamp">${esc(e.summary)}</p>
      </${tag}>`;
}

function upcomingSlide(e: Upcoming["entries"][number], now: Date): string {
  const tone = e.status === "occurred" ? "flat" : e.kind === "fomc" ? "warn" : "notice";
  const sub = e.consensus?.epsAverage !== undefined
    ? `시장 예상 EPS ${esc(String(e.consensus.epsAverage))}`
    : e.status === "occurred"
    ? "발표 완료"
    : "";

  return `      <div class="notice-slide ${tone}">
        <p class="kicker">${esc(dday(e.scheduledAt, now))}</p>
        <p class="line">${esc(e.title)}</p>
        ${sub ? `<p class="sub2">${sub}</p>` : ""}
      </div>`;
}

/** "오늘 19:00" for the same day, "D-3" beyond that. Past events read "발표됨". */
function dday(iso: string, now: Date): string {
  const days = Math.floor((Date.parse(iso) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `오늘 ${iso.slice(11, 16)}`;
  if (days < 0) return "발표됨";
  return `D-${days}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// --- market ------------------------------------------------------------------

function marketBlock(indices: MarketRow[], pairs: MarketRow[]): string {
  const parts = [
    '    <div class="head"><h2>시장</h2><a class="head-action" href="#settings" aria-label="시장 항목 편집">⚙</a></div>',
  ];

  if (indices.length > 0) {
    const pages = chunk(indices, 6);
    parts.push(
      `    <div class="deck" id="mkt">`,
      ...pages.map((p) => `      <div class="grid">\n${p.map(tile).join("\n")}\n      </div>`),
      `    </div>`,
      dots("mktDots", pages.length),
    );
  }

  if (pairs.length > 0) {
    const pages = chunk(pairs, 2);
    parts.push(
      `    <div class="deck" id="pair">`,
      ...pages.map((p) => `      <div class="pair">\n${p.map(pairCard).join("\n")}\n      </div>`),
      `    </div>`,
      dots("pairDots", pages.length),
    );
  }

  return parts.filter(Boolean).join("\n");
}

/**
 * Arrows + dots for a deck — a single page gets neither, since a control
 * that goes nowhere is decoration pretending otherwise. Mouse users have no
 * natural gesture for a horizontal-scroll deck the way a touch/trackpad
 * swipe does, so the arrows are the primary way to advance, not a hint
 * alongside one; the deck itself is still swipeable/scrollable underneath.
 */
function dots(id: string, pages: number): string {
  if (pages < 2) return "";
  const deckId = id.replace(/Dots$/, "");
  const items = Array.from({ length: pages }, (_, i) => `<i${i === 0 ? ' class="on"' : ""}></i>`).join("");
  return `    <div class="deck-nav">
      <button type="button" class="deck-arrow" data-deck-prev="${deckId}" aria-label="이전">‹</button>
      <div class="dots" id="${id}">${items}</div>
      <button type="button" class="deck-arrow" data-deck-next="${deckId}" aria-label="다음">›</button>
    </div>`;
}

function tile(r: MarketRow): string {
  return `        <div class="tile ${dir(r)}">
          <div class="name">${icon(r.instrument.icon)}<span>${esc(r.instrument.name)}</span></div>
          <div class="val">${esc(fmtPrice(r.price))}</div>
          <div class="chg">${change(r)}</div>
        </div>`;
}

function pairCard(r: MarketRow): string {
  return `        <div class="fxc ${dir(r)}">
          <span class="k">${icon(r.instrument.icon)}${esc(r.instrument.name)}</span>
          <span class="v">${esc(fmtPrice(r.price))}</span>
          <span class="p">${r.changePct === null ? "" : esc(signed(r.changePct))}</span>
        </div>`;
}

function signed(pct: number): string {
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`;
}

type PriceInfo = Pick<MarketRow, "change" | "changePct" | "stale" | "ts">;

/**
 * No previous close means no change to draw. Rendering 0.00% there would be a
 * claim that the market did not move, which is not what the absence means.
 */
function change(r: PriceInfo): string {
  if (r.change === null || r.changePct === null) {
    return `<span class="abs none">전일 대비 없음</span>`;
  }
  const arrow = r.change > 0 ? "▲" : r.change < 0 ? "▼" : "—";
  return (
    `<span class="abs">${arrow}${esc(fmtPrice(Math.abs(r.change)))}</span>` +
    `<span class="pct">${esc(Math.abs(r.changePct).toFixed(2))}%</span>` +
    (r.stale ? `<span class="stale" title="${esc(fmtDay(r.ts))} 기준">·</span>` : "")
  );
}

/**
 * The 관심자산 card's price line (§ review, 2026-08-20) — just the filled
 * pill, no arrow and no absolute change. The market tiles keep change() as
 * it was; this is deliberately a plainer sibling for a place that only has
 * room for a glance.
 */
function pctPill(r: PriceInfo): string {
  if (r.changePct === null) return `<span class="abs none">전일 대비 없음</span>`;
  return `<span class="pct">${esc(Math.abs(r.changePct).toFixed(2))}%</span>`;
}

function dir(r: Pick<MarketRow, "change">): string {
  if (r.change === null || r.change === 0) return "flat";
  return r.change > 0 ? "up" : "down";
}

function fmtPrice(n: number): string {
  const digits = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 2 : 4;
  return n.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// --- watchlist ---------------------------------------------------------------

/**
 * A card now, matching the market tiles' visual language (§ review,
 * 2026-08-20) — same border/radius/background, so 관심자산 reads as the same
 * family as 시장 rather than a plain list. A plain link, not an accordion:
 * the row used to carry two jobs — a 30-second glance and a full read — and
 * expanding it in place made the glance itself scroll. The gist line still
 * answers the glance; everything past that lives on the asset's own page.
 *
 * The corner dot clears itself once you open the asset's own page (§ review,
 * 2026-08-20) — it means "an event you haven't looked at yet", tracked via
 * asset_seen, not just "this asset has events" (that's the greyed-out/normal
 * distinction below, which stays keyed to whether there are events at all).
 */
function assetRow(b: AssetBrief, quote: AssetQuote | null, unseen: boolean): string {
  const hasNews = b.events.length > 0;
  const priceLine = quote
    ? `<p class="wprice ${dir(quote)}">${esc(fmtPrice(quote.price))}${pctPill(quote)}</p>`
    : "";

  return `      <a class="wcard${hasNews ? "" : " quiet"}" href="#asset-${esc(b.symbol)}">
        ${unseen ? '<i class="wbadge"></i>' : ""}
        <p class="wname"><span class="sym">${esc(b.symbol)}</span><span class="nm">${esc(b.name)}</span></p>
        ${priceLine}
        <p class="gist${b.gap?.kind === "outage" ? " warn" : ""}">${esc(gist(b))}</p>
      </a>`;
}

/** The one line that has to carry the row when it is collapsed. */
function gist(b: AssetBrief): string {
  if (b.events.length > 0) {
    return b.events
      .slice(0, 2)
      .map((e) => e.title)
      .join(", ");
  }
  if (b.gap?.kind === "never") return "아직 수집 전";
  if (b.gap?.kind === "cold_start") return `${fmtDay(b.gap.to)}부터 수집`;
  if (b.gap?.kind === "outage") return `${fmtDay(b.gap.from)}~${fmtDay(b.gap.to)} 확인 못 함`;
  if (b.state === "ONLY_FOLLOWUPS") return "기존 이슈의 후속 보도만";
  return "변화 없음";
}

/**
 * Shown whenever a gap exists, including next to events — three events found
 * in six hours are not three events in a week (§12.3-⑤). Only a real outage
 * gets the warning tone; telling someone their collector broke when they
 * added the asset an hour ago would be false.
 */
function gapNotice(gap: Gap): string {
  const [tone, text] =
    gap.kind === "never"
      ? ["info", "아직 수집한 적이 없습니다."]
      : gap.kind === "cold_start"
      ? ["info", `${fmtDay(gap.to)}부터 수집을 시작했습니다. 그 이전 기간은 확인되지 않았습니다.`]
      : ["warn", `${fmtDay(gap.from)} ~ ${fmtDay(gap.to)} 사이 뉴스를 수집하지 못했습니다. 이 기간의 사건은 누락되었을 수 있습니다.`];
  return `          <p class="notice ${tone}">${esc(text)}</p>`;
}

/**
 * The title is always visible; the summary and sources are behind a click
 * (`<details>`), matching the "① 제목 + (클릭하면) 요약설명" shape asked for —
 * a title-only skim by default, one tap for the rest.
 */
function detailEventCard(e: AssetBrief["events"][number], index: number): string {
  const flags = [
    e.certainty === "speculative" ? "전망" : null,
    e.provider === "mock" ? "샘플" : null,
  ].filter((f): f is string => f !== null);

  const sources = e.articles
    .map(
      (a) =>
        `<a href="${esc(a.url)}" target="_blank" rel="noreferrer noopener">${esc(a.source)}</a>`,
    )
    .join(" ");

  return `          <details class="ev">
            <summary><span class="i">${circled(index)}</span>${esc(e.title)}${flags
              .map((f) => `<span class="flag">${esc(f)}</span>`)
              .join("")}</summary>
            <div class="ev-body">
              <p class="summary">${esc(e.summary)}</p>
              <p class="src">${sources}${e.followupCount > 0 ? `<span class="fu">후속 ${e.followupCount}건</span>` : ""}</p>
            </div>
          </details>`;
}

// --- asset detail --------------------------------------------------------------

/**
 * The asset's own page (§ review, 2026-08-20): "최근 무슨 일이 있었는지 빠르게
 * 파악" — price, top 3 events (title-first, summary behind a click), what's
 * scheduled next, and a way into the full record. Not a news feed: capped at
 * 3 events on purpose, same reasoning as the home screen's dot cap.
 */
function assetDetailView(
  b: AssetBrief,
  quote: AssetQuote | null,
  history: HistoryPoint[],
  upcomingEntries: Upcoming["entries"],
  hasRecord: boolean,
  now: Date,
  unseen: boolean,
): string {
  const top = b.events.slice(0, 3);
  const rest = b.events.length - top.length;

  // data-unseen is read by the script at the bottom: opening this page marks
  // the asset seen (via window.mystock) only when there was actually a badge
  // to clear, so visiting a quiet asset's page doesn't trigger a pointless
  // reload.
  return `<div class="view detail" id="asset-${esc(b.symbol)}" data-symbol="${esc(b.symbol)}"${unseen ? ' data-unseen="1"' : ""}>
  <div class="app">
    <p class="back"><a href="#home">‹ 브리핑으로</a></p>
    <p class="lede">${esc(b.symbol)} <span class="nm2">${esc(b.name)}</span></p>
    ${quote ? statLine(quote) : ""}

${priceChartBlock(b.symbol, history)}
${b.gap ? gapNotice(b.gap) : ""}
    <div class="head"><h2>최근 주요 사건</h2></div>
${top.length > 0 ? top.map((e, i) => detailEventCard(e, i + 1)).join("\n") : quietEventsNote(b)}
${rest > 0 && hasRecord ? `    <p class="more"><a href="#tl-${esc(b.symbol)}">이 외 ${rest}건은 사건 기록장에서 ›</a></p>` : ""}

${upcomingEntries.length > 0 ? assetUpcomingBlock(upcomingEntries, now) : ""}

${hasRecord ? `    <p class="more"><a href="#tl-${esc(b.symbol)}">사건 기록장 전체 보기 ›</a></p>` : ""}
  </div>
</div>`;
}

function statLine(q: AssetQuote): string {
  return `    <p class="stat-price ${dir(q)}">${esc(fmtPrice(q.price))}<span class="chg">${change(q)}</span></p>`;
}

/**
 * 거시적 추이 only — a plain line over trading days, coloured by whether the
 * period ended above or below where it started. Deliberately not a candle
 * chart and no indicator overlay (RSI/MACD/Bollinger/volume/moving average):
 * those read as trading signals, which is a different product than "what's
 * this stock been doing lately."
 *
 * One fetch (5y daily) backs every period button; the page slices the tail
 * of the embedded array client-side rather than re-fetching per click.
 */
const CHART_PERIODS: { key: string; days: number }[] = [
  { key: "1M", days: 22 },
  { key: "3M", days: 65 },
  { key: "6M", days: 130 },
  { key: "1Y", days: 260 },
  { key: "5Y", days: 0 },
];
const CHART_DEFAULT_DAYS = 65;

function priceChartBlock(symbol: string, history: HistoryPoint[]): string {
  if (history.length < 2) return "";
  const chartId = `chart-${esc(symbol)}`;
  const dataId = `hist-${esc(symbol)}`;

  return `    <div class="head"><h2>주가 추이</h2></div>
    <div class="chart-card">
      <svg class="chart" id="${chartId}" viewBox="0 0 300 90" preserveAspectRatio="none">
        <polyline class="chart-area"></polyline>
        <polyline class="chart-line"></polyline>
      </svg>
      <div class="chart-periods" data-chart="${chartId}" data-hist="${dataId}">
${CHART_PERIODS.map(
  (p) =>
    `        <button type="button" data-days="${p.days}"${p.days === CHART_DEFAULT_DAYS ? ' class="on"' : ""}>${p.key}</button>`,
).join("\n")}
      </div>
    </div>
    <script type="application/json" id="${dataId}">${JSON.stringify(history).replace(/</g, "\\u003c")}</script>`;
}

function assetUpcomingBlock(entries: Upcoming["entries"], now: Date): string {
  return [
    `    <div class="head"><h2>예정된 주요 이벤트</h2></div>`,
    ...entries.map((e) => upcomingSlide(e, now)),
  ].join("\n");
}

/** A gap already explains its own absence (gapNotice above); this only covers a clean "nothing happened". */
function quietEventsNote(b: AssetBrief): string {
  if (b.gap) return "";
  const text = b.state === "ONLY_FOLLOWUPS" ? "기존 이슈의 후속 보도만 있었습니다." : "특별한 변화가 없었습니다.";
  return `    <p class="empty">${esc(text)}</p>`;
}

// --- settings ------------------------------------------------------------------

/**
 * The one page that writes to config.json instead of only reading it (§
 * review, 2026-08-20). The controls only function inside the Electron shell
 * — window.mystock comes from electron/preload.cjs's contextBridge, which a
 * plain browser opening this same brief.html has no equivalent of. The page
 * itself renders identically either way; the script at the bottom disables
 * the controls and says so rather than clicking into a silent failure.
 */
function settingsView(instruments: Instrument[], briefs: AssetBrief[]): string {
  return `<div class="view detail" id="settings">
  <div class="app">
    <p class="back"><a href="#home">‹ 브리핑으로</a></p>
    <p class="lede">설정</p>
    <p class="sub" id="settings-note" hidden>이 화면은 Electron 앱에서 열었을 때만 저장됩니다. 지금은 브라우저로 보고 계셔서 편집이 꺼져 있습니다.</p>

    <div class="head"><h2>시장 항목</h2></div>
    <div class="rows">
${instruments.map(instrumentRow).join("\n")}
    </div>

    <div class="head"><h2>관심자산 추가</h2></div>
    <form id="add-asset-form" class="add-form">
      <input type="text" name="symbol" placeholder="종목 코드 (예: NVDA)" autocomplete="off" required>
      <button type="submit">추가</button>
    </form>
    <p class="sub">이름은 Yahoo에서 자동으로 받아옵니다. 추가한 종목은 다음 collect/market 실행부터 자동으로 수집됩니다.</p>

    <div class="head"><h2>현재 관심자산</h2></div>
    <div class="rows">
${briefs.map((b) => `      <div class="arow"><span class="sym">${esc(b.symbol)}</span><span class="nm">${esc(b.name)}</span></div>`).join("\n")}
    </div>
  </div>
</div>`;
}

function instrumentRow(inst: Instrument): string {
  return `      <label class="setting-row">
        <input type="checkbox" data-instrument-id="${esc(inst.id)}"${inst.enabled ? " checked" : ""}>
        <span class="nm">${esc(inst.name)}</span>
        <span class="sym">${esc(inst.symbol)}</span>
      </label>`;
}

// --- record ------------------------------------------------------------------

/**
 * 사건 기록장 (§6, §12.3-⑥). Deliberately a second screen: it holds
 * everything, including what was too minor to report and what has since
 * closed, and putting all of that on the home screen would undo the brief.
 */
function timelineView(t: Timeline): string {
  const rows: string[] = [];
  let lastMonth = "";

  for (const e of t.entries) {
    const month = e.date.slice(0, 7);
    if (month !== lastMonth) {
      rows.push(`      <h3 class="month">${esc(month.replace("-", "년 "))}월</h3>`);
      lastMonth = month;
    }

    const flags = [
      e.status === "closed" ? "종료" : null,
      e.certainty === "speculative" ? "전망" : null,
      e.provider === "mock" ? "샘플" : null,
    ].filter((f): f is string => f !== null);

    const sources = e.articles
      .map(
        (a) =>
          `<a href="${esc(a.url)}" target="_blank" rel="noreferrer noopener">${esc(a.source)}</a>`,
      )
      .join(" ");

    rows.push(`      <article class="rec${e.status === "closed" ? " closed" : ""}">
        <p class="day">${esc(e.date.slice(8, 10))}일</p>
        <div class="body">
          <h4>${esc(e.title)}${flags.map((f) => `<span class="flag">${esc(f)}</span>`).join("")}</h4>
          <p class="summary">${esc(e.summary)}</p>
          <p class="meta">중요도 ${e.importance} · ${esc(e.category)}${
            e.followupCount > 0 ? ` · 후속 ${e.followupCount}건` : ""
          }${sources ? ` · ${sources}` : ""}</p>
        </div>
      </article>`);
  }

  return `<div class="view detail" id="tl-${esc(t.symbol)}">
  <div class="app">
    <p class="back"><a href="#home">‹ 브리핑으로</a></p>
    <p class="lede">${esc(t.symbol)} · 사건 기록장</p>
    <p class="sub">${esc(t.name)} · 최근 ${t.days}일 · 중요도와 무관하게 전부, 종료된 사건 포함</p>
${rows.length > 0 ? rows.join("\n") : '    <p class="empty">기록된 사건이 없습니다.</p>'}
${rows.length > 0 ? `    <p class="total">총 ${t.entries.length}건</p>` : ""}
  </div>
</div>`;
}

// --- helpers -----------------------------------------------------------------

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function circled(n: number): string {
  return "①②③④⑤⑥⑦⑧⑨".charAt(n - 1) || `${n}.`;
}

function fmtDay(iso: string): string {
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}

function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Titles and snippets come from feeds; nothing from them reaches the DOM raw. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Windows ships no flag emoji, so every flag is drawn rather than typed. */
function icon(name: string): string {
  const flags: Record<string, true> = { us: true, kr: true, eu: true, jp: true, cn: true };
  if (flags[name]) return `<svg class="flag"><use href="#f-${name}"/></svg>`;
  const glyph: Record<string, string> = {
    btc: "₿", eth: "Ξ", gold: "金", silver: "銀", oil: "油",
  };
  return `<span class="chip ${esc(name)}">${glyph[name] ?? "·"}</span>`;
}

const FLAGS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs><clipPath id="cc"><circle cx="12" cy="12" r="12"/></clipPath></defs>
  <symbol id="f-us" viewBox="0 0 24 24"><g clip-path="url(#cc)">
    <rect width="24" height="24" fill="#fff"/>
    <g fill="#b22234"><rect width="24" height="1.85"/><rect y="3.7" width="24" height="1.85"/>
    <rect y="7.4" width="24" height="1.85"/><rect y="11.1" width="24" height="1.85"/>
    <rect y="14.8" width="24" height="1.85"/><rect y="18.5" width="24" height="1.85"/>
    <rect y="22.2" width="24" height="1.85"/></g>
    <rect width="11" height="9.25" fill="#3c3b6e"/></g></symbol>
  <symbol id="f-kr" viewBox="0 0 24 24"><g clip-path="url(#cc)">
    <rect width="24" height="24" fill="#fff"/>
    <circle cx="12" cy="12" r="7.5" fill="#cd2e3a"/>
    <path d="M4.5 12a3.75 3.75 0 0 1 7.5 0 3.75 3.75 0 0 0 7.5 0 7.5 7.5 0 0 1-15 0" fill="#0047a0"/>
  </g></symbol>
  <symbol id="f-eu" viewBox="0 0 24 24"><g clip-path="url(#cc)">
    <rect width="24" height="24" fill="#039"/>
    <g fill="#fc0"><circle cx="12" cy="5" r="1.3"/><circle cx="19" cy="12" r="1.3"/>
    <circle cx="12" cy="19" r="1.3"/><circle cx="5" cy="12" r="1.3"/>
    <circle cx="17" cy="7" r="1.3"/><circle cx="17" cy="17" r="1.3"/>
    <circle cx="7" cy="17" r="1.3"/><circle cx="7" cy="7" r="1.3"/></g></g></symbol>
  <symbol id="f-jp" viewBox="0 0 24 24"><g clip-path="url(#cc)">
    <rect width="24" height="24" fill="#fff"/><circle cx="12" cy="12" r="6.5" fill="#bc002d"/>
  </g></symbol>
  <symbol id="f-cn" viewBox="0 0 24 24"><g clip-path="url(#cc)">
    <rect width="24" height="24" fill="#de2910"/>
    <path d="M6 5.2l1.3 4-3.4-2.5h4.2L4.7 9.2z" fill="#ffde00"/>
    <circle cx="12" cy="4" r="1" fill="#ffde00"/><circle cx="14.5" cy="7" r="1" fill="#ffde00"/>
    <circle cx="14.5" cy="11" r="1" fill="#ffde00"/><circle cx="12" cy="14" r="1" fill="#ffde00"/>
  </g></symbol>
</svg>`;

/** Keeps the page dots in step with a swipe, and draws/redraws the price charts. */
const SCRIPT = `
for (const [deck, dots] of [["brief","briefDots"],["mkt","mktDots"],["pair","pairDots"]]) {
  const d = document.getElementById(deck);
  const strip = document.getElementById(dots);
  if (!d || !strip) continue;
  const items = strip.querySelectorAll("i");
  const kids = [...d.children];

  // Geometry-based rather than assuming a fixed page pitch (deck padding +
  // item gap don't add up to a round clientWidth) — find whichever child's
  // left edge is actually closest to the deck's own, in both directions.
  const current = () => {
    const base = d.getBoundingClientRect().left;
    let best = 0, bestDist = Infinity;
    kids.forEach((k, i) => {
      const dist = Math.abs(k.getBoundingClientRect().left - base);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  };
  const sync = () => {
    const i = current();
    items.forEach((x, k) => x.classList.toggle("on", k === i));
  };
  d.addEventListener("scroll", sync, { passive: true });

  // Mouse users have no swipe gesture for this, so the arrows are the
  // primary control, not a hint alongside one. Past the last page wraps to
  // the first and vice versa — there is no dead end to click into.
  const go = (delta) => {
    const next = (current() + delta + kids.length) % kids.length;
    const offset = kids[next].getBoundingClientRect().left - d.getBoundingClientRect().left;
    d.scrollTo({ left: d.scrollLeft + offset, behavior: "smooth" });
  };
  const prev = document.querySelector('[data-deck-prev="' + deck + '"]');
  const next = document.querySelector('[data-deck-next="' + deck + '"]');
  if (prev) prev.addEventListener("click", () => go(-1));
  if (next) next.addEventListener("click", () => go(1));
}

document.querySelectorAll(".chart-periods").forEach((bar) => {
  const chart = document.getElementById(bar.dataset.chart);
  const dataEl = document.getElementById(bar.dataset.hist);
  if (!chart || !dataEl) return;
  const all = JSON.parse(dataEl.textContent);
  const line = chart.querySelector(".chart-line");
  const area = chart.querySelector(".chart-area");

  function draw(days) {
    const points = days > 0 ? all.slice(-days) : all;
    if (points.length < 2) return;
    const closes = points.map((p) => p.close);
    const min = Math.min(...closes), max = Math.max(...closes);
    const range = max - min || 1;
    const w = 300, h = 90, pad = 4;
    const xy = points.map((p, i) => [
      pad + (i / (points.length - 1)) * (w - pad * 2),
      h - pad - ((p.close - min) / range) * (h - pad * 2),
    ]);
    line.setAttribute("points", xy.map(([x, y]) => x + "," + y.toFixed(1)).join(" "));
    area.setAttribute(
      "points",
      xy.map(([x, y]) => x + "," + y.toFixed(1)).join(" ") +
        " " + xy[xy.length - 1][0] + "," + h + " " + xy[0][0] + "," + h,
    );
    const up = points[points.length - 1].close >= points[0].close;
    chart.classList.toggle("up", up);
    chart.classList.toggle("down", !up);
  }

  bar.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      bar.querySelectorAll("button").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      draw(Number(btn.dataset.days));
    });
  });
  draw(${CHART_DEFAULT_DAYS});
});

if (window.mystock) {
  document.querySelectorAll("[data-instrument-id]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      cb.disabled = true;
      try {
        await window.mystock.toggleInstrument(cb.dataset.instrumentId);
      } catch (err) {
        alert(err && err.message ? err.message : String(err));
        cb.disabled = false;
      }
    });
  });
  const addForm = document.getElementById("add-asset-form");
  if (addForm) {
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = addForm.querySelector("button");
      btn.disabled = true;
      try {
        await window.mystock.addAsset(addForm.symbol.value);
      } catch (err) {
        alert(err && err.message ? err.message : String(err));
        btn.disabled = false;
      }
    });
  }
} else {
  // Opened in a plain browser (no Electron preload bridge): show what's
  // configured, but editing has nowhere to write to.
  document.querySelectorAll("[data-instrument-id]").forEach((cb) => { cb.disabled = true; });
  const addForm = document.getElementById("add-asset-form");
  if (addForm) addForm.querySelector("button").disabled = true;
  const note = document.getElementById("settings-note");
  if (note) note.hidden = false;
}

// Opening an asset's own page with an unread badge marks it seen — the
// reload that follows regenerates the page with the badge cleared. Nothing
// happens for a quiet asset page (no data-unseen) or in a plain browser
// (no bridge to write the seen timestamp through).
if (window.mystock) {
  const markIfUnseen = () => {
    const hash = location.hash.slice(1);
    if (!hash.startsWith("asset-")) return;
    const view = document.getElementById(hash);
    if (!view || !view.dataset.unseen) return;
    window.mystock.markSeen(view.dataset.symbol);
  };
  markIfUnseen();
  window.addEventListener("hashchange", markIfUnseen);
}
`;

const STYLE = `
:root{
  color-scheme: light dark;
  --bg:#eef1f5; --card:#fff; --line:#e4e9ee; --line-2:#eef1f5;
  --ink:#161c22; --ink-2:#5b6873; --ink-3:#8e9aa5;
  --up:#e0342b; --up-bg:#fdeceb;
  --down:#1560c4; --down-bg:#eaf1fd;
  --flat:#8e9aa5; --flat-bg:#f0f2f5;
  --notice:#1f5fd0; --notice-bg:#e5eeff;
  --accent:#2f6f62; --warn:#a97a08; --warn-bg:#faf1de;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0e1114; --card:#181c21; --line:#262c33; --line-2:#20252b;
    --ink:#e6ebef; --ink-2:#9aa6b1; --ink-3:#69757f;
    --up:#f2736a; --up-bg:#2e1a19;
    --down:#6ba3f0; --down-bg:#161f2e;
    --flat:#69757f; --flat-bg:#20252b;
    --notice:#8db6ff; --notice-bg:#16203a;
    --accent:#7fb2a6; --warn:#d6a93c; --warn-bg:#2b2312;
  }
}
*{box-sizing:border-box;}
body{margin:0; background:var(--bg); color:var(--ink);
  font:15px/1.55 "Noto Sans KR","Malgun Gothic",-apple-system,system-ui,sans-serif;}
/* Fixed content width; only the margins are responsive. */
.app{width:min(420px, 100%); margin:0 auto; padding:22px 14px 70px;}

.lede{margin:0; font-size:18px; font-weight:700; letter-spacing:-.015em;}
.sub{margin:5px 0 0; font-size:11.5px; color:var(--ink-3); line-height:1.6;}
.head{display:flex; align-items:center; justify-content:space-between;
  margin:26px 2px 10px; padding-bottom:8px; border-bottom:1px solid var(--line);}
.head h2{margin:0; font-size:14.5px; font-weight:700;}
.head-action{font-size:15px; line-height:1; color:var(--ink-3); text-decoration:none; padding:2px 5px;}
.head-action:hover{color:var(--accent);}
.foot{margin:24px 0 0; font-size:11px; color:var(--ink-3); text-align:center;}

/* market */
/* Two things had to agree to stop a sliver of the next slide peeking in:
   1) scroll-snap-align ignores the container's own padding by default — it
      snaps to the padding-BOX edge, not the content-box edge, so the first
      slide's natural position (inset by padding) got pulled flush against
      the outer edge instead. scroll-padding tells it the snap target is
      inset by the same 14px, so the slide lands where it visually sits.
   2) gap has to equal that padding: a slide fills the content-box exactly,
      so the next one starts right at the padding's inner edge — with a
      smaller gap it bled into the still-visible padding zone and peeked. */
.deck{display:flex; overflow-x:auto; scroll-snap-type:x mandatory; scroll-padding:0 14px;
  scrollbar-width:none; margin:0 -14px; padding:0 14px; gap:14px;}
.deck::-webkit-scrollbar{display:none;}
.deck > *{flex:0 0 100%; scroll-snap-align:start;}
.grid{display:grid; grid-template-columns:repeat(3,1fr); gap:7px;}
.pair{display:grid; grid-template-columns:repeat(2,1fr); gap:7px;}
.tile{background:var(--card); border:1px solid var(--line); border-radius:11px; padding:10px 10px 9px;}
.tile .name{display:flex; align-items:center; gap:5px; font-size:11px; color:var(--ink-2);
  margin-bottom:5px; white-space:nowrap; overflow:hidden;}
.tile .name span{overflow:hidden; text-overflow:ellipsis;}
.tile .val{font-size:15.5px; font-weight:700; letter-spacing:-.035em; font-variant-numeric:tabular-nums;}
.tile .chg{display:flex; align-items:center; gap:4px; margin-top:4px; font-variant-numeric:tabular-nums;}
.tile .abs{font-size:10.5px; font-weight:600; white-space:nowrap;}
.tile .abs.none{color:var(--ink-3); font-weight:400;}
.pct{font-size:10.5px; font-weight:700; padding:1.5px 4.5px; border-radius:4px; font-variant-numeric:tabular-nums;}
.stale{color:var(--ink-3); cursor:help;}
.up .abs{color:var(--up);}   .up .pct{background:var(--up-bg); color:var(--up);}   .up .p{color:var(--up);}
.down .abs{color:var(--down);} .down .pct{background:var(--down-bg); color:var(--down);} .down .p{color:var(--down);}
.flat .abs{color:var(--flat);} .flat .pct{background:var(--flat-bg); color:var(--flat);} .flat .p{color:var(--flat);}
.fxc{background:var(--card); border:1px solid var(--line); border-radius:11px;
  padding:10px 12px; display:flex; align-items:center; gap:7px; font-size:12.5px;}
.fxc .k{display:flex; align-items:center; gap:5px; color:var(--ink-2); white-space:nowrap;}
.fxc .v{font-weight:700; font-variant-numeric:tabular-nums; margin-left:auto;}
.fxc .p{font-size:11px; font-weight:700; font-variant-numeric:tabular-nums;}
.flag{width:15px; height:15px; border-radius:50%; flex:none; display:block;}
.chip{width:15px; height:15px; border-radius:50%; flex:none; display:grid; place-items:center;
  font-size:9px; font-weight:700; color:#fff;}
.chip.btc{background:#f2a33c;} .chip.eth{background:#7a86b8;} .chip.gold{background:#c9a227;}
.chip.silver{background:#9aa6b1;} .chip.oil{background:#4a5560;}
.deck-nav{display:flex; align-items:center; justify-content:center; gap:14px; margin:9px 0 0;}
.deck-arrow{width:26px; height:26px; border-radius:50%; border:1px solid var(--line);
  background:var(--card); color:var(--ink-2); font-size:15px; line-height:1;
  display:grid; place-items:center; cursor:pointer; flex:none;}
.deck-arrow:hover{color:var(--ink); border-color:var(--accent);}
.dots{display:flex; gap:5px; justify-content:center;}
.dots i{width:5px; height:5px; border-radius:50%; background:var(--ink-3); opacity:.28;
  transition:opacity .15s, width .15s;}
.dots i.on{opacity:.8; width:14px; border-radius:3px;}

/* Fixed-ish height (not viewport %) so the card count or summary length never
   pushes the market grid further down the page. */
.notice-slide{border-radius:14px; padding:14px 16px; margin-bottom:9px;
  min-height:104px; display:flex; flex-direction:column; justify-content:center;}
.notice-slide .kicker{margin:0 0 3px; font-size:11px; font-weight:700; letter-spacing:.03em; opacity:.75;}
.notice-slide .line{margin:0; font-size:14px; font-weight:700; line-height:1.45;}
.notice-slide .sub2{margin:3px 0 0; font-size:11.5px; font-weight:400; opacity:.8;}
.notice-slide .sub2.clamp{display:-webkit-box; -webkit-box-orient:vertical;
  -webkit-line-clamp:3; overflow:hidden;}
/* Earnings and other scheduled releases read as informational; FOMC gets the
   one warm tone on the page, and a past event fades to the neutral grey used
   for "nothing to report" elsewhere. */
.notice-slide.notice{background:var(--notice-bg); color:var(--notice);}
.notice-slide.warn{background:var(--warn-bg); color:var(--warn);}
.notice-slide.flat{background:var(--flat-bg); color:var(--ink-2);}
.notice-slide.flat .line{font-weight:500;}
/* A real event card is a fact, not a tone — plain card style like the rest
   of the app (.tile, .fxc, .rows), not one of the tinted notice colours. */
.notice-slide.event{background:var(--card); border:1px solid var(--line);
  color:var(--ink); text-decoration:none; cursor:pointer;}
.notice-slide.event .kicker{color:var(--accent); opacity:1;}
.notice-slide.event:hover{border-color:var(--accent);}

/* watchlist on the settings page — a plain bordered list, .arow rows have no
   card of their own (unlike .wcard below) since there's nothing to click. */
.rows{border:1px solid var(--line); border-radius:13px; overflow:hidden; background:var(--card);}
.arow{display:flex; align-items:baseline; gap:9px; padding:13px 14px;
  border-bottom:1px solid var(--line-2); text-decoration:none; color:inherit;}
.arow:last-child{border-bottom:none;}
.arow:hover{background:var(--line-2);}
.arow .sym{font-size:13px; font-weight:700; width:44px; flex:none;}
.arow .nm{font-size:12.5px; color:var(--ink-3);}

/* watchlist on the home screen — one card per asset, matching the market
   tiles' visual language (border/radius/background) rather than a plain
   list. A plain link, not an accordion: clicking navigates to the asset's
   own page instead of expanding in place. */
.wcards{display:flex; flex-direction:column; gap:8px;}
.wcard{position:relative; display:block; background:var(--card); border:1px solid var(--line);
  border-radius:13px; padding:12px 14px; text-decoration:none; color:inherit;}
.wcard:hover{border-color:var(--accent);}
.wcard.quiet{opacity:.82;}
/* The corner dot is the same "events found since last visit" signal the old
   inline ●●● marks gave — not new data, just a different shape for it. */
.wbadge{position:absolute; top:13px; right:14px; width:8px; height:8px;
  border-radius:50%; background:var(--accent);}
.wname{margin:0; display:flex; align-items:baseline; gap:8px;}
.wname .sym{font-size:14px; font-weight:700;}
.wname .nm{font-size:12px; color:var(--ink-3);}
.wprice{margin:6px 0 0; font-size:17px; font-weight:700; font-variant-numeric:tabular-nums;
  display:flex; align-items:baseline; gap:8px;}
.wcard .gist{margin:6px 0 0; font-size:12px; color:var(--ink-2); overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap;}
.wcard.quiet .gist{color:var(--ink-3);}
.wcard .gist.warn{color:var(--warn);}

/* settings */
.setting-row{display:flex; align-items:center; gap:10px; padding:12px 14px;
  border-bottom:1px solid var(--line-2);}
.setting-row:last-child{border-bottom:none;}
.setting-row input[type="checkbox"]{width:16px; height:16px; flex:none; accent-color:var(--accent);}
.setting-row .nm{flex:1; font-size:13px;}
.setting-row .sym{font-size:11px; color:var(--ink-3);}
.add-form{display:flex; gap:7px; margin:2px 0 0;}
.add-form input{flex:1; min-width:0; border:1px solid var(--line); border-radius:9px;
  padding:9px 10px; font:inherit; font-size:12.5px; background:var(--card); color:var(--ink);}
.add-form button{border:none; border-radius:9px; padding:9px 14px; background:var(--accent);
  color:#fff; font:inherit; font-size:12.5px; font-weight:700; cursor:pointer; flex:none;}
.add-form button:disabled{opacity:.5; cursor:default;}

/* asset detail page */
.nm2{font-size:13px; font-weight:400; color:var(--ink-3); margin-left:6px;}
.stat-price{margin:8px 0 0; font-size:24px; font-weight:700; letter-spacing:-.02em;
  font-variant-numeric:tabular-nums; display:flex; align-items:baseline; gap:9px;}
.stat-price .chg{font-size:13px; font-weight:600;}
/* 주가 추이 — a plain line, no gridlines/axes/indicators, coloured only by
   whether the visible period ended above or below where it started. */
.chart-card{background:var(--card); border:1px solid var(--line); border-radius:13px; padding:12px 10px 10px;}
.chart{width:100%; height:90px; display:block;}
.chart .chart-line{fill:none; stroke:var(--flat); stroke-width:1.6;
  stroke-linejoin:round; stroke-linecap:round; vector-effect:non-scaling-stroke;}
.chart .chart-area{fill:var(--flat); opacity:.1; stroke:none;}
.chart.up .chart-line{stroke:var(--up);} .chart.up .chart-area{fill:var(--up);}
.chart.down .chart-line{stroke:var(--down);} .chart.down .chart-area{fill:var(--down);}
.chart-periods{display:flex; gap:3px; margin-top:8px; justify-content:center;}
.chart-periods button{border:none; background:none; font:inherit; font-size:11px; color:var(--ink-3);
  padding:4px 10px; border-radius:999px; cursor:pointer;}
.chart-periods button.on{background:var(--line-2); color:var(--ink); font-weight:700;}
.notice{margin:0 0 4px; padding:8px 0 0; font-size:11.5px; color:var(--ink-2);}
.notice.warn{color:var(--warn);}
/* Event cards on the detail page are <details>: title always visible, the
   summary and article links are the click-to-reveal payload. */
.ev{padding:12px 0; border-top:1px solid var(--line-2);}
.ev summary{margin:0; font-size:13.5px; font-weight:600; line-height:1.5;
  cursor:pointer; list-style:none;}
.ev summary::-webkit-details-marker{display:none;}
.ev summary .i{color:var(--ink-3); font-weight:400; margin-right:5px;}
.ev-body{padding-top:6px;}
.ev .summary{margin:6px 0 0; font-size:12.5px; color:var(--ink-2); line-height:1.65;}
.ev .src{margin:7px 0 0; font-size:11.5px;}
.ev .src a{color:var(--ink-3); text-decoration:none; margin-right:9px;}
.ev .src a:hover{color:var(--accent); text-decoration:underline;}
.ev .src .fu{color:var(--ink-3);}
.ev .flag, .rec .flag{display:inline-block; width:auto; height:auto; border-radius:4px;
  margin-left:5px; padding:0 5px; font-size:10px; font-weight:500;
  border:1px solid var(--line); color:var(--ink-3); vertical-align:1.5px;}
.more{margin:12px 0 0; font-size:11.5px;}
.more a{color:var(--ink-3); text-decoration:none;}
.more a:hover{color:var(--accent);}

/* views: two screens in one file, switched by :target so the back button works */
.view{display:none;}
#home{display:block;}
.view:target{display:block;}
body:has(.view.detail:target) #home{display:none;}
.back{margin:0 0 16px; font-size:12px;}
.back a{color:var(--ink-3); text-decoration:none;}
.back a:hover{color:var(--accent);}
.month{margin:26px 0 2px; font-size:11px; font-weight:700; letter-spacing:.06em; color:var(--ink-3);}
.rec{display:flex; gap:12px; padding:12px 0; border-bottom:1px solid var(--line);}
.rec:last-of-type{border-bottom:none;}
.rec .day{margin:0; flex:none; width:32px; font-size:11.5px; color:var(--ink-3); padding-top:2px;}
.rec .body{min-width:0;}
.rec h4{margin:0; font-size:13.5px; font-weight:600; line-height:1.5;}
.rec .summary{margin:5px 0 0; font-size:12.5px; color:var(--ink-2);}
.rec .meta{margin:6px 0 0; font-size:11px; color:var(--ink-3);}
.rec .meta a{color:var(--ink-3); text-decoration:none; margin-left:5px;}
.rec .meta a:hover{color:var(--accent); text-decoration:underline;}
/* A closed event is still history, just not live — receded, not hidden. */
.rec.closed h4{color:var(--ink-2); font-weight:500;}
.empty{margin:20px 0 0; font-size:13px; color:var(--ink-3);}
.total{margin:22px 0 0; font-size:11.5px; color:var(--ink-3);}

a:focus-visible, summary:focus-visible{outline:2px solid var(--accent); outline-offset:2px; border-radius:4px;}
`;
