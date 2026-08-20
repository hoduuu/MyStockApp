import assert from "node:assert/strict";
import test from "node:test";
import { addAsset, toggleInstrument } from "../src/config-edit.js";
import { DEFAULT_MARKET } from "../src/config.js";
import type { Config } from "../src/config.js";

// --- toggleInstrument ----------------------------------------------------------

test("toggling flips enabled and leaves everything else untouched", () => {
  const raw: Partial<Config> = {
    market: [
      { id: "dow", name: "다우", symbol: "^DJI", slot: "index", icon: "us", enabled: true },
      { id: "gold", name: "금", symbol: "GC=F", slot: "pair", icon: "gold", enabled: false },
    ],
    assets: [{ symbol: "NVDA", name: "엔비디아", aliases: [] }],
  };
  const out = toggleInstrument(raw, "dow");
  assert.equal((out.market as any[])[0].enabled, false);
  assert.equal((out.market as any[])[1].enabled, false); // untouched
  assert.deepEqual(out.assets, raw.assets); // untouched sibling field survives
});

test("an unknown instrument id is rejected rather than silently ignored", () => {
  assert.throws(() => toggleInstrument({ market: DEFAULT_MARKET }, "not-a-real-id"), /알 수 없는/);
});

/**
 * A config file that never overrode market[] (relying on the app's own
 * defaults at read time) doesn't have an array to find an instrument in —
 * toggling has to seed one first, or every instrument but the one clicked
 * would silently vanish from the file.
 */
test("a config with no market[] override is seeded from the app defaults before toggling", () => {
  const out = toggleInstrument({}, "dow");
  const market = out.market as { id: string; enabled: boolean }[];
  assert.equal(market.length, DEFAULT_MARKET.length);
  assert.equal(market.find((m) => m.id === "dow")!.enabled, false); // was true in defaults
  assert.equal(market.find((m) => m.id === "nasdaq")!.enabled, true); // untouched default survives
});

test("toggling does not mutate the input object", () => {
  const raw: Partial<Config> = {
    market: [{ id: "dow", name: "다우", symbol: "^DJI", slot: "index", icon: "us", enabled: true }],
  };
  const before = JSON.stringify(raw);
  toggleInstrument(raw, "dow");
  assert.equal(JSON.stringify(raw), before);
});

// --- addAsset --------------------------------------------------------------------

test("a new asset is appended with a trimmed, uppercased symbol", () => {
  const out = addAsset({ assets: [] }, "  nvda ", "  엔비디아 ");
  assert.deepEqual(out.assets, [{ symbol: "NVDA", name: "엔비디아", aliases: [] }]);
});

test("adding to a config with no assets[] yet starts a fresh list", () => {
  const out = addAsset({}, "nvda", "엔비디아");
  assert.deepEqual(out.assets, [{ symbol: "NVDA", name: "엔비디아", aliases: [] }]);
});

test("a duplicate symbol is rejected", () => {
  const raw: Partial<Config> = { assets: [{ symbol: "NVDA", name: "엔비디아", aliases: [] }] };
  assert.throws(() => addAsset(raw, "nvda", "엔비디아 둘째"), /이미 등록된/);
});

test("an empty symbol or name is rejected rather than silently added", () => {
  assert.throws(() => addAsset({ assets: [] }, "   ", "엔비디아"), /종목 코드/);
  assert.throws(() => addAsset({ assets: [] }, "NVDA", "   "), /이름/);
});

test("existing assets are preserved, in order, when a new one is added", () => {
  const raw: Partial<Config> = {
    assets: [
      { symbol: "NVDA", name: "엔비디아", aliases: ["Nvidia"] },
      { symbol: "DELL", name: "델", aliases: [] },
    ],
  };
  const out = addAsset(raw, "amd", "AMD");
  assert.deepEqual(out.assets, [
    { symbol: "NVDA", name: "엔비디아", aliases: ["Nvidia"] },
    { symbol: "DELL", name: "델", aliases: [] },
    { symbol: "AMD", name: "AMD", aliases: [] },
  ]);
});
