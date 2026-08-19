/** URL and headline normalization — the cheap half of Stage 1. */

const TRACKING_PARAMS = [
  /^utm_/,
  /^ga_/,
  /^_hs/,
  ...["fbclid", "gclid", "dclid", "msclkid", "igshid", "mc_cid", "mc_eid"].map(
    (p) => new RegExp(`^${p}$`),
  ),
  ...[".tsrc", "ncid", "ref", "ref_src", "cmpid", "smid", "partner", "yptr", "guccounter", "soc_src", "soc_trk"].map(
    (p) => new RegExp(`^${p.replace(".", "\\.")}$`),
  ),
];

/**
 * Collapse the many URLs that point at one article into a single key.
 * Syndication, AMP mirrors and share links all differ only in ways stripped here.
 */
export function canonicalUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }

  u.hash = "";
  u.protocol = "https:";

  let host = u.hostname.toLowerCase();
  host = host.replace(/^www\./, "").replace(/^amp\./, "").replace(/^m\./, "");
  u.hostname = host;

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }
  u.searchParams.sort();

  let path = u.pathname.replace(/\/amp\/?$/, "").replace(/\.amp$/, "");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  u.pathname = path || "/";

  return u.toString().replace(/\?$/, "");
}

/** Publisher suffixes that RSS titles carry: "… - Reuters", "… | Bloomberg". */
const PUBLISHER_SUFFIX = /\s*[-–—|]\s*[^-–—|]{2,30}$/;

/**
 * Reduce a headline to comparable tokens: drop the publisher suffix, ticker
 * parentheticals, punctuation and case. Two syndications of one wire story
 * normalize to the same string surprisingly often.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(PUBLISHER_SUFFIX, "")
    .replace(/\((?:NASDAQ|NYSE|AMEX):\s*[A-Z.]+\)/gi, "")
    .replace(/\b[A-Z]{1,5}:[A-Z]{1,5}\b/g, "")
    .toLowerCase()
    .replace(/['’"“”]/g, "")
    .replace(/[^\p{L}\p{N}%$]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "as", "at",
  "by", "is", "are", "was", "were", "be", "with", "from", "its", "it", "that",
  "this", "after", "amid", "over", "into", "says", "say", "said", "new",
]);

export function titleTokens(titleNorm: string): Set<string> {
  return new Set(
    titleNorm.split(" ").filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}
