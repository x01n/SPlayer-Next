/**
 * 插件面板管理器
 *
 * 为 panel 类型插件提供独立的 BrowserWindow 面板窗口。
 * 每个面板窗口通过 data URL 渲染插件提供的 HTML/CSS/JS，
 * 通过 IPC 与插件沙箱通信。
 */

import { BrowserWindow } from "electron";
import path from "node:path";
import { coreLog } from "@main/utils/logger";

/** 插件面板窗口专用 preload 路径，权限最小化 */
const PRELOAD_PATH = path.join(__dirname, "../preload/panel.mjs");

interface PanelWindow {
  pluginId: string;
  panelId: string;
  window: BrowserWindow;
}

class PluginPanelManager {
  private panels = new Map<string, PanelWindow>();

  private getKey(pluginId: string, panelId: string): string {
    return `${pluginId}::${panelId}`;
  }

  /**
   * 显示插件面板窗口
   * @param pluginId - 插件 ID
   * @param panelId - 面板 ID
   * @param html - 面板 HTML 内容
   * @param css - 面板 CSS 样式
   * @param js - 面板 JS 脚本
   */
  async showPanel(
    pluginId: string,
    panelId: string,
    html: string,
    css: string,
    js: string,
  ): Promise<void> {
    const key = this.getKey(pluginId, panelId);
    const existing = this.panels.get(key);
    if (existing) {
      existing.window.show();
      if (!existing.window.isFocused()) {
        existing.window.focus();
      }
      return;
    }

    const win = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 400,
      minHeight: 300,
      show: false,
      webPreferences: {
        preload: PRELOAD_PATH,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
      title: "插件面板",
    });

    const content = this.buildPanelHtml(html, css, js, pluginId, panelId);

    win.once("ready-to-show", () => {
      win.show();
    });

    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(content)}`);

    win.on("closed", () => {
      this.panels.delete(key);
    });

    this.panels.set(key, { pluginId, panelId, window: win });
    coreLog.info(`[panel] 面板已创建: ${pluginId}/${panelId}`);
  }

  /**
   * 隐藏面板窗口（不销毁）
   */
  hidePanel(pluginId: string, panelId: string): void {
    const key = this.getKey(pluginId, panelId);
    const panel = this.panels.get(key);
    if (panel?.window && !panel.window.isDestroyed()) {
      panel.window.hide();
    }
  }

  /**
   * 关闭并销毁面板窗口
   */
  closePanel(pluginId: string, panelId: string): void {
    const key = this.getKey(pluginId, panelId);
    const panel = this.panels.get(key);
    if (panel?.window && !panel.window.isDestroyed()) {
      panel.window.close();
    }
    this.panels.delete(key);
  }

  /**
   * 向面板窗口发送消息
   */
  postMessage(pluginId: string, panelId: string, message: unknown): void {
    const key = this.getKey(pluginId, panelId);
    const panel = this.panels.get(key);
    if (panel?.window && !panel.window.isDestroyed()) {
      panel.window.webContents.send("plugin-panel-message", { pluginId, panelId, message });
    }
  }

  /**
   * 关闭某插件的所有面板
   */
  closeAllForPlugin(pluginId: string): void {
    const keysToClose: string[] = [];
    for (const [key, panel] of this.panels.entries()) {
      if (panel.pluginId === pluginId) {
        keysToClose.push(key);
      }
    }
    for (const key of keysToClose) {
      const panel = this.panels.get(key);
      if (panel && !panel.window.isDestroyed()) {
        panel.window.close();
      }
      this.panels.delete(key);
    }
  }

  /**
   * 构建面板 HTML 内容
   */
  private buildPanelHtml(
    html: string,
    css: string,
    js: string,
    pluginId: string,
    panelId: string,
  ): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>插件面板</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #333;
    background: #f5f5f5;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }
  #panel-root {
    width: 100%;
    height: 100%;
    overflow: auto;
    padding: 16px;
  }
  ${css}
</style>
</head>
<body>
<div id="panel-root">${html}</div>
<script>
  (function() {
    const pluginId = ${JSON.stringify(pluginId)};
    const panelId = ${JSON.stringify(panelId)};

    window.pluginPanel = {
      postMessage: (message) => {
        if (window.electronAPI) {
          window.electronAPI.send("plugin-panel-post", { pluginId, panelId, message });
        }
      },
      onMessage: (callback) => {
        if (window.electronAPI) {
          window.electronAPI.on("plugin-panel-message", (_event, data) => {
            if (data.pluginId === pluginId && data.panelId === panelId) {
              callback(data.message);
            }
          });
        }
      },
    };

    ${js}
  })();
</script>
</body>
</html>`;
  }
}

export const panelManager = new PluginPanelManager();
