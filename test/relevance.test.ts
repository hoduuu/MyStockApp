import assert from "node:assert/strict";
import test from "node:test";
import { stage1 } from "../src/pipeline/dedup.js";
import { isAboutAsset } from "../src/pipeline/relevance.js";
import type { RawItem } from "../src/types.js";

/**
 * Every headline below was carried by the named asset's Yahoo feed on
 * 2026-08-19. Three of DELL's twelve items were about Dell; the rest were
 * real news about Sandisk, Micron, Cisco and others.
 */
const DELL = { symbol: "DELL", name: "델", aliases: ["Dell", "Dell Technologies", "Alienware"] };
const WDC = { symbol: "WDC", name: "웨스턴디지털", aliases: ["Western Digital", "SanDisk"] };

const ABOUT_ASSET: [typeof DELL, string, string][] = [
  [DELL, "Dell Technologies to Hold Conference Call Sept. 1 to Discuss Second Quarter Results", "Dell Technologies (NYSE: DELL) will conduct a conference call"],
  [DELL, "Dell Near All-Time Highs on Record Revenue, AI Demand", "Shares of Dell Technologies, Inc."],
  [DELL, "Bull of the Day: Dell (DELL)", ""],
  // Named only by a brand alias in the title, and by the parent in the lede.
  [DELL, "Team Liquid and Alienware Extend Esports' Longest-Running Partnership", "Team Liquid and Dell Technologies' gaming brand, Alienware"],
  // Ticker appears in the lede, not the headline.
  [DELL, "5 Top Stocks With Strong Relative Price Strength Signals", "RELY, PARR, SNDK, DELL and NESR emerge as picks"],
  [WDC, "Western Digital, Nova, and Penguin Solutions Shares Plummet", "A number of stocks fell in the morning session"],
];

for (const [asset, title, snippet] of ABOUT_ASSET) {
  test(`relevant to ${asset.symbol}: ${title.slice(0, 50)}`, () => {
    assert.equal(isAboutAsset(title, snippet, asset), true);
  });
}

const OTHER_COMPANY: [typeof DELL, string, string][] = [
  [DELL, "Up More Than 3,400% in the Past 12 Months, Here's Why Sandisk's Stock Could Still Go Higher", "Sandisk recently unveiled long-term guidance"],
  [DELL, "OSS Establishes New U.S. Navy Relationship with $1.3 Million Rugged Data Storage Order", ""],
  [DELL, "Penguin Solutions' Partner Network Broadens: Is More Growth Ahead?", ""],
  [WDC, "Memory's Cyclicality is No More, So I Keep Loading Up on Micron", ""],
  [WDC, "Cerebras, Intel, and AMD Shares Fall Ahead of Tonight's 'Supernova' Event", ""],
  [WDC, "MU, SNDK Dip Overnight: KOSPI Hits Halt Amid Asian Tech Chip Rout", ""],
];

for (const [asset, title, snippet] of OTHER_COMPANY) {
  test(`off-topic for ${asset.symbol}: ${title.slice(0, 50)}`, () => {
    assert.equal(isAboutAsset(title, snippet, asset), false);
  });
}

/**
 * Short tickers are ordinary English words. Lowercasing the match would make
 * ON Semiconductor's feed accept every article containing the word "on".
 */
test("a ticker-shaped term is matched case-sensitively", () => {
  const on = { symbol: "ON", name: "온세미", aliases: [] };
  assert.equal(isAboutAsset("Chip demand depends on AI capex", "", on), false);
  assert.equal(isAboutAsset("ON Semiconductor raises guidance", "", on), true);
});

test("a word boundary keeps a ticker out of longer words", () => {
  const dell = { symbol: "DELL", name: "델", aliases: ["Dell"] };
  assert.equal(isAboutAsset("Dellinger named to the board at Acme", "", dell), false);
});

/**
 * Korean particles attach to the noun, so a Hangul term has to match as a
 * substring. `\b` is ASCII-only and would reject every one of these.
 */
test("a Korean name matches with a particle attached", () => {
  const nvda = { symbol: "NVDA", name: "엔비디아", aliases: [] };
  for (const title of [
    "엔비디아가 오라클과 계약을 맺었다",
    "엔비디아는 중국 수출 규제에 대응 중",
    "중국, 엔비디아 H200 조사 착수",
    "'엔비디아' 실적 발표 임박",
  ]) {
    assert.equal(isAboutAsset(title, "", nvda), true, title);
  }
  assert.equal(isAboutAsset("삼성전자, 3분기 실적 발표", "", nvda), false);
});

/**
 * Real bug, observed on DELL: "사우델" (a typhoon name) ends in "델" and got
 * matched as if it named the company. A Hangul term now requires the
 * preceding character not be Hangul too, since a real mention never has one
 * there (only a space, punctuation, or the string start).
 */
test("a short Korean name does not match inside an unrelated word that happens to end with it", () => {
  const dell = { symbol: "DELL", name: "델", aliases: ["Dell"] };
  assert.equal(isAboutAsset("태풍 '사우델' 발생 초읽기…한반도 영향 가능성은?", "", dell), false);
  assert.equal(isAboutAsset("이 모델은 최신 트렌드를 반영했다", "", dell), false);
  assert.equal(isAboutAsset("델, 신제품 발표", "", dell), true);
  assert.equal(isAboutAsset("델의 3분기 실적", "", dell), true);
});

test("without relevance terms stage1 keeps everything, as before", () => {
  const items: RawItem[] = [
    {
      title: "Micron raises guidance",
      link: "https://example.com/a",
      source: "Reuters",
      snippet: "",
      publishedAt: "2026-08-19T09:00:00Z",
    },
  ];
  const withoutTerms = stage1(items, {
    nearDuplicateThreshold: 0.7,
    maxAgeDays: 7,
    now: new Date("2026-08-19T18:00:00Z"),
  });
  assert.equal(withoutTerms.kept.length, 1);

  const withTerms = stage1(items, {
    nearDuplicateThreshold: 0.7,
    maxAgeDays: 7,
    now: new Date("2026-08-19T18:00:00Z"),
    relevance: DELL,
  });
  assert.equal(withTerms.kept.length, 0);
  assert.equal(withTerms.dropped[0]!.reason, "off_topic");
});
