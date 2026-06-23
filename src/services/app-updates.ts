import { app, autoUpdater } from "electron";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";
import type { ConnectionResult } from "@/types/bfd";

const UPDATE_INTERVAL = "1 hour";
const UPDATE_REPO = "bergthorsten/bfdui";
const MANUAL_CHECK_TIMEOUT_MS = 60_000;

let initialized = false;
let manualCheckRunning = false;

export function initializeAppUpdates(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  updateElectronApp({
    updateInterval: UPDATE_INTERVAL,
    updateSource: {
      repo: UPDATE_REPO,
      type: UpdateSourceType.ElectronPublicUpdateService,
    },
  });
}

export function checkForAppUpdatesNow(): Promise<ConnectionResult> {
  if (!app.isPackaged) {
    return Promise.resolve({
      detail: `Current version: ${app.getVersion()}`,
      message:
        "Update checks are disabled while running BFD in development mode.",
      ok: true,
    });
  }

  if (process.platform !== "darwin" && process.platform !== "win32") {
    return Promise.resolve({
      message: `Automatic updates are not supported on ${process.platform} builds.`,
      ok: false,
    });
  }

  if (manualCheckRunning) {
    return Promise.resolve({
      message: "An update check is already running.",
      ok: false,
    });
  }

  initializeAppUpdates();
  manualCheckRunning = true;

  return new Promise((resolve) => {
    const finish = (result: ConnectionResult) => {
      cleanup();
      manualCheckRunning = false;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({
        message: "The update check timed out. Try again later.",
        ok: false,
      });
    }, MANUAL_CHECK_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      autoUpdater.removeListener("update-not-available", onNotAvailable);
      autoUpdater.removeListener("update-available", onAvailable);
      autoUpdater.removeListener("update-downloaded", onDownloaded);
      autoUpdater.removeListener("error", onError);
    };

    const onNotAvailable = () => {
      finish({
        detail: `Current version: ${app.getVersion()}`,
        message: "BFD is up to date.",
        ok: true,
      });
    };

    const onAvailable = () => {
      finish({
        message:
          "A BFD update is available and is downloading in the background.",
        ok: true,
      });
    };

    const onDownloaded = (
      _event: unknown,
      _notes: unknown,
      releaseName?: string
    ) => {
      finish({
        detail: releaseName,
        message: "A BFD update is ready. Use the restart prompt to install it.",
        ok: true,
      });
    };

    const onError = (error: Error) => {
      finish({
        message: error.message || "Update check failed.",
        ok: false,
      });
    };

    autoUpdater.once("update-not-available", onNotAvailable);
    autoUpdater.once("update-available", onAvailable);
    autoUpdater.once("update-downloaded", onDownloaded);
    autoUpdater.once("error", onError);

    try {
      autoUpdater.checkForUpdates();
    } catch (error) {
      finish({
        message: error instanceof Error ? error.message : String(error),
        ok: false,
      });
    }
  });
}
