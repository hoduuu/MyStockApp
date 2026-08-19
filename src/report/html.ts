import type { AssetBrief, Gap } from "./brief.js";
import type { Upcoming } from "./calendar.js";
import type { MarketRow } from "./market.js";
import type { Timeline } from "./timeline.js";

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
  },
): string {
  const timelines = opts.timelines ?? [];
  const market = opts.market ?? [];
  const upcoming = opts.upcoming;
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

${upcomingBlock(upcoming)}
${market.length > 0 ? marketBlock(indices, pairs) : ""}

    <div class="head"><h2>관심자산</h2></div>
    <div class="rows">
${briefs.map((b) => assetRow(b, withRecord.has(b.symbol))).join("\n")}
    </div>

    <p class="foot">${fmtTime(opts.generatedAt)} 기준</p>
  </div>
</div>
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

// --- upcoming events -----------------------------------------------------------

/**
 * The blue notice slides from the mockup, filled for real now that
 * report/calendar.ts exists (docs/DESIGN.md §12.0b left this empty on
 * purpose rather than inventing a schedule).
 *
 * Three states, same shape as the per-asset gap handling: never collected
 * says nothing (a widget that hasn't been asked a question yet isn't
 * entitled to render an answer); collected-but-empty says so quietly;
 * anything upcoming gets a slide each, D-day first.
 *
 * §16: this is a glance, not a repeating alarm — one line per event, no
 * countdown escalation, nothing louder as the date approaches.
 */
function upcomingBlock(up: Upcoming | undefined): string {
  if (!up || !up.everCollected) return "";

  if (up.entries.length === 0) {
    return [
      `    <div class="deck" id="cal">`,
      `      <div class="notice-slide flat"><p class="line">앞으로 예정된 주요 일정이 없습니다.</p></div>`,
      `    </div>`,
    ].join("\n");
  }

  const slides = up.entries.slice(0, 5).map(upcomingSlide);
  return [
    `    <div class="deck" id="cal">`,
    ...slides,
    `    </div>`,
    dots("calDots", slides.length),
  ].join("\n");
}

function upcomingSlide(e: Upcoming["entries"][number]): string {
  const tone = e.status === "occurred" ? "flat" : e.kind === "fomc" ? "warn" : "notice";
  const sub = e.consensus?.epsAverage !== undefined
    ? `시장 예상 EPS ${esc(String(e.consensus.epsAverage))}`
    : e.status === "occurred"
    ? "발표 완료"
    : "";

  return `      <div class="notice-slide ${tone}">
        <p class="kicker">${esc(dday(e.scheduledAt))}</p>
        <p class="line">${esc(e.title)}</p>
        ${sub ? `<p class="sub2">${sub}</p>` : ""}
      </div>`;
}

/** "오늘 19:00" for the same day, "D-3" beyond that. Past events read "발표됨". */
function dday(iso: string): string {
  const days = Math.floor((Date.parse(iso) - startOfDay(new Date())) / 86_400_000);
  if (days === 0) return `오늘 ${iso.slice(11, 16)}`;
  if (days < 0) return "발표됨";
  return `D-${days}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// --- market ------------------------------------------------------------------

function marketBlock(indices: MarketRow[], pairs: MarketRow[]): string {
  const parts = ['    <div class="head"><h2>시장</h2></div>'];

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
 * A dot strip for a single page would be decoration claiming to be a control,
 * so it only appears once there is somewhere to go.
 */
function dots(id: string, pages: number): string {
  if (pages < 2) return "";
  const items = Array.from({ length: pages }, (_, i) => `<i${i === 0 ? ' class="on"' : ""}></i>`).join("");
  return `    <div class="dots" id="${id}">${items}</div>`;
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

/**
 * No previous close means no change to draw. Rendering 0.00% there would be a
 * claim that the market did not move, which is not what the absence means.
 */
function change(r: MarketRow): string {
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

function dir(r: MarketRow): string {
  if (r.change === null || r.change === 0) return "flat";
  return r.change > 0 ? "up" : "down";
}

function signed(pct: number): string {
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`;
}

function fmtPrice(n: number): string {
  const digits = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 2 : 4;
  return n.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// --- watchlist ---------------------------------------------------------------

function assetRow(b: AssetBrief, hasRecord: boolean): string {
  const n = b.events.length;
  const quiet = n === 0;
  const mark = quiet ? "─" : "●".repeat(Math.min(n, 3));

  return `      <details class="row${quiet ? " quiet" : ""}">
        <summary>
          <span class="sym">${esc(b.symbol)}</span>
          <span class="nm">${esc(b.name)}</span>
          <span class="dt">${mark}</span>
          <span class="gist${b.gap?.kind === "outage" ? " warn" : ""}">${esc(gist(b))}</span>
        </summary>
        <div class="detail">
${b.gap ? gapNotice(b.gap) : ""}
${b.events.map((e, i) => eventCard(e, i + 1)).join("\n")}
${hasRecord ? `          <p class="more"><a href="#tl-${esc(b.symbol)}">사건 기록장 전체 보기 ›</a></p>` : ""}
        </div>
      </details>`;
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

function eventCard(e: AssetBrief["events"][number], index: number): string {
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

  return `          <article class="ev">
            <h3><span class="i">${circled(index)}</span>${esc(e.title)}${flags
              .map((f) => `<span class="flag">${esc(f)}</span>`)
              .join("")}</h3>
            <p class="summary">${esc(e.summary)}</p>
            <p class="src">${sources}${e.followupCount > 0 ? `<span class="fu">후속 ${e.followupCount}건</span>` : ""}</p>
          </article>`;
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

/** Only job: keep the page dots in step with a swipe. */
const SCRIPT = `
for (const [deck, dots] of [["cal","calDots"],["mkt","mktDots"],["pair","pairDots"]]) {
  const d = document.getElementById(deck);
  const strip = document.getElementById(dots);
  if (!d || !strip) continue;
  const items = strip.querySelectorAll("i");
  d.addEventListener("scroll", () => {
    const i = Math.round(d.scrollLeft / d.clientWidth);
    items.forEach((x, k) => x.classList.toggle("on", k === i));
  }, { passive: true });
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
.foot{margin:24px 0 0; font-size:11px; color:var(--ink-3); text-align:center;}

/* market */
.deck{display:flex; overflow-x:auto; scroll-snap-type:x mandatory; scrollbar-width:none;
  margin:0 -14px; padding:0 14px; gap:10px;}
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
.dots{display:flex; gap:5px; justify-content:center; margin:9px 0 0;}
.dots i{width:5px; height:5px; border-radius:50%; background:var(--ink-3); opacity:.28;
  transition:opacity .15s, width .15s;}
.dots i.on{opacity:.8; width:14px; border-radius:3px;}

.notice-slide{border-radius:14px; padding:14px 16px; margin-bottom:9px;}
.notice-slide .kicker{margin:0 0 3px; font-size:11px; font-weight:700; letter-spacing:.03em; opacity:.75;}
.notice-slide .line{margin:0; font-size:14px; font-weight:700; line-height:1.45;}
.notice-slide .sub2{margin:3px 0 0; font-size:11.5px; font-weight:400; opacity:.8;}
/* Earnings and other scheduled releases read as informational; FOMC gets the
   one warm tone on the page, and a past event fades to the neutral grey used
   for "nothing to report" elsewhere. */
.notice-slide.notice{background:var(--notice-bg); color:var(--notice);}
.notice-slide.warn{background:var(--warn-bg); color:var(--warn);}
.notice-slide.flat{background:var(--flat-bg); color:var(--ink-2);}
.notice-slide.flat .line{font-weight:500;}

/* watchlist */
.rows{border:1px solid var(--line); border-radius:13px; overflow:hidden; background:var(--card);}
.row{border-bottom:1px solid var(--line-2);}
.row:last-child{border-bottom:none;}
.row > summary{display:flex; align-items:baseline; gap:9px; padding:13px 14px;
  cursor:pointer; list-style:none;}
.row > summary::-webkit-details-marker{display:none;}
.row .sym{font-size:13px; font-weight:700; width:44px; flex:none;}
.row .nm{font-size:12.5px; color:var(--ink-3); width:74px; flex:none;}
.row .dt{font-size:9px; letter-spacing:.14em; color:var(--accent); width:30px; flex:none;}
.row .gist{font-size:12.5px; color:var(--ink-2); flex:1; min-width:0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
/* An asset with nothing to report is the quietest row on the page. */
.row.quiet .sym{font-weight:500; color:var(--ink-2);}
.row.quiet .dt{color:var(--ink-3); opacity:.45;}
.row.quiet .gist{color:var(--ink-3);}
.row .gist.warn{color:var(--warn);}
.detail{padding:0 14px 12px;}
.notice{margin:0 0 4px; padding:8px 0 0; font-size:11.5px; color:var(--ink-2);}
.notice.warn{color:var(--warn);}
.ev{padding:12px 0; border-top:1px solid var(--line-2);}
.ev h3{margin:0; font-size:13.5px; font-weight:600; line-height:1.5;}
.ev h3 .i{color:var(--ink-3); font-weight:400; margin-right:5px;}
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
