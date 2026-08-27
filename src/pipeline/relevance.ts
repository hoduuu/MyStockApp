/**
 * Is this article actually about the asset?
 *
 * Yahoo's per-ticker feed is not a feed about that ticker. On a single run,
 * DELL's feed carried Sandisk, Micron, Vanguard, Penguin Solutions and Cisco
 * stories; WDC's carried Cerebras, Intel, AMD and SpaceX. These are not noise
 * — they are real articles about real events, just not this asset's.
 *
 * No noise pattern can fix that: the distinction is not headline shape but
 * subject. So Stage 1 asks a separate question, and the two filters stay
 * separate because they fail differently — a bad noise pattern drops a
 * category of headline, a bad alias list drops one asset's entire feed.
 *
 * The rule is deliberately blunt: the asset has to be named. A story about a
 * company that never names it, in title or lede, is one this app can afford to
 * miss — far more affordable than the alternative, which the first real run
 * showed to be a brief where most entries concern other companies.
 */
export interface RelevanceTerms {
  symbol: string;
  name: string;
  aliases: string[];
}

export function isAboutAsset(
  title: string,
  snippet: string,
  terms: RelevanceTerms,
): boolean {
  const haystack = `${title} ${snippet}`;
  return buildPatterns(terms).some((re) => re.test(haystack));
}

/**
 * One pattern per term, with word boundaries only where they mean something.
 *
 * `\b` is defined against ASCII word characters, so `\b엔비디아\b` never
 * matches: neither side of a Hangul run is a word boundary at all. And even if
 * it were available, it would be wrong — Korean particles attach directly to
 * the noun ("엔비디아가", "엔비디아는"), so the term has to match as a
 * substring. Boundaries are therefore added per edge, and only when that edge
 * is ASCII: "DELL" still avoids "Dellinger", "MU" still avoids "much".
 *
 * Ticker-shaped terms are matched case-sensitively. Lowercasing them turns
 * short tickers into common English words — "ON", "IT", "ALL", "SO" are all
 * real listings, and "A" is Agilent. Names carry no such risk.
 *
 * A short Hangul name has the mirror problem on its left edge: real bug,
 * "델" (DELL's Korean name) matched inside "사우델" (a typhoon name), and
 * would just as happily match inside "모델" ("model"). A trailing particle
 * always follows a term with nothing but a space/punctuation/string-start
 * before it, never another Hangul syllable — so a term starting with Hangul
 * requires the preceding character not be one too. This only guards the left
 * edge: it cannot tell "델타" (Delta) from "델이" (a particle), which both
 * put a Hangul syllable right after "델" — not a problem this app has hit yet.
 */
function buildPatterns(terms: RelevanceTerms): RegExp[] {
  const out: RegExp[] = [];
  for (const term of [terms.symbol, terms.name, ...terms.aliases]) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const open = /^[A-Za-z0-9]/.test(trimmed)
      ? "\\b"
      : /^[가-힣]/.test(trimmed)
      ? "(?<![가-힣])"
      : "";
    const close = /[A-Za-z0-9]$/.test(trimmed) ? "\\b" : "";
    out.push(new RegExp(`${open}${escaped}${close}`, isTickerShaped(trimmed) ? "" : "i"));
  }
  return out;
}

function isTickerShaped(term: string): boolean {
  return /^[A-Z][A-Z0-9.\-]{0,5}$/.test(term);
}
