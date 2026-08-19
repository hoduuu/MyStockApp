import assert from "node:assert/strict";
import test from "node:test";
import { stage1 } from "../src/pipeline/dedup.js";
import type { RawItem } from "../src/types.js";

const NOW = new Date("2026-08-19T18:00:00Z");
const OPTS = { nearDuplicateThreshold: 0.7, maxAgeDays: 7, now: NOW };

function item(over: Partial<RawItem>): RawItem {
  return {
    title: "Nvidia announces something",
    link: "https://example.com/a",
    source: "Example",
    snippet: "",
    publishedAt: "2026-08-18T09:00:00Z",
    ...over,
  };
}

test("collapses a wire story syndicated across four outlets into one article", () => {
  const result = stage1(
    [
      item({ title: "Nvidia weighs new approach to China H200 chip supply, sources say - Reuters", link: "https://reuters.com/a", source: "Reuters" }),
      item({ title: "Nvidia Weighs New Approach to China H200 Chip Supply, Sources Say | Bloomberg", link: "https://bloomberg.com/b", source: "Bloomberg", publishedAt: "2026-08-18T10:00:00Z" }),
      item({ title: "Nvidia weighs new approach to China H200 chip supply, sources say", link: "https://finance.yahoo.com/c", source: "Yahoo", publishedAt: "2026-08-18T11:00:00Z" }),
      item({ title: "Nvidia weighs a new approach to its China H200 chip supply, sources say - CNBC", link: "https://cnbc.com/d", source: "CNBC", publishedAt: "2026-08-18T12:00:00Z" }),
    ],
    OPTS,
  );

  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0]!.source, "Reuters", "should keep the earliest report");
  assert.equal(result.dropped.filter((d) => d.reason === "near_duplicate").length, 3);
});

test("treats the same URL with tracking params as an exact duplicate", () => {
  const result = stage1(
    [
      item({ link: "https://reuters.com/story/" }),
      item({ link: "https://www.reuters.com/story/?utm_source=rss#top", publishedAt: "2026-08-18T13:00:00Z" }),
    ],
    OPTS,
  );
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped[0]!.reason, "duplicate_url");
});

test("does not re-admit an article already stored in a previous run", () => {
  const result = stage1([item({ link: "https://reuters.com/story" })], {
    ...OPTS,
    knownUrls: new Set(["https://reuters.com/story"]),
  });
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped[0]!.reason, "duplicate_url");
});

test("drops noise before it can occupy a cluster", () => {
  const result = stage1([item({ title: "Why Nvidia stock is moving today" })], OPTS);
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped[0]!.reason, "noise");
});

test("drops articles older than the window", () => {
  const result = stage1([item({ publishedAt: "2026-07-02T08:00:00Z" })], OPTS);
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped[0]!.reason, "too_old");
});

test("keeps distinct real stories", () => {
  const result = stage1(
    [
      item({ title: "Nvidia weighs new approach to China H200 chip supply", link: "https://a.com/1" }),
      item({ title: "Nvidia announces $8 billion data center expansion with Oracle", link: "https://a.com/2" }),
      item({ title: "Nvidia names new head of automotive business", link: "https://a.com/3" }),
    ],
    OPTS,
  );
  assert.equal(result.kept.length, 3);
});

test("assigns stable ids derived from the canonical url", () => {
  const a = stage1([item({ link: "https://reuters.com/x/" })], OPTS);
  const b = stage1([item({ link: "https://www.reuters.com/x?utm_source=rss" })], OPTS);
  assert.equal(a.kept[0]!.id, b.kept[0]!.id);
});
