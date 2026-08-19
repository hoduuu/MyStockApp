import assert from "node:assert/strict";
import test from "node:test";
import { classifyNoise } from "../src/pipeline/noise.js";

const NOISE = [
  "Why Nvidia stock is moving today",
  "Why AMD shares are falling",
  "3 reasons to buy Nvidia stock before 2027",
  "Is Nvidia a buy?",
  "Should you buy Nvidia stock now",
  "Nvidia shares rose 2.4% as chip stocks gained",
  "Stocks to watch Wednesday: Nvidia, Dell, Broadcom",
  "Here's what you need to know about Nvidia's upcoming quarter",
  "Premarket: Nvidia, Tesla, Apple",
  "If you invested $1,000 in Nvidia 10 years ago",
];

for (const title of NOISE) {
  test(`noise: ${title}`, () => {
    assert.equal(classifyNoise(title).isNoise, true);
  });
}

/**
 * The far more damaging failure: dropping a real event. Every headline here
 * describes something the app must surface (brainstorm doc §4 "중요").
 */
const SIGNAL = [
  "Nvidia weighs new approach to China H200 chip supply, sources say",
  "Nvidia announces $8 billion data center expansion with Oracle",
  "China's regulator opens review of Nvidia H200 supply arrangements",
  "Nvidia names new head of automotive business",
  "Nvidia beats Q2 estimates, guides above consensus",
  "US Commerce Department finalizes AI chip export rule",
  "Nvidia and TSMC sign multi-year capacity agreement",
  "Nvidia unveils Rubin architecture at GTC",
];

for (const title of SIGNAL) {
  test(`signal: ${title}`, () => {
    const verdict = classifyNoise(title);
    assert.equal(verdict.isNoise, false, `wrongly dropped as ${verdict.pattern}`);
  });
}
