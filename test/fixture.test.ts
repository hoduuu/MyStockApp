import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { stage1 } from "../src/pipeline/dedup.js";
import { parseFeed } from "../src/sources/rss.js";

/**
 * End-to-end check of Stage 1 against the offline corpus. The counts in
 * fixtures/nvda-sample.xml's header comment are the contract; if this test
 * fails after a threshold change, that is the signal to look at what moved.
 */
const NOW = new Date("2026-08-19T18:00:00Z");

function fixtureItems() {
  return parseFeed(fs.readFileSync("fixtures/nvda-sample.xml", "utf8"), "fixture");
}

test("fixture parses into 16 items", () => {
  assert.equal(fixtureItems().length, 16);
});

test("RSS parsing pulls title, link, source and date", () => {
  const first = fixtureItems()[0]!;
  assert.match(first.title, /H200 chip supply/);
  assert.equal(first.source, "Reuters");
  assert.equal(first.publishedAt, "2026-08-18T09:12:00.000Z");
  assert.match(first.snippet, /^Nvidia is evaluating/);
});

test("stage1 reduces the fixture from 16 to 5", () => {
  const result = stage1(fixtureItems(), {
    nearDuplicateThreshold: 0.7,
    maxAgeDays: 7,
    now: NOW,
  });

  const reasons = result.dropped.reduce<Record<string, number>>((acc, d) => {
    acc[d.reason] = (acc[d.reason] ?? 0) + 1;
    return acc;
  }, {});

  assert.equal(result.kept.length, 5, `kept ${result.kept.map((k) => k.title).join(" | ")}`);
  assert.equal(reasons.near_duplicate, 3, "the 4-outlet wire story should collapse to one");
  assert.equal(reasons.duplicate_url, 1, "the tracking-param repost");
  assert.equal(reasons.noise, 6, "the six listicle/price-move headlines");
  assert.equal(reasons.too_old, 1, "the July item");
});

test("every real story survives stage1 and no noise does", () => {
  const result = stage1(fixtureItems(), { nearDuplicateThreshold: 0.7, maxAgeDays: 7, now: NOW });
  const titles = result.kept.map((a) => a.title);

  assert.ok(titles.some((t) => /weighs new approach to China H200/.test(t)), "H200 supply story");
  assert.ok(titles.some((t) => /data center expansion with Oracle/.test(t)), "Oracle deal");
  assert.ok(titles.some((t) => /regulator opens review/.test(t)), "China regulator follow-up");
  assert.ok(titles.some((t) => /head of automotive/.test(t)), "management change");
  assert.ok(!titles.some((t) => /Why Nvidia stock/.test(t)), "noise must not survive");
});

/**
 * Stage 1 must not over-merge. The Reuters and FT reports of the Oracle deal
 * share almost no headline vocabulary ("$8 billion data center expansion" vs
 * "build new AI data center capacity in $8bn deal"), so rules cannot tell they
 * are one story — that is exactly the job Stage 2 embeddings exist to do.
 * If a threshold change ever merges these two, Stage 2 is being asked to do
 * less than it should and real events will start disappearing.
 */
test("stage1 leaves lexically-different reports of one story for stage2", () => {
  const result = stage1(fixtureItems(), { nearDuplicateThreshold: 0.7, maxAgeDays: 7, now: NOW });
  const oracle = result.kept.filter((a) => /oracle/i.test(a.title));
  assert.equal(oracle.length, 2);
  assert.deepEqual(oracle.map((a) => a.source).sort(), ["Financial Times", "Reuters"]);
});

test("Atom feeds parse as well as RSS", () => {
  const atom = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Example Feed</title>
      <entry>
        <title>Nvidia signs capacity agreement with TSMC</title>
        <link rel="alternate" href="https://example.com/story"/>
        <published>2026-08-18T09:00:00Z</published>
        <summary>The two companies agreed on multi-year capacity.</summary>
      </entry>
    </feed>`;
  const items = parseFeed(atom, "fallback");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.link, "https://example.com/story");
  assert.equal(items[0]!.publishedAt, "2026-08-18T09:00:00.000Z");
});
