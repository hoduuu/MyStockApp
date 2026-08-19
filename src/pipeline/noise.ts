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

  // Added after the first real-feed run. Yahoo's per-ticker headline feed mixes
  // general market copy in with company news, and these three shapes made it
  // all the way to events (docs/DESIGN.md §4).
  { name: "stock-market-today", re: /\bstock market today\b/i },
  {
    // "Dow Rises On Treasury Buybacks; Moderna Soars On Cancer Drug" — an index
    // roundup. Not about the asset, whatever ticker's feed carried it.
    //
    // The index has to be the thing moving, so the verb must follow within a
    // few words and the name must not be hyphenated: "Nasdaq-listed Nvidia
    // closes $8 billion Oracle deal" is a real event, and an unanchored
    // `.*` between the two swallowed it.
    name: "index-roundup",
    re: /\b(dow jones|dow|s&\s?p ?500|nasdaq|russell 2000)\b(?!-)(\s+\w+){0,3}\s+(rises?|rose|falls?|fell|climbs?|climbed|slips?|slipped|gains?|gained|drops?|dropped|closes?|closed|jumps?|jumped|sinks?|sank|soars?|soared)\b/i,
  },
  {
    // "15 S&P 500 stocks are up 100% or more this year" — the n-reasons pattern
    // missed it because something sits between the count and the noun.
    name: "numbered-stock-list",
    re: /^\d+\s+.*\bstocks?\b/i,
  },
  {
    // "Jensen Huang's Net Worth Up $28 Billion This Year". About a person's
    // wealth, never about the business. Companies do not have a "net worth" in
    // headline English, so this does not collide with real coverage.
    name: "net-worth",
    re: /\bnet worth\b/i,
  },
];

/*
 * Deliberately NOT a pattern: a move verb next to a percentage
 * (`/(sinks?|falls?|jumps?)\s+\d+%/`). It would have caught two observed
 * headlines that are pure price chatter — "Intel and AMD Fall 4%, NVIDIA
 * Unchanged as Chip Selloff Defies Bond Yield Relief" — but also these:
 *
 *   "Nebius Group Sinks 13% on $4.5B Convertible Note Offering"
 *   "Serve Robotics Sinks 7% as Guidance Cut Overshadows Grubhub Deal"
 *
 * Both report a genuine corporate event and merely lead with the price
 * reaction. A rule cannot separate "X fell 4%" from "X fell 4% because Y
 * happened", and dropping a real event is the failure this project can least
 * afford — it leaves no trace anywhere downstream.
 *
 * Price-move headlines that carry no event get handled a stage later instead:
 * they score below the importance floor and never become events. Verified on
 * 2026-08-19, when all three survivors of an NVDA run scored under 40 and the
 * brief correctly said nothing had happened.
 */

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
