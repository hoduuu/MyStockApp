import { app, BrowserWindow, Menu, dialog } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const briefPath = path.join(projectRoot, "brief.html");
const cliPath = path.join(projectRoot, "dist", "src", "cli.js");

function regenerate() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(cliPath)) {
      reject(new Error(`빌드가 안 되어 있습니다: ${cliPath}\n먼저 "npm run build" 를 실행하세요.`));
      return;
    }
    execFile(
      "node",
      [cliPath, "brief", "--html", briefPath],
      { cwd: projectRoot },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      },
    );
  });
}

async function refresh(win) {
  try {
    await regenerate();
    await win.loadFile(briefPath);
  } catch (err) {
    dialog.showErrorBox("새로고침 실패", err instanceof Error ? err.message : String(err));
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 480,
    height: 860,
    title: "투자 비서",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "보기",
        submenu: [
          { label: "새로고침 (수집·시세 갱신)", accelerator: "CmdOrCtrl+R", click: () => refresh(win) },
        ],
      },
      { label: "종료", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
    ]),
  );

  // Existing brief.html shows immediately if there is one, then a fresh copy
  // regenerates behind it — the window is never empty while waiting.
  if (fs.existsSync(briefPath)) {
    await win.loadFile(briefPath);
    refresh(win);
  } else {
    await refresh(win);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
