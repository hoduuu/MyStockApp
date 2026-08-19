/**
 * The "잡음" tier from the brainstorm doc §4: pure price-movement chatter,
 * listicles and recycled outlooks. These never become events, so they are
 * dropped before they cost anything.
 *
 * This list is the single biggest tuning knob in Phase 0. Every pattern here
 * should be justified by a headline actually seen during the 2-week run —
 * resist adding speculative ones, and check `mystock collect --explain`
 * output before tightening.
 */
const NOISE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "why-moving-today", re: /\bwhy\b.*\b(stock|shares?)\b.*\b(is|are|was|were)\b.*\b(moving|up|down|rising|falling|jumping|sinking|soaring|plunging|slipping|climbing|tumbling)\b/i },
  { name: "n-reasons", re: /\b\d+\s+(reasons?|things|stocks?|charts?)\b.*\b(buy|sell|watch|know|own)\b/i },
  { name: "should-you-buy", re: /\b(should you|is it time to|time to)\s+(buy|sell|own)\b/i },
  { name: "is-a-buy", re: /\bis\b.*\ba\s+(buy|sell|screaming buy|value trap)\b\??$/i },
  { name: "price-move-only", re: /\b(stock|shares?)\b.*\b(rose|fell|jumped|slid|climbed|dropped|gained|lost|surged|sank)\b.*\d+(\.\d+)?%/i },
  { name: "movers-list", re: /\b(stocks?|shares?)\s+(to watch|on the move|making the biggest moves?)\b/i },
  { name: "market-wrap", re: /\b(market wrap|premarket|pre-market|after hours|closing bell|opening bell|market recap|stocks? close[ds]?)\b/i },
  { name: "heres-what-to-know", re: /\bhere'?s what (you need to know|to know)\b/i },
  { name: "if-you-invested", re: /\bif you (had )?invested\b/i },
  { name: "millionaire-bait", re: /\b(millionaire|retire rich|get rich|to the moon|next big thing)\b/i },
  { name: "prediction-bait", re: /\b(prediction|forecast)s?\b.*\b(20\d\d)\b.*\b(where will|could|might)\b/i },
];

export interface NoiseVerdict {
  isNoise: boolean;
  pattern?: string;
}

export function classifyNoise(title: string): NoiseVerdict {
  for (const { name, re } of NOISE_PATTERNS) {
    if (re.test(title)) return { isNoise: true, pattern: name };
  }
  return { isNoise: false };
}
