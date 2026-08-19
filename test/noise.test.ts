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

  // Seen on Yahoo's NVDA feed on 2026-08-19. Both reached the events table
  // before the patterns that catch them existed, and one was additionally
  // mis-filed as a follow-up to a real event (docs/DESIGN.md §4).
  "15 S&P 500 stocks are up 100% or more this year — here's what they have in common",
  "Stock Market Today: Dow Rises On Treasury Buybacks; Moderna Soars On Cancer Drug",
  "2 Nuclear Stocks to Buy and What Each One Needs to Go Right",
  "Jensen Huang's Net Worth Up $28 Billion This Year",
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

  // Guards for the patterns added on 2026-08-19. index-roundup keys on an
  // index name next to a move verb, and numbered-stock-list on a leading
  // count — both shapes a real headline can wander into.
  "Nasdaq-listed Nvidia closes $8 billion Oracle deal",
  "3 nanometer production begins for Nvidia's next accelerator",

  // A price move can be the framing on a real event. These must survive
  // Stage 1; if they carry no event, the importance floor drops them later.
  // See the note at the foot of noise.ts.
  "Nebius Group Sinks 13% on $4.5B Convertible Note Offering and Share Exchange Plan",
  "Serve Robotics Sinks 7% as Guidance Cut Overshadows Grubhub Deal",
];

for (const title of SIGNAL) {
  test(`signal: ${title}`, () => {
    const verdict = classifyNoise(title);
    assert.equal(verdict.isNoise, false, `wrongly dropped as ${verdict.pattern}`);
  });
}
