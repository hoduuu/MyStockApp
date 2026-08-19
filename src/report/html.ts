import type { AssetBrief, Gap } from "./brief.js";

/**
 * The brief as a single self-contained HTML file — no server, no bundler, no
 * dependencies, nothing to install. Written to disk and opened in a browser.
 *
 * This exists to test one claim from docs/DESIGN.md §12 before committing to a
 * desktop stack: can the reader tell "nothing happened" from "something
 * happened" in about five seconds, without scrolling? If the layout cannot do
 * that as a static page, Electron or Tauri will not rescue it.
 *
 * Design decisions carried over from §12, each load-bearing:
 *   · Dots, not counts or colours. Red and green read as price moves, which
 *     this app deliberately does not report.
 *   · The no-events row is the quietest thing on the page. A screen of "─"
 *     means close the tab — that is the app working, not failing.
 *   · Related articles sit two clicks away. The friction is the point (§7).
 *   · No charts, no badges, no "NEW", no animation: every one of those exists
 *     to pull someone back, and this app is trying to do the opposite.
 */
export function renderBriefHtml(
  briefs: AssetBrief[],
  opts: { windowLabel: string; generatedAt: Date },
): string {
  const moved = briefs.filter((b) => b.events.length > 0).length;
  const anyMock = briefs.some((b) => b.events.some((e) => e.provider === "mock"));

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>브리핑 — 지난 ${esc(opts.windowLabel)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="shell">
  <nav class="rail">
    <p class="rail-label">지난 ${esc(opts.windowLabel)}</p>
    <ul class="rail-list">
${briefs.map(railRow).join("\n")}
    </ul>
    <p class="rail-foot">${fmtTime(opts.generatedAt)} 기준</p>
  </nav>
  <main>
    <header class="lede">
      <p class="lede-line">${esc(headline(moved, briefs.length))}</p>
      ${anyMock ? `<p class="sample-note">[샘플]로 표시된 항목은 규칙으로 조립한 mock 요약입니다. 실제 AI 분석이 아닙니다.</p>` : ""}
    </header>
${briefs.map(assetSection).join("\n")}
  </main>
</div>
</body>
</html>
`;
}

/**
 * The first line, and the only one that has to be read. Everything below it is
 * detail for the case where the answer is "something".
 */
function headline(moved: number, total: number): string {
  if (total === 0) return "관심자산이 없습니다.";
  if (moved === 0) return "특별한 변화 없음.";
  return `${total}개 자산 중 ${moved}개에 변화가 있습니다.`;
}

function railRow(b: AssetBrief): string {
  const n = b.events.length;
  const mark = n === 0 ? "─" : "●".repeat(Math.min(n, 3));
  return `      <li><a href="#${esc(b.symbol)}" class="${n === 0 ? "quiet" : "active"}">` +
    `<span class="sym">${esc(b.symbol)}</span><span class="dots">${mark}</span></a></li>`;
}

function assetSection(b: AssetBrief): string {
  const parts: string[] = [
    `    <section class="asset" id="${esc(b.symbol)}">`,
    `      <h2><span class="sym">${esc(b.symbol)}</span> <span class="name">${esc(b.name)}</span></h2>`,
  ];

  if (b.gap) parts.push(gapNotice(b.gap));

  if (b.events.length === 0) {
    parts.push(`      <p class="empty">${esc(emptyText(b))}</p>`);
  } else {
    parts.push(...b.events.map((e, i) => eventCard(e, i + 1)));
  }

  parts.push("    </section>");
  return parts.join("\n");
}

/**
 * Shown whenever a gap exists, including next to events — three events found
 * in six hours are not three events in a week (§12.3-⑤).
 *
 * Only a real outage gets the warning tone. Telling someone their collector
 * broke when they added the asset an hour ago is false, and this notice is
 * exactly the one that has to stay trustworthy.
 */
function gapNotice(gap: Gap): string {
  const [tone, text] =
    gap.kind === "never"
      ? ["info", "아직 수집한 적이 없습니다."]
      : gap.kind === "cold_start"
      ? ["info", `${fmtDate(gap.to)}부터 수집을 시작했습니다. 그 이전 기간은 확인되지 않았습니다.`]
      : ["warn", `${fmtDate(gap.from)} ~ ${fmtDate(gap.to)} 사이 뉴스를 수집하지 못했습니다. 이 기간의 사건은 누락되었을 수 있습니다.`];
  return `      <p class="notice ${tone}">${esc(text)}</p>`;
}

function emptyText(b: AssetBrief): string {
  if (b.state === "ONLY_FOLLOWUPS") return "최근 뉴스는 대부분 기존 이슈의 후속 보도입니다.";
  if (b.state === "NO_DATA") return "";
  return "특별히 새로운 중요한 사건은 없습니다.";
}

function eventCard(e: AssetBrief["events"][number], index: number): string {
  const flags = [
    e.certainty === "speculative" ? `<span class="flag">전망</span>` : "",
    e.provider === "mock" ? `<span class="flag sample">샘플</span>` : "",
  ].join("");

  const followups =
    e.followupCount > 0 ? `<p class="followups">후속 보도 ${e.followupCount}건</p>` : "";

  const sources = e.articles
    .map(
      (a) =>
        `          <li><a href="${esc(a.url)}" target="_blank" rel="noreferrer noopener">` +
        `<span class="outlet">${esc(a.source)}</span>${esc(a.title)}</a></li>`,
    )
    .join("\n");

  return `      <article class="event">
        <h3><span class="idx">${circled(index)}</span>${esc(e.title)}${flags}</h3>
        <p class="summary">${esc(e.summary)}</p>
        ${followups}
        <details>
          <summary>관련 기사 ${e.articles.length}</summary>
          <ul class="sources">
${sources}
          </ul>
        </details>
      </article>`;
}

// --- helpers -----------------------------------------------------------------

function circled(n: number): string {
  return "①②③④⑤⑥⑦⑧⑨".charAt(n - 1) || `${n}.`;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, ".").replace(/^\d{4}\./, "");
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

const STYLE = `
:root {
  color-scheme: dark light;
  --bg:#14171a; --surface:#1b1f23; --line:#2a3036;
  --ink:#dfe4e8; --ink-2:#9aa5ae; --ink-3:#68757e;
  --accent:#7fb2a6; --warn:#c9a227;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg:#f6f7f8; --surface:#ffffff; --line:#e2e6e9;
    --ink:#1c2226; --ink-2:#5a666e; --ink-3:#8b979f;
    --accent:#3d7a6c; --warn:#8a6d10;
  }
}
* { box-sizing:border-box; }
body {
  margin:0; background:var(--bg); color:var(--ink);
  font:15px/1.7 "Noto Sans KR","Malgun Gothic",-apple-system,system-ui,sans-serif;
}
.shell { display:grid; grid-template-columns:180px minmax(0,1fr); max-width:860px; margin:0 auto; }
@media (max-width:700px) { .shell { grid-template-columns:1fr; } .rail { position:static; } }

.rail { position:sticky; top:0; align-self:start; padding:40px 16px; }
.rail-label, .rail-foot { margin:0; font-size:11px; letter-spacing:.06em; color:var(--ink-3); }
.rail-foot { margin-top:20px; }
.rail-list { list-style:none; margin:14px 0 0; padding:0; }
.rail-list a {
  display:flex; justify-content:space-between; gap:10px; align-items:baseline;
  padding:5px 0; text-decoration:none; color:var(--ink-2);
}
.rail-list a:hover { color:var(--ink); }
.rail-list .sym { font-size:13px; letter-spacing:.02em; }
.rail-list .dots { font-size:10px; color:var(--accent); letter-spacing:.12em; }
/* An asset with nothing to report is the quietest row on the page. */
.rail-list .quiet { color:var(--ink-3); }
.rail-list .quiet .dots { color:var(--ink-3); opacity:.5; }

main { padding:40px 28px 96px; min-width:0; }
.lede { border-bottom:1px solid var(--line); padding-bottom:22px; margin-bottom:8px; }
.lede-line { margin:0; font-size:19px; font-weight:600; letter-spacing:-.01em; }
.sample-note { margin:10px 0 0; font-size:12px; color:var(--ink-3); }

.asset { padding-top:34px; scroll-margin-top:16px; }
.asset h2 { margin:0 0 10px; font-size:14px; font-weight:600; letter-spacing:.02em; }
.asset h2 .name { color:var(--ink-3); font-weight:400; margin-left:6px; }

.empty { margin:0; color:var(--ink-3); font-size:14px; }
.notice { margin:0 0 12px; font-size:12.5px; color:var(--ink-2); }
.notice.warn { color:var(--warn); }

.event {
  background:var(--surface); border:1px solid var(--line); border-radius:10px;
  padding:16px 18px; margin:10px 0 0;
}
.event h3 { margin:0; font-size:15px; font-weight:600; line-height:1.5; }
.event h3 .idx { color:var(--ink-3); margin-right:7px; font-weight:400; }
.flag {
  display:inline-block; margin-left:7px; padding:1px 6px; border-radius:4px;
  font-size:10.5px; font-weight:500; vertical-align:1px;
  border:1px solid var(--line); color:var(--ink-3);
}
.summary { margin:8px 0 0; color:var(--ink-2); font-size:14px; }
.followups { margin:8px 0 0; font-size:12.5px; color:var(--ink-3); }

details { margin-top:12px; }
summary {
  cursor:pointer; font-size:12.5px; color:var(--ink-3);
  list-style:none; width:fit-content;
}
summary::-webkit-details-marker { display:none; }
summary::before { content:"▸ "; }
details[open] summary::before { content:"▾ "; }
summary:hover { color:var(--ink-2); }
.sources { list-style:none; margin:10px 0 0; padding:0; }
.sources li { margin:0 0 6px; }
.sources a { color:var(--ink-2); text-decoration:none; font-size:13px; }
.sources a:hover { color:var(--accent); text-decoration:underline; }
.sources .outlet { color:var(--ink-3); margin-right:8px; font-size:12px; }

a:focus-visible, summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
`;
