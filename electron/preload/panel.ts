import { contextBridge, ipcRenderer } from "electron";

/**
 * 插件面板窗口专用 preload
 * 仅暴露面板通信所需的最小 API，禁止访问主窗口的完整 IPC 能力
 */
const electronAPI = {
  send: (channel: string, ...args: unknown[]): void => {
    if (channel !== "plugin-panel-post") {
      throw new Error(`panel preload: channel "${channel}" is not allowed`);
    }
    ipcRenderer.send(channel, ...args);
  },
  on: (channel: string, listener: (...args: unknown[]) => void): (() => void) => {
    if (channel !== "plugin-panel-message") {
      throw new Error(`panel preload: channel "${channel}" is not allowed`);
    }
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electronAPI", electronAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  (window as any).electronAPI = electronAPI;
}
