import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildAssetQuote, buildMarket, buildPriceHistory, renderMarket, storeQuote } from "../src/report/market.js";
import { parseHistory, parseQuote, parseSymbolSearch } from "../src/sources/market.js";
import type { Instrument } from "../src/types.js";

const NOW = new Date("2026-08-19T18:00:00Z");

const DOW: Instrument = { id: "dow", name: "다우", symbol: "^DJI", slot: "index", icon: "us", enabled: true };
const KOSPI: Instrument = { id: "kospi", name: "코스피", symbol: "^KS11", slot: "index", icon: "kr", enabled: true };
const USDKRW: Instrument = { id: "usdkrw", name: "원/달러", symbol: "KRW=X", slot: "pair", icon: "us", enabled: true };

const fixture = (n: string) => fs.readFileSync(`fixtures/yahoo-quote-${n}.json`, "utf8");

function config(market: Instrument[]): Config {
  return { ...DEFAULT_CONFIG, market };
}

// --- parsing -----------------------------------------------------------------

test("a quote is read from the chart meta", () => {
  const q = parseQuote(DOW, fixture("dji"));
  assert.equal(q.price, 53343.4);
  assert.equal(q.previousClose, 53227.02);
  assert.equal(q.currency, "USD");
  assert.equal(q.instrumentId, "dow");
  assert.equal(q.ts, new Date(1787245200 * 1000).toISOString());
});

/**
 * Yahoo answers a bad symbol with HTTP 200 and an error object. Left
 * unchecked, a typo in the config would show up only as a tile that never
 * appears — the slowest possible way to find a one-character mistake.
 */
test("an error payload raises rather than returning nothing", () => {
  assert.throws(() => parseQuote(DOW, fixture("error")), /delisted/);
});

test("a missing previous close is a missing field, not a failure", () => {
  const q = parseQuote(KOSPI, fixture("nopc"));
  assert.equal(q.price, 2612.44);
  assert.equal(q.previousClose, null);
});

/**
 * Real bug, observed on KOSPI/KOSDAQ: meta.previousClose can be off by a
 * trading day for exchanges outside the US session, while the daily close
 * series it's derived from is correct. The series must win.
 */
test("previous close comes from the daily close series, not meta, when they disagree", () => {
  const q = parseQuote(KOSPI, fixture("kospi-mismatch"));
  assert.equal(q.price, 6788.74);
  assert.equal(q.previousClose, 6414.74);
});

test("a response without a price is rejected", () => {
  assert.throws(() => parseQuote(DOW, '{"chart":{"result":[{"meta":{}}],"error":null}}'), /가격/);
});

test("malformed JSON does not pass silently", () => {
  assert.throws(() => parseQuote(DOW, "not json"));
});

// --- storage and reporting ---------------------------------------------------

test("change and percentage come from the stored figures", () => {
  const db = openDb(":memory:");
  storeQuote(db, parseQuote(DOW, fixture("dji")), NOW);

  const [row] = buildMarket(db, config([DOW]), undefined, NOW);
  assert.ok(row);
  assert.equal(row.price, 53343.4);
  assert.ok(Math.abs(row.change! - 116.38) < 0.001);
  assert.ok(Math.abs(row.changePct! - 0.2186) < 0.001);
  db.close();
});

test("no previous close means no change, not a change of zero", () => {
  const db = openDb(":memory:");
  storeQuote(db, parseQuote(KOSPI, fixture("nopc")), NOW);

  const [row] = buildMarket(db, config([KOSPI]), undefined, NOW);
  assert.equal(row!.change, null);
  assert.equal(row!.changePct, null);
  db.close();
});

/**
 * A tile reading 0.00 would be a claim about the market. Absence is not.
 */
test("an instrument never collected is left out rather than shown as zero", () => {
  const db = openDb(":memory:");
  assert.deepEqual(buildMarket(db, config([DOW]), undefined, NOW), []);
  assert.match(renderMarket([]), /시장 데이터가 없습니다/);
  db.close();
});

test("disabled instruments are not shown", () => {
  const db = openDb(":memory:");
  storeQuote(db, parseQuote(DOW, fixture("dji")), NOW);

  const rows = buildMarket(db, config([{ ...DOW, enabled: false }]), undefined, NOW);
  assert.equal(rows.length, 0);
  db.close();
});

test("slots can be requested separately", () => {
  const db = openDb(":memory:");
  storeQuote(db, parseQuote(DOW, fixture("dji")), NOW);
  storeQuote(db, { ...parseQuote(DOW, fixture("dji")), instrumentId: "usdkrw" }, NOW);

  const cfg = config([DOW, USDKRW]);
  assert.deepEqual(buildMarket(db, cfg, "index", NOW).map((r) => r.instrument.id), ["dow"]);
  assert.deepEqual(buildMarket(db, cfg, "pair", NOW).map((r) => r.instrument.id), ["usdkrw"]);
  db.close();
});

test("config order is display order", () => {
  const db = openDb(":memory:");
  for (const id of ["dow", "kospi", "usdkrw"]) {
    storeQuote(db, { ...parseQuote(DOW, fixture("dji")), instrumentId: id }, NOW);
  }
  const rows = buildMarket(db, config([KOSPI, USDKRW, DOW]), undefined, NOW);
  assert.deepEqual(rows.map((r) => r.instrument.id), ["kospi", "usdkrw", "dow"]);
  db.close();
});

test("the newest point wins and re-fetching the same timestamp updates it", () => {
  const db = openDb(":memory:");
  const q = parseQuote(DOW, fixture("dji"));
  storeQuote(db, q, NOW);
  storeQuote(db, { ...q, price: 53400 }, NOW);
  storeQuote(db, { ...q, ts: "2026-08-18T20:00:00Z", price: 1 }, NOW);

  const [row] = buildMarket(db, config([DOW]), undefined, NOW);
  assert.equal(row!.price, 53400);
  db.close();
});

test("a figure older than a day is flagged stale", () => {
  const db = openDb(":memory:");
  storeQuote(db, { ...parseQuote(DOW, fixture("dji")), ts: "2026-08-15T09:00:00Z" }, NOW);

  const [row] = buildMarket(db, config([DOW]), undefined, NOW);
  assert.equal(row!.stale, true);
  assert.match(renderMarket([row!]), /오래됨/);
  db.close();
});

test("the rendering marks direction without relying on colour", () => {
  const db = openDb(":memory:");
  storeQuote(db, parseQuote(DOW, fixture("dji")), NOW);
  const out = renderMarket(buildMarket(db, config([DOW]), undefined, NOW));
  assert.match(out, /▲/);
  assert.match(out, /다우/);
  db.close();
});

// --- asset quotes (a watchlist ticker's own price) ----------------------------

/**
 * A watchlist ticker's price is stored under its own symbol in the same
 * market_points table used for dashboard instruments — buildAssetQuote reads
 * it by that symbol directly, with no Instrument/config.market involved.
 */
test("an asset's own quote is read back by its ticker", () => {
  const db = openDb(":memory:");
  storeQuote(db, { ...parseQuote(DOW, fixture("dji")), instrumentId: "NVDA" }, NOW);

  const q = buildAssetQuote(db, "NVDA", NOW);
  assert.ok(q);
  assert.equal(q!.price, 53343.4);
  assert.ok(Math.abs(q!.change! - 116.38) < 0.001);
  db.close();
});

test("a never-collected asset quote is null, not a zero", () => {
  const db = openDb(":memory:");
  assert.equal(buildAssetQuote(db, "NVDA", NOW), null);
  db.close();
});

// --- price history (주가 추이 chart) --------------------------------------------

/** A holiday's bar carries a real timestamp but a null close; it's dropped, not zero-filled. */
test("history is parsed as ascending date/close pairs, nulls dropped", () => {
  const body = fs.readFileSync("fixtures/yahoo-history-nvda.json", "utf8");
  const points = parseHistory(body);
  assert.deepEqual(
    points.map((p) => p.date),
    ["2025-08-19", "2025-08-20", "2025-08-22", "2025-08-23"],
  );
  assert.equal(points.length, 4);
  assert.equal(points[3]!.close, 187.32);
});

test("price history round-trips through storage in ascending date order", () => {
  const db = openDb(":memory:");
  const body = fs.readFileSync("fixtures/yahoo-history-nvda.json", "utf8");
  const points = parseHistory(body);

  const stmt = db.prepare("INSERT INTO price_history (symbol, date, close) VALUES (?, ?, ?)");
  // Insert out of order to prove the read side sorts, not the write side.
  for (const p of [...points].reverse()) stmt.run("NVDA", p.date, p.close);

  const rows = buildPriceHistory(db, "NVDA");
  assert.deepEqual(rows.map((r) => r.date), points.map((p) => p.date));
  db.close();
});

test("an asset with no history yet returns an empty array", () => {
  const db = openDb(":memory:");
  assert.deepEqual(buildPriceHistory(db, "NVDA"), []);
  db.close();
});

// --- asset name lookup (관심자산 추가 form) --------------------------------------

test("longName is preferred when the chart response has one", () => {
  assert.equal(parseQuote(DOW, fixture("longname")).name, "NVIDIA Corporation");
});

test("shortName is used when there's no longName", () => {
  const body = fixture("longname").replace('"longName": "NVIDIA Corporation",', "");
  assert.equal(parseQuote(DOW, body).name, "NVIDIA Corp");
});

test("neither name field present returns null, not a guess", () => {
  assert.equal(parseQuote(DOW, fixture("dji")).name, null);
});

// --- symbol search (관심자산 추가 form's autocomplete) ---------------------------

test("search results are read as symbol/name pairs, longname preferred", () => {
  const body = fs.readFileSync("fixtures/yahoo-search-q.json", "utf8");
  const results = parseSymbolSearch(body);
  assert.deepEqual(results, [
    { symbol: "QQQ", name: "Invesco QQQ Trust Series 1" },
    { symbol: "QLD", name: "ProShares Ultra QQQ" },
    { symbol: "QQQX", name: null },
  ]);
});

test("a search response with no quotes array returns no suggestions", () => {
  assert.deepEqual(parseSymbolSearch('{"news":[]}'), []);
});
