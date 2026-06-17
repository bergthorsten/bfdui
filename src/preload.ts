import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./constants";

contextBridge.exposeInMainWorld("bfd", {
  startORPCServer(serverPort: MessagePort) {
    ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
  },
});
