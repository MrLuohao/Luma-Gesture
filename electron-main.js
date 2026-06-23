const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow, Menu, globalShortcut, ipcMain, screen, session } = require("electron");
const { port, startServer } = require("./server");

const appUrl = `http://127.0.0.1:${port}/?desktop=1`;
let mainWindow = null;
let managedServer = null;
let interactionMode = false;

function setInteractionMode(enabled) {
  if (!mainWindow) return false;
  interactionMode = Boolean(enabled);
  mainWindow.setIgnoreMouseEvents(!interactionMode, { forward: true });
  mainWindow.webContents.send("desktop-interaction-mode", interactionMode);
  return interactionMode;
}

function canReachLocalServer() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureServer() {
  if (await canReachLocalServer()) return;
  managedServer = await startServer("127.0.0.1", port);
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 720,
    minHeight: 420,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    fullscreenable: false,
    resizable: true,
    movable: true,
    show: false,
    alwaysOnTop: true,
    title: "Gesture Field Desktop",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "electron-preload.js"),
      backgroundThrottling: false
    }
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadURL(appUrl);
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    setInteractionMode(false);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+T", () => {
    setInteractionMode(!interactionMode);
  });

  globalShortcut.register("CommandOrControl+Shift+H", () => {
    if (!mainWindow) return;
    mainWindow.webContents.send("desktop-start-hands");
  });

  globalShortcut.register("CommandOrControl+Shift+Q", () => {
    app.quit();
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  ipcMain.handle("desktop-close", () => {
    app.quit();
  });
  ipcMain.handle("desktop-toggle-click-through", () => {
    return setInteractionMode(!interactionMode);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === "media";
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  session.defaultSession.setDevicePermissionHandler((details) => {
    return details.deviceType === "media";
  });
  await ensureServer();
  createWindow();
  registerShortcuts();
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (managedServer?.listening) {
    managedServer.close();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
