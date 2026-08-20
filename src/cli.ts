#!/usr/bin/env node
import fs from "node:fs";
import { loadConfig, type Config } from "./config.js";
import { openDb } from "./db.js";
import { createLocalEmbedder, type Embedder } from "./pipeline/embed.js";
import { createSynthesizer } from "./pipeline/provider.js";
import { collectAsset } from "./pipeline/run.js";
import { buildBrief, renderBrief } from "./report/brief.js";
import { renderBriefHtml } from "./report/html.js";
import { buildTimeline, renderTimeline } from "./report/timeline.js";
import { markAssetSeen, markVisit, resolveWindow, getAssetSeen } from "./report/window.js";
import { renderCost } from "./report/cost.js";
import {
  buildAssetQuote,
  buildMarket,
  buildPriceHistory,
  collectAssetHistory,
  collectAssetQuotes,
  collectMarket,
  renderMarket,
} from "./report/market.js";
import { buildUpcoming, syncCalendar, renderCalendar } from "./report/calendar.js";
import { parseFeed } from "./sources/rss.js";
import type { RawItem } from "./types.js";

const USAGE = `
mystock — 개인 투자 비서 Phase 0 수집기

기본값은 전부 무료입니다. 뉴스는 RSS, 임베딩은 로컬 모델, 요약은 mock.
돈이 드는 것은 --provider anthropic 하나뿐입니다.

  collect [--asset SYM] [--provider mock|anthropic] [--dry-run] [--fixture FILE]
      뉴스를 수집해 사건으로 정리한다. 작업 스케줄러가 호출할 진입점.
      --provider  mock(기본, 무료) | anthropic(유료, API 키 필요)
      --dry-run   Stage 1~3만 실행. Stage 4 자체를 건너뛴다.
      --fixture   RSS 대신 로컬 XML을 읽는다. 네트워크 없이 검증용.
      --verbose   각 클러스터에 무엇이 묶였는지 출력. 임계값 튜닝용.

  brief [--window last|24h|7d|30d] [--min-importance N] [--html [FILE]] [--no-mark]
      DB에 쌓인 사건을 사람이 읽을 형태로 출력한다.
      --window    기본은 last — 마지막으로 본 시점 이후를 자동으로 잡는다.
      --html      터미널 대신 HTML 파일로 쓴다 (기본 brief.html). 브라우저로 연다.
                  자산별 사건 기록장도 같은 파일에 함께 들어간다.
      --record-days N  HTML에 함께 넣을 기록장 기간 (기본 30).
      --no-mark   방문 기록을 남기지 않는다 (같은 구간을 다시 보고 싶을 때).

  market [--show]
      지수·환율·암호화폐 시세를 받아 저장한다. 무료, 키 불필요.
      --show      받지 않고 저장된 값만 출력한다.

  calendar [--show] [--days N]
      mystock.config.json의 calendarEvents(실적·CPI·FOMC 등 전부 수동 입력)를
      DB에 동기화한다. 네트워크를 쓰지 않는다 — 자동 수집 시도는 §0.7b 참고.
      --show      동기화하지 않고 앞으로 N일(기본 7) 이내 일정만 출력한다.

  timeline [--asset SYM] [--days N]
      사건 기록장. 한 자산의 사건을 날짜순으로 전부 본다.
      브리핑과 달리 중요도 하한이 없고 종료된 사건도 포함한다.

  mark-seen --asset SYM
      관심자산 뱃지를 지운다. Electron 설정 화면이 내부적으로 호출하는 명령 —
      직접 쓸 일은 거의 없다.

  cost [--days N]
      누적 토큰/비용 리포트. mock 실행은 $0으로 기록된다.

  compare --model a,b [--fixture FILE] [--asset SYM]
      같은 입력으로 두 모델을 비교한다. ※ 유료 API를 사용합니다.

공통: --config PATH  --db PATH
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const flags = parseFlags(argv.slice(1));

  if (!command || command === "help" || flags.help) {
    console.log(USAGE);
    return;
  }

  const config = applyOverrides(loadConfig(flags.config ?? "mystock.config.json"), flags);

  switch (command) {
    case "collect":
      await cmdCollect(config, flags);
      break;
    case "brief":
      cmdBrief(config, flags);
      break;
    case "timeline":
      cmdTimeline(config, flags);
      break;
    case "mark-seen":
      cmdMarkSeen(config, flags);
      break;
    case "market":
      await cmdMarket(config, flags);
      break;
    case "calendar":
      cmdCalendar(config, flags);
      break;
    case "cost":
      cmdCost(config, flags);
      break;
    case "compare":
      await cmdCompare(config, flags);
      break;
    default:
      console.error(`알 수 없는 명령: ${command}`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

// --- commands ----------------------------------------------------------------

async function cmdCollect(config: Config, flags: Flags): Promise<void> {
  const db = openDb(config.dbPath);
  const symbols = targetSymbols(config, flags);
  const dryRun = Boolean(flags["dry-run"]);
  const embedder = await getEmbedder(config);
  const items = flags.fixture ? readFixture(flags.fixture) : undefined;

  if (!dryRun && config.aiProvider === "anthropic") {
    console.log("※ 유료 모드(anthropic)로 실행합니다. 무료로 돌리려면 --provider mock");
  }

  let failures = 0;
  for (const symbol of symbols) {
    console.log(`\n▸ ${symbol}`);
    try {
      const stats = await collectAsset(db, symbol, {
        config,
        embedder,
        skipLlm: dryRun,
        itemsOverride: items,
        verbose: Boolean(flags.verbose),
        model: flags.model,
        onLog: (line) => console.log(`  ${line}`),
      });
      if (stats.provider === "anthropic") console.log(`  비용 $${stats.costUsd.toFixed(4)}`);
    } catch (err) {
      failures++;
      console.error(`  실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  db.close();
  if (failures > 0) process.exitCode = 1;
}

function cmdBrief(config: Config, flags: Flags): void {
  const db = openDb(config.dbPath);
  const win = resolveWindow(db, flags.window);
  const minImportance = flags["min-importance"] ? Number(flags["min-importance"]) : 40;
  const briefs = buildBrief(db, config, win.days, minImportance);

  // The record covers a fixed span rather than the visit window: it exists to
  // look back further than the brief, so shrinking it to "since you last
  // looked" would defeat it.
  const recordDays = flags["record-days"] ? Number(flags["record-days"]) : 30;
  const html = flags.html !== undefined;
  const timelines = html ? config.assets.map((a) => buildTimeline(db, a, recordDays)) : [];
  const market = html ? buildMarket(db, config) : [];
  const upcoming = html ? buildUpcoming(db, 7) : undefined;
  const assetQuotes = html
    ? new Map(config.assets.map((a) => [a.symbol, buildAssetQuote(db, a.symbol)]))
    : undefined;
  const priceHistory = html
    ? new Map(config.assets.map((a) => [a.symbol, buildPriceHistory(db, a.symbol)]))
    : undefined;
  const assetSeenAt = html
    ? new Map(config.assets.map((a) => [a.symbol, getAssetSeen(db, a.symbol)]))
    : undefined;

  // Reading the brief is the visit. Recorded after building it, so the window
  // just shown is the one that gets closed off.
  if (!flags["no-mark"]) markVisit(db);
  db.close();

  const label = win.sinceLastVisit ? `${win.label} (마지막 방문 이후)` : win.label;

  if (flags.html === undefined) {
    console.log(renderBrief(briefs, label));
    return;
  }

  // `--html` with no path still parses as the string "true".
  const out = flags.html === "true" ? "brief.html" : flags.html;
  fs.writeFileSync(
    out,
    renderBriefHtml(briefs, {
      windowLabel: label,
      generatedAt: new Date(),
      timelines,
      market,
      upcoming,
      assetQuotes,
      priceHistory,
      allInstruments: html ? config.market : undefined,
      assetSeenAt,
    }),
  );
  console.log(`${out} 를 만들었습니다. 브라우저로 여세요:\n  start ${out}`);
}

/**
 * Marks an asset's 관심자산 badge cleared. The one command electron/main.js's
 * IPC handler shells out to for this — the DB is off-limits to the Electron
 * process directly (same reasoning as regenerate()'s node:sqlite comment).
 */
function cmdMarkSeen(config: Config, flags: Flags): void {
  const symbol = flags.asset?.toUpperCase();
  if (!symbol) {
    console.error("--asset SYM 으로 지정하세요.");
    process.exitCode = 1;
    return;
  }
  const db = openDb(config.dbPath);
  markAssetSeen(db, symbol);
  db.close();
  console.log(`${symbol} 읽음으로 표시했습니다.`);
}

function cmdTimeline(config: Config, flags: Flags): void {
  const symbol = (flags.asset ?? config.assets[0]?.symbol)?.toUpperCase();
  const asset = config.assets.find((a) => a.symbol.toUpperCase() === symbol);
  if (!asset) {
    console.error("자산을 찾을 수 없습니다. --asset SYM 으로 지정하세요.");
    process.exitCode = 1;
    return;
  }

  const db = openDb(config.dbPath);
  const days = flags.days ? Number(flags.days) : 30;
  console.log(renderTimeline(buildTimeline(db, asset, days)));
  db.close();
}

async function cmdMarket(config: Config, flags: Flags): Promise<void> {
  const db = openDb(config.dbPath);

  if (!flags.show) {
    const log = (l: string) => console.log(l);
    const dashboard = await collectMarket(db, config, { onLog: log });
    // Watchlist assets' own prices (e.g. NVDA) — same collector, kept out of
    // the 6x2 dashboard grid, used on the per-asset detail page instead.
    const assets = await collectAssetQuotes(db, config, { onLog: log });
    // Daily closes for that same page's "주가 추이" chart.
    const history = await collectAssetHistory(db, config, { onLog: log });
    const ok = dashboard.ok + assets.ok + history.ok;
    const failed = dashboard.failed.length + assets.failed.length + history.failed.length;
    console.log(`\n${ok}건 수집` + (failed > 0 ? `, ${failed}건 실패` : ""));
    if (ok === 0 && failed > 0) process.exitCode = 1;
  }

  console.log(renderMarket(buildMarket(db, config)));
  db.close();
}

function cmdCalendar(config: Config, flags: Flags): void {
  const db = openDb(config.dbPath);

  if (!flags.show) {
    const stats = syncCalendar(db, config);
    console.log(`${stats.synced}건 동기화`);
  }

  const days = flags.days ? Number(flags.days) : 7;
  console.log(renderCalendar(buildUpcoming(db, days)));
  db.close();
}

function cmdCost(config: Config, flags: Flags): void {
  const db = openDb(config.dbPath);
  const days = flags.days ? Number(flags.days) : 30;
  console.log(renderCost(db, days, config.assets.length));
  db.close();
}

/**
 * Runs the same collected input through two models so the Phase 0 budget
 * decision is made on evidence rather than on the price table.
 *
 * Always uses the paid backend — comparing mock against mock says nothing.
 */
async function cmdCompare(config: Config, flags: Flags): Promise<void> {
  const models = (flags.model ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length < 2) {
    console.error("compare에는 --model a,b 형식으로 모델 2개 이상이 필요합니다.");
    process.exitCode = 1;
    return;
  }

  console.log("※ compare는 유료 Anthropic API를 호출합니다.");

  const symbol = flags.asset ?? config.assets[0]?.symbol;
  if (!symbol) {
    console.error("비교할 자산이 없습니다.");
    process.exitCode = 1;
    return;
  }

  const embedder = await getEmbedder(config);
  const items = flags.fixture ? readFixture(flags.fixture) : undefined;

  for (const model of models) {
    // Each model gets its own scratch DB so neither sees the other's events.
    const dbPath = `${config.dbPath}.compare-${model.replace(/[^a-z0-9]/gi, "_")}`;
    fs.rmSync(dbPath, { force: true });
    const db = openDb(dbPath);

    console.log(`\n${"=".repeat(60)}\n  ${model}\n${"=".repeat(60)}`);
    try {
      const stats = await collectAsset(db, symbol, {
        config, embedder, itemsOverride: items, model,
        synthesizer: createSynthesizer("anthropic", { model }),
        onLog: (line) => console.log(`  ${line}`),
      });
      console.log(renderBrief(buildBrief(db, config, config.maxArticleAgeDays), `${config.maxArticleAgeDays}일`));
      console.log(`  비용 $${stats.costUsd.toFixed(4)}`);
    } catch (err) {
      console.error(`  실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    db.close();
  }
}

// --- helpers -----------------------------------------------------------------

async function getEmbedder(config: Config): Promise<Embedder> {
  try {
    return await createLocalEmbedder(config.embeddingModel);
  } catch (err) {
    throw new Error(
      `임베딩 모델을 불러오지 못했습니다 (${config.embeddingModel}).\n` +
        `첫 실행에는 모델 다운로드를 위해 네트워크가 필요합니다.\n` +
        `원인: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readFixture(path: string): RawItem[] {
  const items = parseFeed(fs.readFileSync(path, "utf8"), "fixture");
  if (items.length === 0) throw new Error(`픽스처에서 기사를 찾지 못했습니다: ${path}`);
  return items;
}

function targetSymbols(config: Config, flags: Flags): string[] {
  if (!flags.asset) return config.assets.map((a) => a.symbol);
  const wanted = flags.asset.split(",").map((s) => s.trim().toUpperCase());
  const known = new Set(config.assets.map((a) => a.symbol.toUpperCase()));
  for (const s of wanted) {
    if (!known.has(s)) throw new Error(`설정에 없는 자산입니다: ${s}`);
  }
  return wanted;
}

function applyOverrides(config: Config, flags: Flags): Config {
  let out = config;
  if (flags.db) out = { ...out, dbPath: flags.db };
  if (flags.provider) {
    if (flags.provider !== "mock" && flags.provider !== "anthropic") {
      throw new Error(`--provider는 mock 또는 anthropic이어야 합니다: ${flags.provider}`);
    }
    out = { ...out, aiProvider: flags.provider };
  }
  return out;
}

type Flags = Record<string, string | undefined> & { help?: string };

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = "true";
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
