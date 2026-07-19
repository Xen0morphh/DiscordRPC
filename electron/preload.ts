import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("spotifyRpc", {
  getState: () => ipcRenderer.invoke("rpc:get-state"),
  saveConfig: (config: unknown) => ipcRenderer.invoke("rpc:save-config", config),
  connectSpotify: () => ipcRenderer.invoke("rpc:connect-spotify"),
  start: () => ipcRenderer.invoke("rpc:start"),
  stop: () => ipcRenderer.invoke("rpc:stop"),
  disconnectSpotify: () => ipcRenderer.invoke("rpc:disconnect-spotify"),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("rpc:state", listener);
    return () => ipcRenderer.off("rpc:state", listener);
  }
});
