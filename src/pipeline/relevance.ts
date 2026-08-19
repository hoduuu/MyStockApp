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
 * One pattern per term, anchored on word boundaries so "DELL" does not fire on
 * "Dellinger" and "MU" does not fire on "much".
 *
 * Ticker-shaped terms are matched case-sensitively. Lowercasing them turns
 * short tickers into common English words — "ON", "IT", "ALL", "SO" are all
 * real listings, and "A" is Agilent. Company names and Korean names are
 * matched case-insensitively, where that risk does not arise.
 */
function buildPatterns(terms: RelevanceTerms): RegExp[] {
  const out: RegExp[] = [];
  for (const term of [terms.symbol, terms.name, ...terms.aliases]) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out.push(
      isTickerShaped(trimmed)
        ? new RegExp(`\\b${escaped}\\b`)
        : new RegExp(`\\b${escaped}\\b`, "i"),
    );
  }
  return out;
}

function isTickerShaped(term: string): boolean {
  return /^[A-Z][A-Z0-9.\-]{0,5}$/.test(term);
}
