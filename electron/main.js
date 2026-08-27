import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addAsset, removeAsset, reorderAssets, toggleInstrument } from "../dist/src/config-edit.js";
import { fetchQuote, searchSymbols } from "../dist/src/sources/market.js";

/**
 * The window this app has instead of a UI framework, for now.
 *
 * Electron bundles its own Node build, and `node:sqlite` (what db.ts uses) is
 * young enough that whether a given Electron release carries a Node new
 * enough to have it is not something this offline environment can check.
 * Importing db.ts into the Electron main process would make that guess load-
 * bearing.
 *
 * So this process never touches the database. It shells out to the system
 * `node` — the same binary `npm run mystock` already runs successfully — to
 * regenerate brief.html via the existing CLI, then just displays that file.
 * Electron's job here is display and refresh, nothing more. Once this is
 * confirmed working, the CLI's report-building pieces can move into a proper
 * React UI; this step only replaces the browser tab with an app window.
 *
 * config-edit.js and sources/market.js are safe to import directly (unlike
 * db.js) — plain objects and a plain fetch() call, nothing that depends on
 * this Electron build's Node version.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const briefPath = path.join(projectRoot, "brief.html");
const cliPath = path.join(projectRoot, "dist", "src", "cli.js");
const configPath = path.join(projectRoot, "mystock.config.json");

let win;

/** Every DB-touching operation goes through the system `node` running this CLI — see the file header. */
function runCli(args) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(cliPath)) {
      reject(new Error(`빌드가 안 되어 있습니다: ${cliPath}\n먼저 "npm run build" 를 실행하세요.`));
      return;
    }
    execFile("node", [cliPath, ...args], { cwd: projectRoot }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

function regenerate() {
  return runCli(["brief", "--html", briefPath]);
}

/** The URL's fragment, if any — so a refresh triggered from a sub-page (e.g. 설정) lands back there. */
function currentHash() {
  const url = win?.webContents.getURL();
  if (!url) return "";
  const i = url.indexOf("#");
  return i === -1 ? "" : url.slice(i + 1);
}

async function refresh(hash = currentHash()) {
  try {
    await regenerate();
    await win.loadFile(briefPath, hash ? { hash } : {});
  } catch (err) {
    dialog.showErrorBox("새로고침 실패", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Read/write mystock.config.json directly — the one config-mutating path in
 * this app. Every other command (collect/market/calendar/brief) only reads
 * it. A missing file is refused rather than silently seeded: this app never
 * invents a config a user didn't write (docs/DESIGN.md §1's "모르는 것은 모른다고
 * 한다" applied to settings, not just news).
 */
function readConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`mystock.config.json이 없습니다: ${configPath}\n먼저 설정 파일을 만들어주세요.`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function writeConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
}

ipcMain.handle("toggle-instrument", async (_event, id) => {
  writeConfig(toggleInstrument(readConfig(), id));
  await refresh();
});

// Just a ticker, not a ticker + a display name — the name gets looked up from
// the same Yahoo endpoint quotes already come from. fetchQuote both looks up
// the name AND validates the symbol exists (it throws on a missing price or
// Yahoo's own "no such symbol" error) — a typo like "QQ" is rejected instead
// of silently added under its own ticker as a fake name.
ipcMain.handle("add-asset", async (_event, symbolInput) => {
  const symbol = String(symbolInput ?? "").trim().toUpperCase();
  if (!symbol) throw new Error("종목 코드를 입력하세요.");
  let quote;
  try {
    quote = await fetchQuote({ id: symbol, name: symbol, symbol, slot: "index", icon: "us", enabled: true });
  } catch {
    throw new Error(`존재하지 않는 종목 코드입니다: ${symbol}`);
  }
  writeConfig(addAsset(readConfig(), symbol, quote.name ?? symbol));
  await refresh();
});

// Autocomplete for the add-asset field — a lookup failure just means no
// suggestions this keystroke, not an error the user needs to see.
ipcMain.handle("search-symbol", async (_event, query) => {
  const q = String(query ?? "").trim();
  if (!q) return [];
  try {
    return await searchSymbols(q);
  } catch {
    return [];
  }
});

ipcMain.handle("remove-asset", async (_event, symbol) => {
  writeConfig(removeAsset(readConfig(), String(symbol ?? "")));
  await refresh();
});

ipcMain.handle("reorder-assets", async (_event, order) => {
  const symbols = Array.isArray(order) ? order.map(String) : [];
  writeConfig(reorderAssets(readConfig(), symbols));
  await refresh();
});

// asset_seen lives in mystock.db, not config.json — this one goes through
// the CLI (mark-seen) rather than writeConfig, same reasoning as regenerate().
ipcMain.handle("mark-seen", async (_event, symbol) => {
  await runCli(["mark-seen", "--asset", String(symbol ?? "")]);
  await refresh();
});

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 480,
    height: 860,
    title: "투자 비서",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "보기",
        submenu: [
          { label: "새로고침 (수집·시세 갱신)", accelerator: "CmdOrCtrl+R", click: () => refresh() },
        ],
      },
      { label: "종료", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
    ]),
  );

  // Existing brief.html shows immediately if there is one, then a fresh copy
  // regenerates behind it — the window is never empty while waiting.
  if (fs.existsSync(briefPath)) {
    await win.loadFile(briefPath);
    refresh();
  } else {
    await refresh();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
