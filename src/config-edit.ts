import { DEFAULT_MARKET } from "./config.js";
import type { Config } from "./config.js";

/**
 * Pure mutations for the one config-writing path in this app (electron/
 * main.js's IPC handlers). Kept here rather than in main.js because main.js
 * cannot be unit tested the way everything else in src/ is — Electron's
 * shell always stays a thin wrapper (docs: "Electron's job here is display
 * and refresh, nothing more"), and that now covers config edits too.
 *
 * These operate on the raw parsed JSON, not the merged Config `loadConfig()`
 * produces — a config file that never overrode `market` doesn't have an
 * array to find an instrument in, hence the DEFAULT_MARKET seed.
 */

export function toggleInstrument(raw: Partial<Config>, id: string): Partial<Config> {
  const market = Array.isArray(raw.market) ? structuredClone(raw.market) : structuredClone(DEFAULT_MARKET);
  const inst = market.find((m) => m.id === id);
  if (!inst) throw new Error(`알 수 없는 시장 항목입니다: ${id}`);
  inst.enabled = !inst.enabled;
  return { ...raw, market };
}

export function addAsset(raw: Partial<Config>, symbolInput: string, nameInput: string): Partial<Config> {
  const symbol = symbolInput.trim().toUpperCase();
  const name = nameInput.trim();
  if (!symbol) throw new Error("종목 코드를 입력하세요.");
  if (!name) throw new Error("이름을 입력하세요.");

  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  if (assets.some((a) => a.symbol === symbol)) {
    throw new Error(`이미 등록된 종목입니다: ${symbol}`);
  }

  return { ...raw, assets: [...assets, { symbol, name, aliases: [] }] };
}
