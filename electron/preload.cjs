const { contextBridge, ipcRenderer } = require("electron");

// CommonJS on purpose, regardless of the project's "type": "module" — Electron's
// preload sandboxing has been most reliably tested with CommonJS, and the .cjs
// extension forces that reading no matter what package.json says.
//
// The renderer runs with contextIsolation on and nodeIntegration off (main.js),
// so this is the only door between the static page's JS and the filesystem —
// two narrow, named actions, not a general IPC passthrough.
contextBridge.exposeInMainWorld("mystock", {
  toggleInstrument: (id) => ipcRenderer.invoke("toggle-instrument", id),
  addAsset: (symbol, name) => ipcRenderer.invoke("add-asset", { symbol, name }),
});
