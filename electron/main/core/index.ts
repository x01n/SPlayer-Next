import { app, BrowserWindow, session } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import {
  createMainWindow,
  restoreLyricWindows,
  getMainWindow,
  focusMainWindow,
  getDesktopLyricWindow,
  getDynamicIslandWindow,
  getTaskbarLyricWindow,
} from "@main/window";
import { isMac } from "@main/utils/config";
import { registerIpcHandlers } from "@main/ipc";
import { init as initMedia, shutdown as shutdownMedia } from "@main/services/media";
import { init as initLastfm } from "@main/services/lastfm";
import { initGlobalHotkey } from "@main/services/globalHotkey";
import { initDatabase, closeDatabase } from "@main/database";
import { init as initSongCache } from "@main/services/songCache";
import { init as initDownload } from "@main/services/downloadManager";
import { pluginRegistry } from "@main/plugins/registry";
import {
  init as initPlaybackBridge,
  dispose as disposePlaybackBridge,
} from "@main/plugins/playbackBridge";
import { registerCacheScheme, handleCacheProtocol } from "@main/utils/protocol";
import { startServer, stopServer } from "@main/server";
import { initUpdater, disposeUpdater } from "@main/services/updater";
import { coreLog, initLogger } from "@main/utils/logger";
import {
  initOrpheusRegistration,
  extractOrpheusUrl,
  captureOrpheusUrl,
} from "@main/services/orpheus";
import {
  initListenTogetherProtocol,
  extractListenTogetherUrl,
  captureListenTogetherUrl,
} from "@main/services/listenTogetherProtocol";
import { getBilibiliCookie } from "@main/apis/bilibili/auth";

/** 为 Bilibili 域请求注入 Referer 和 Cookie */
const configureBilibiliRequestHeaders = (): void => {
  const bilibiliFilter = {
    urls: [
      "*://*.bilibili.com/*",
      "*://*.bilivideo.com/*",
      "*://*.bcdn.bilibili.com/*",
      "*://*.hdslb.com/*",
      "*://*.mcdn.bilibili.com/*",
      "*://*.szbdyd.com/*",
    ],
  };
  const sessions = [session.defaultSession, session.fromPartition("persist:main")];
  for (const currentSession of sessions) {
    currentSession.webRequest.onBeforeSendHeaders(
      bilibiliFilter,
      (
        details: Electron.OnBeforeSendHeadersListenerDetails,
        callback: (response: Electron.BeforeSendResponse) => void,
      ) => {
        const headers = details.requestHeaders;
        headers.Referer = "https://www.bilibili.com";
        if (new URL(details.url).hostname === "api.bilibili.com" && !headers.Cookie) {
          const cookie = getBilibiliCookie();
          if (cookie) headers.Cookie = cookie;
        }
        callback({ requestHeaders: headers });
      },
    );
  }
};

/**
 * 配置 Chromium 启动参数以优化内存占用
 */
const configureMemoryOptimizations = (): void => {
  // 禁止预热备用渲染进程
  app.commandLine.appendSwitch("disable-features", "SpareRendererForSitePerProcess");
  if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
    app.commandLine.appendSwitch("ozone-platform", "wayland");
  }
};

/** 内存指标采样间隔 */
const MEMORY_LOG_INTERVAL_MS = 10 * 60 * 1000;
/** 启动后首次采样延迟，避开启动期波动 */
const MEMORY_LOG_FIRST_DELAY_MS = 60 * 1000;

/** 记录各进程内存工作集，用于量化内存表现与防劣化对比 */
const logProcessMemory = (): void => {
  // pid → 窗口名，让 Tab 进程能区分主窗口与各歌词窗口
  const windowPids = new Map<number, string>();
  const namedWindows: Array<[string, Electron.BrowserWindow | null]> = [
    ["main", getMainWindow()],
    ["desktop-lyric", getDesktopLyricWindow()],
    ["dynamic-island", getDynamicIslandWindow()],
    ["taskbar-lyric", getTaskbarLyricWindow()],
  ];
  for (const [name, win] of namedWindows) {
    if (win && !win.isDestroyed()) windowPids.set(win.webContents.getOSProcessId(), name);
  }
  const parts = app.getAppMetrics().map((metric) => {
    const mb = Math.round(metric.memory.workingSetSize / 1024);
    const detail = windowPids.get(metric.pid) ?? metric.name ?? metric.serviceName;
    const label = detail ? `${metric.type}(${detail})` : metric.type;
    return `${label} ${mb}MB`;
  });
  coreLog.info(`内存占用: ${parts.join(" | ")}`);
};

/**
 * 初始化应用
 */
export const initApp = (): void => {
  configureMemoryOptimizations();
  // 初始化日志
  initLogger();
  // 单例锁
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    coreLog.warn("未获取到单例锁，退出重复实例");
    app.exit();
    return;
  }
  app.on("second-instance", (_event, commandLine) => {
    focusMainWindow();
    const url = extractOrpheusUrl(commandLine);
    if (url) captureOrpheusUrl(url);
    const ltUrl = extractListenTogetherUrl(commandLine);
    if (ltUrl) captureListenTogetherUrl(ltUrl);
  });
  // macOS 通过 open-url 接收协议唤起
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (url.startsWith("splayer-listentogether://")) {
      captureListenTogetherUrl(url);
    } else {
      captureOrpheusUrl(url);
    }
  });
  // 注册缓存协议方案
  registerCacheScheme();
  // 其他初始化
  app.whenReady().then(() => {
    // 保护性检查：防止单例锁在 Linux/Wayland 下失效时重复创建窗口
    if (BrowserWindow.getAllWindows().length > 0) {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      return;
    }
    electronApp.setAppUserModelId("top.imsyy.splayer-next");
    // 注册 cache:// 协议处理
    handleCacheProtocol();
    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });
    // 注册 IPC
    registerIpcHandlers();
    // 创建主窗口
    createMainWindow();
    // 配置 Bilibili 请求头注入（Referer + Cookie）
    configureBilibiliRequestHeaders();
    // 注册 orpheus 协议并处理冷启动唤起
    initOrpheusRegistration();
    const coldOrpheusUrl = extractOrpheusUrl(process.argv);
    if (coldOrpheusUrl) captureOrpheusUrl(coldOrpheusUrl);
    // 注册一起听协议并处理冷启动唤起
    initListenTogetherProtocol();
    const coldLtUrl = extractListenTogetherUrl(process.argv);
    if (coldLtUrl) captureListenTogetherUrl(coldLtUrl);
    // 初始化数据库
    initDatabase();
    // 启动歌曲缓存
    void initSongCache();
    // 启动下载服务
    void initDownload();
    initMedia();
    // 初始化 Last.fm 集成
    initLastfm();
    // 初始化插件系统
    pluginRegistry.init();
    // 初始化播放事件桥（需在 pluginRegistry.init 之后，读 hasEnabledControlPlugin）
    initPlaybackBridge();
    // 恢复歌词相关窗口
    restoreLyricWindows();
    // 注册全局快捷键
    initGlobalHotkey();
    // 启动外部 API 服务
    void startServer();
    // 初始化自动更新
    initUpdater();
    // 周期记录各进程内存
    setTimeout(logProcessMemory, MEMORY_LOG_FIRST_DELAY_MS);
    setInterval(logProcessMemory, MEMORY_LOG_INTERVAL_MS);
    app.on("activate", () => {
      if (isMac) {
        if (getMainWindow()) focusMainWindow();
        else createMainWindow();
        return;
      }
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
    coreLog.info("应用初始化完成");
  });
  // 所有窗口关闭时退出应用
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  // 退出前清理
  app.on("before-quit", () => {
    coreLog.info("应用即将退出，清理资源");
    shutdownMedia();
    closeDatabase();
    void stopServer();
    void pluginRegistry.shutdown();
    disposePlaybackBridge();
    disposeUpdater();
  });
};
