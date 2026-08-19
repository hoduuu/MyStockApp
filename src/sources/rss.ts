import { XMLParser } from "fast-xml-parser";
import type { RawItem } from "../types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

/** RSS 2.0 and Atom differ enough to need both shapes handled. */
export function parseFeed(xml: string, fallbackSource: string): RawItem[] {
  const doc = parser.parse(xml) as Record<string, any>;

  const channel = doc?.rss?.channel ?? doc?.["rdf:RDF"];
  const feedSource: string =
    channel?.title?.["#text"] ?? channel?.title ?? doc?.feed?.title?.["#text"] ?? doc?.feed?.title ?? fallbackSource;

  const rssItems = asArray(channel?.item);
  if (rssItems.length > 0) {
    return rssItems.map((it) => fromRss(it, String(feedSource))).filter(isUsable);
  }

  return asArray(doc?.feed?.entry)
    .map((e) => fromAtom(e, String(feedSource)))
    .filter(isUsable);
}

function fromRss(item: any, feedSource: string): RawItem {
  return {
    title: text(item?.title),
    link: text(item?.link) || text(item?.guid),
    source: text(item?.source) || text(item?.["dc:creator"]) || feedSource,
    snippet: stripHtml(text(item?.description) || text(item?.["content:encoded"])),
    publishedAt: toIso(text(item?.pubDate) || text(item?.["dc:date"])),
  };
}

function fromAtom(entry: any, feedSource: string): RawItem {
  const link = Array.isArray(entry?.link)
    ? entry.link.find((l: any) => l?.["@_rel"] !== "self")?.["@_href"]
    : (entry?.link?.["@_href"] ?? entry?.link);

  return {
    title: text(entry?.title),
    link: String(link ?? ""),
    source: text(entry?.author?.name) || feedSource,
    snippet: stripHtml(text(entry?.summary) || text(entry?.content)),
    publishedAt: toIso(text(entry?.published) || text(entry?.updated)),
  };
}

function isUsable(item: RawItem): boolean {
  return item.title.length > 0 && item.link.length > 0;
}

function asArray(v: unknown): any[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as object)) {
    return String((v as Record<string, unknown>)["#text"] ?? "").trim();
  }
  return "";
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Feeds are inconsistent about date format; anything unparseable becomes "now". */
function toIso(raw: string): string {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

export async function fetchFeed(url: string, timeoutMs = 20_000): Promise<RawItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some publishers reject requests without a browser-shaped UA.
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) mystock/0.0 (personal use)",
        accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return parseFeed(await res.text(), new URL(url).hostname);
  } finally {
    clearTimeout(timer);
  }
}
