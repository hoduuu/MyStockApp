import assert from "node:assert/strict";
import test from "node:test";
import { canonicalUrl, jaccard, normalizeTitle, titleTokens } from "../src/pipeline/normalize.js";

test("canonicalUrl strips tracking params, fragments and www", () => {
  assert.equal(
    canonicalUrl("https://www.reuters.com/tech/story/?utm_source=rss&utm_medium=feed&ref=home#top"),
    "https://reuters.com/tech/story",
  );
});

test("canonicalUrl keeps meaningful query params", () => {
  assert.equal(
    canonicalUrl("https://example.com/article?id=42&utm_source=x"),
    "https://example.com/article?id=42",
  );
});

test("canonicalUrl collapses amp and mobile mirrors onto the same key", () => {
  const a = canonicalUrl("https://amp.cnn.com/story/amp");
  const b = canonicalUrl("https://www.cnn.com/story");
  assert.equal(a, b);
});

test("canonicalUrl sorts params so ordering does not create a false duplicate", () => {
  assert.equal(
    canonicalUrl("https://example.com/a?b=2&a=1"),
    canonicalUrl("https://example.com/a?a=1&b=2"),
  );
});

test("canonicalUrl returns the input unchanged when it is not a URL", () => {
  assert.equal(canonicalUrl("  not-a-url  "), "not-a-url");
});

test("normalizeTitle drops publisher suffix and ticker parentheticals", () => {
  assert.equal(
    normalizeTitle("Nvidia weighs new approach to China supply (NASDAQ: NVDA) - Reuters"),
    "nvidia weighs new approach to china supply",
  );
});

test("normalizeTitle makes differently-styled syndications identical", () => {
  const a = normalizeTitle("Nvidia weighs new approach to China H200 chip supply, sources say - Reuters");
  const b = normalizeTitle("Nvidia Weighs New Approach to China H200 Chip Supply, Sources Say | Bloomberg");
  assert.equal(a, b);
});

test("jaccard scores near-identical headlines above the default threshold", () => {
  const a = titleTokens(normalizeTitle("Nvidia weighs a new approach to its China H200 chip supply, sources say - CNBC"));
  const b = titleTokens(normalizeTitle("Nvidia weighs new approach to China H200 chip supply, sources say - Reuters"));
  assert.ok(jaccard(a, b) >= 0.7, `expected >= 0.7, got ${jaccard(a, b)}`);
});

test("jaccard keeps genuinely different stories apart", () => {
  const a = titleTokens(normalizeTitle("Nvidia weighs new approach to China H200 chip supply"));
  const b = titleTokens(normalizeTitle("Nvidia announces $8 billion data center expansion with Oracle"));
  assert.ok(jaccard(a, b) < 0.5, `expected < 0.5, got ${jaccard(a, b)}`);
});

test("jaccard of an empty set is zero, not NaN", () => {
  assert.equal(jaccard(new Set(), new Set(["a"])), 0);
});
