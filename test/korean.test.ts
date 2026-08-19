import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { stage1 } from "../src/pipeline/dedup.js";
import { isAboutAsset } from "../src/pipeline/relevance.js";
import { feedsForAsset } from "../src/sources/feeds.js";
import { parseFeed } from "../src/sources/rss.js";

const NVDA = { symbol: "NVDA", name: "엔비디아", aliases: ["Nvidia", "NVIDIA"] };
const CONFIG: Config = { ...DEFAULT_CONFIG, assets: [NVDA], extraFeeds: {} };

function items() {
  return parseFeed(fs.readFileSync("fixtures/google-news-ko.xml", "utf8"), "fallback");
}

test("a Korean search feed is added for assets with a Hangul name", () => {
  const feeds = feedsForAsset("NVDA", CONFIG);
  assert.equal(feeds.length, 2);
  assert.match(feeds[1]!, /news\.google\.com\/rss\/search/);
  assert.match(feeds[1]!, /ceid=KR%3Ako/);
  // The query must be the Korean name; searching "NVDA" returns English.
  assert.match(feeds[1]!, /q=%EC%97%94%EB%B9%84%EB%94%94%EC%95%84/);
});

test("an asset with no Korean name gets only the ticker feed", () => {
  const config: Config = {
    ...CONFIG,
    assets: [{ symbol: "NVDA", name: "Nvidia", aliases: [] }],
  };
  assert.equal(feedsForAsset("NVDA", config).length, 1);
});

test("extraFeeds are still appended", () => {
  const config: Config = { ...CONFIG, extraFeeds: { NVDA: ["https://example.com/rss"] } };
  assert.deepEqual(feedsForAsset("NVDA", config).slice(-1), ["https://example.com/rss"]);
});

/**
 * Google News differs from Yahoo in ways that break naive parsing: the
 * publisher sits in a <source> element that also carries a url attribute, and
 * the link is a redirect rather than the article's own address.
 */
test("the publisher name is read out of the source element, not the attribute", () => {
  const parsed = items();
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]!.source, "한국경제");
  assert.equal(parsed[1]!.source, "이데일리");
});

test("Korean titles, dates and redirect links survive parsing", () => {
  const first = items()[0]!;
  assert.match(first.title, /^엔비디아, 오라클과 80억 달러/);
  assert.equal(first.publishedAt, "2026-08-17T08:20:00.000Z");
  assert.match(first.link, /^https:\/\/news\.google\.com\/rss\/articles\//);
});

test("the HTML description is reduced to text", () => {
  const first = items()[0]!;
  assert.ok(!first.snippet.includes("<"), first.snippet);
  assert.ok(!first.snippet.includes("&nbsp;"), first.snippet);
  assert.match(first.snippet, /엔비디아/);
});

test("relevance matches on the Korean name", () => {
  assert.equal(isAboutAsset("중국, 엔비디아 H200 공급 방식 조사 착수", "", NVDA), true);
  assert.equal(isAboutAsset("삼성전자, 3분기 실적 발표 앞두고 반등", "", NVDA), false);
});

/**
 * A Korean search feed still returns articles about other companies — the
 * query matches loosely. The relevance filter is what keeps them out, exactly
 * as it does for Yahoo's English feed.
 */
test("stage1 keeps the Korean articles about this asset and drops the rest", () => {
  const result = stage1(items(), {
    nearDuplicateThreshold: 0.7,
    maxAgeDays: 7,
    now: new Date("2026-08-19T18:00:00Z"),
    relevance: NVDA,
  });

  assert.equal(result.kept.length, 2);
  assert.ok(result.kept.every((a) => /엔비디아/.test(a.title)));
  assert.equal(result.dropped.filter((d) => d.reason === "off_topic").length, 1);
});
