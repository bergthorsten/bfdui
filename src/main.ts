import path from "node:path";
import { app, BrowserWindow } from "electron";
import { type IpcMainEvent, ipcMain } from "electron/main";
import {
  installExtension,
  REACT_DEVELOPER_TOOLS,
} from "electron-devtools-installer";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";
import { ipcContext } from "@/ipc/context";
import { startMcpServer, stopMcpServer } from "@/services/mcp";
import { IPC_CHANNELS, inDevelopment } from "./constants";
import { getBasePath } from "./utils/path";

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

const WINDOW_HEIGHT = 860;
const WINDOW_MIN_HEIGHT = 720;
const WINDOW_MAX_HEIGHT = 1600;

function createWindow() {
  const basePath = getBasePath();
  const preload = path.join(basePath, "preload.js");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: WINDOW_HEIGHT,
    icon: process.platform === "darwin" ? undefined : appIconPath(),
    minWidth: 1200,
    minHeight: WINDOW_MIN_HEIGHT,
    maxHeight: WINDOW_MAX_HEIGHT,
    webPreferences: {
      devTools: inDevelopment,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,

      preload,
    },
    titleBarStyle: "hidden",
    trafficLightPosition:
      process.platform === "darwin" ? { x: 16, y: 18 } : undefined,
  });

  mainWindow.setMinimumSize(1200, WINDOW_MIN_HEIGHT);

  mainWindow.on("close", (event) => {
    if (process.platform !== "darwin" || isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, code, description, url) => {
      console.error("Renderer failed to load:", { code, description, url });
    }
  );
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process gone:", details);
  });
  mainWindow.webContents.on("unresponsive", () => {
    console.error("Renderer became unresponsive.");
  });
  mainWindow.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) {
      console.error("Renderer console:", message);
    }
  });

  ipcContext.setMainWindow(mainWindow);
}

function appIconPath(): string {
  return path.join(app.getAppPath(), "assets", "icon.png");
}

function loadMainWindow() {
  if (!mainWindow) {
    throw new Error("Main window has not been created.");
  }

  const basePath = getBasePath();
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(basePath, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
}

async function installExtensions() {
  try {
    const result = await installExtension(REACT_DEVELOPER_TOOLS);
    console.log(`Extensions installed successfully: ${result.name}`);
  } catch {
    console.error("Failed to install extensions");
  }
}

function checkForUpdates() {
  updateElectronApp({
    updateInterval: "1 hour",
    updateSource: {
      repo: "bergthorsten/bfdui",
      type: UpdateSourceType.ElectronPublicUpdateService,
    },
  });
}

async function setupORPC() {
  const { rpcHandler } = await import("./ipc/handler");

  ipcMain.on(IPC_CHANNELS.START_ORPC_SERVER, (event) => {
    if (!isTrustedRendererEvent(event)) {
      console.warn("Rejected ORPC bootstrap from untrusted sender.");
      return;
    }

    const [serverPort] = event.ports;
    if (!serverPort) {
      console.warn("Rejected ORPC bootstrap without a message port.");
      return;
    }

    serverPort.start();
    rpcHandler.upgrade(serverPort);
  });
}

function isTrustedRendererEvent(event: IpcMainEvent): boolean {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) {
    return false;
  }

  return Boolean(
    event.senderFrame && isTrustedRendererUrl(event.senderFrame.url)
  );
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      return url.origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
    }
    return url.protocol === "file:";
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  try {
    createWindow();
    await setupORPC();
    startMcpServer().catch((error) => {
      console.error("Failed to start MCP server:", error);
    });
    loadMainWindow();
    await installExtensions();
    checkForUpdates();
  } catch (error) {
    console.error("Error during app initialization:", error);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopMcpServer().catch((error) => {
    console.error("Failed to stop MCP server:", error);
  });
});

//osX only
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    loadMainWindow();
  } else {
    // Tahoe/Electron can flash custom-positioned traffic lights on restore.
    mainWindow?.show();
  }
});
//osX only ends
