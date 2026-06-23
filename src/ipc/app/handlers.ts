import { os } from "@orpc/server";
import { app } from "electron";
import { checkForAppUpdatesNow } from "@/services/app-updates";

export const currentPlatfom = os.handler(() => process.platform);

export const appVersion = os.handler(() => app.getVersion());

export const checkForAppUpdates = os.handler(() => checkForAppUpdatesNow());
