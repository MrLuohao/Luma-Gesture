const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopShell", {
  close: () => ipcRenderer.invoke("desktop-close"),
  toggleClickThrough: () => ipcRenderer.invoke("desktop-toggle-click-through"),
  onInteractionMode: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("desktop-interaction-mode", (_event, enabled) => callback(Boolean(enabled)));
  },
  onStartHands: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("desktop-start-hands", callback);
  }
});
