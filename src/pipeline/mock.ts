import type {
  Cluster,
  SynthesisInput,
  SynthesisOutput,
  SynthesisResponse,
  SynthesizedEvent,
} from "../types.js";
import { EVENT_CATEGORIES } from "../types.js";
import { diverseSources } from "./cluster.js";

/**
 * Stage 4 without an API key: turns clusters into events using keyword rules
 * and cluster shape. Free, offline, deterministic.
 *
 * What this is for: exercising everything downstream of Stage 4 — the events
 * table, follow-up matching, the brief, the four empty states, the eventual UI
 * — before deciding whether to pay for real summarization.
 *
 * What it deliberately does NOT do: write prose. Every sentence it emits is
 * assembled from fields that are literally present in the articles. It never
 * invents a number, a cause, or a characterization, because a mock that
 * fabricates plausible-looking analysis would teach us the wrong thing about
 * whether the pipeline works.
 */
export async function mockSynthesize(input: SynthesisInput): Promise<SynthesisResponse> {
  const events: SynthesizedEvent[] = [];

  for (const { id, cluster } of input.clusters) {
    const category = classify(cluster);
    const importance = score(cluster, category);

    // Same floor the real prompt enforces: below 40 is not worth showing.
    if (importance < MIN_IMPORTANCE) continue;

    events.push({
      title: eventTitle(cluster),
      summary: summarize(cluster),
      importance,
      category,
      certainty: "reported",
      evidence: [id],
      importance_reason: `[mock] ${category} 키워드, 기사 ${cluster.articles.length}건, 출처 ${countSources(cluster)}곳`,
    });
  }

  events.sort((a, b) => b.importance - a.importance);

  return {
    output: {
      events,
      one_liner: oneLiner(events, input.assetName),
      no_significant_events: events.length === 0,
    } satisfies SynthesisOutput,
    // Nothing was sent anywhere, so there is nothing to bill.
    usage: {
      model: "mock",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    },
    provider: "mock",
  };
}

const MIN_IMPORTANCE = 40;

// --- classification ----------------------------------------------------------

type Category = (typeof EVENT_CATEGORIES)[number];

/**
 * Ordered most- to least-specific: "earnings guidance on a new chip" should
 * read as earnings, so the first match wins rather than the best-scoring one.
 */
const KEYWORDS: { category: Category; patterns: RegExp }[] = [
  {
    category: "earnings",
    patterns: /\b(earnings|revenue|quarterly|guidance|eps|profit|forecast cut|results)\b|실적|매출|영업이익/i,
  },
  {
    category: "regulation",
    patterns: /\b(regulat\w*|export control|sanction|ban|restrict\w*|tariff|antitrust|lawsuit|probe|investigation|subpoena)\b|규제|제재|소송|조사/i,
  },
  {
    category: "deal",
    patterns: /\b(acqui\w+|merger|takeover|partnership|deal|contract|order worth|stake|investment)\b|인수|합병|계약|파트너십|투자/i,
  },
  {
    category: "product",
    patterns: /\b(launch\w*|unveil\w*|release\w*|introduc\w*|next-gen|roadmap)\b|출시|공개|신제품/i,
  },
  {
    category: "management",
    patterns: /\b(ceo|cfo|chairman|resign\w*|appoint\w*|steps? down|succession)\b|사임|선임|경영진/i,
  },
  {
    category: "macro",
    patterns: /\b(fed|fomc|inflation|interest rate|gdp|jobs report|cpi)\b|금리|물가|고용지표/i,
  },
];

function classify(cluster: Cluster): Category {
  const text = cluster.articles.map((a) => `${a.title} ${a.snippet}`).join(" ");
  for (const { category, patterns } of KEYWORDS) {
    if (patterns.test(text)) return category;
  }
  return "other";
}

// --- scoring -----------------------------------------------------------------

/**
 * Base weight per category, then bumped by how widely the story was covered.
 *
 * `other` sits below the 40 floor on purpose: a lone article nobody else picked
 * up and that matches no event keyword should fall out. Without that, mock mode
 * would report events every single run and the quiet-day states
 * (NO_SIGNIFICANT / ONLY_FOLLOWUPS) would never be reachable — which are
 * exactly the states this app has to get right.
 */
const BASE_WEIGHT: Record<Category, number> = {
  earnings: 78,
  regulation: 74,
  deal: 68,
  product: 66,
  management: 60,
  macro: 50,
  other: 30,
};

function score(cluster: Cluster, category: Category): number {
  const coverage = Math.min(cluster.articles.length - 1, 4) * 3;
  const diversity = (countSources(cluster) - 1) * 4;
  return Math.max(0, Math.min(97, BASE_WEIGHT[category] + coverage + diversity));
}

function countSources(cluster: Cluster): number {
  return new Set(cluster.articles.map((a) => a.source.toLowerCase())).size;
}

// --- text (assembled, never written) -----------------------------------------

/**
 * The real prompt forbids reusing a headline, because naming the event is part
 * of the summarization. A rule engine cannot name anything, so it reuses the
 * representative headline with the outlet suffix trimmed — and the row is
 * tagged `provider = 'mock'` so the brief can say so out loud.
 */
function eventTitle(cluster: Cluster): string {
  const raw = cluster.representative.title.trim();
  const trimmed = raw.replace(/\s*[-–|]\s*[^-–|]{2,30}$/u, "");
  const title = trimmed.length >= 10 ? trimmed : raw;
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function summarize(cluster: Cluster): string {
  const sources = diverseSources(cluster, 3).map((a) => a.source);
  const unique = [...new Set(sources)];
  const parts = [
    `${unique.join(", ")} 등 ${cluster.articles.length}건의 기사가 같은 사건으로 묶였습니다.`,
  ];

  const snippet = firstSentence(cluster.representative.snippet);
  if (snippet) parts.push(`대표 기사 발췌: ${snippet}`);

  return parts.join(" ");
}

function firstSentence(snippet: string): string {
  const clean = snippet.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const cut = clean.search(/[.!?。](\s|$)/);
  const sentence = cut > 0 ? clean.slice(0, cut + 1) : clean;
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

function oneLiner(events: SynthesizedEvent[], assetName: string): string {
  if (events.length === 0) return "";
  const top = events[0]!;
  return `${assetName} 관련 사건 ${events.length}건이 정리되었습니다. 가장 큰 항목은 ${CATEGORY_KO[top.category]}입니다.`;
}

const CATEGORY_KO: Record<Category, string> = {
  earnings: "실적",
  regulation: "규제",
  deal: "계약·투자",
  product: "제품",
  management: "경영진",
  macro: "거시경제",
  other: "기타",
};
