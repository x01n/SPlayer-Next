import { app, BrowserWindow, screen } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";
import { createWindow } from "./create";
import { setTrayDesktopLyric } from "@main/services/tray";
import { store } from "@main/store";
import { broadcast } from "@main/utils/broadcast";
import { isAppQuitting } from "@main/utils/lifecycle";
import { isLinux, isNativeWayland } from "@main/utils/config";
import { loadNativeModule } from "@main/utils/nativeLoader";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";

let desktopLyricWindow: BrowserWindow | null = null;


/** X11 辅助模块（Linux X11 下懒加载，Wayland 下不使用） */
let x11Helper: { setAlwaysOnTopX11: (wid: number, enable: boolean) => void; setIgnoreMouseEventsX11: (wid: number, ignore: boolean) => void; isX11: () => boolean } | null = null;

const getX11Helper = () => {
  if (!isLinux || x11Helper) return x11Helper;
  x11Helper = loadNativeModule("x11-helper.node", "x11-helper");
  return x11Helper;
};

/** 通过 X11 原生 API 强制设置置顶（Electron API 不生效时的备选） */
const forceX11AlwaysOnTop = (enable: boolean): void => {
  const helper = getX11Helper();
  if (!helper || !desktopLyricWindow) return;
  try {
    const handle = desktopLyricWindow.getNativeWindowHandle();
    let wid: number;
    if (handle.length === 4) {
      wid = handle.readUInt32LE(0);
    } else if (handle.length === 8) {
      wid = Number(handle.readBigUInt64LE(0));
    } else {
      return;
    }
    helper.setAlwaysOnTopX11(wid, enable);
  } catch {
    // X11 调用失败时静默忽略
  }
};

/** 通过 X11 Shape 扩展强制设置鼠标穿透（Electron API 不生效时的备选） */
const forceX11IgnoreMouseEvents = (ignore: boolean): void => {
  const helper = getX11Helper();
  if (!helper || !desktopLyricWindow) return;
  try {
    const handle = desktopLyricWindow.getNativeWindowHandle();
    let wid: number;
    if (handle.length === 4) {
      wid = handle.readUInt32LE(0);
    } else if (handle.length === 8) {
      wid = Number(handle.readBigUInt64LE(0));
    } else {
      return;
    }
    helper.setIgnoreMouseEventsX11(wid, ignore);
  } catch {
    // XShape 调用失败时静默忽略
  }
};

/** KWin 脚本是否已加载 */
let kwinScriptLoaded = false;

/**
 * 尝试使用可用的 qdbus 工具加载 KWin 脚本
 * @param scriptPath - KWin 脚本文件路径
 * @throws 当所有 qdbus 命令都失败时抛出错误
 */
const runKWinScriptCommand = (scriptPath: string): void => {
  const commands = [
    `qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "${scriptPath}"`,
    `qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "${scriptPath}"`,
    `qdbus-qt6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "${scriptPath}"`,
    `dbus-send --session --type=method_call --dest=org.kde.KWin --print-reply /Scripting org.kde.kwin.Scripting.loadScript string:"${scriptPath}"`,
  ];
  let lastError: Error | undefined;
  for (const cmd of commands) {
    try {
      execSync(cmd, { timeout: 5000, stdio: "pipe" });
      return;
    } catch (error) {
      lastError = error as Error;
      console.error(`[desktop-lyric] KWin script command failed: ${cmd}`, error);
    }
  }
  throw lastError;
};

/**
 * 加载 KWin 脚本，用于在 KDE Plasma Wayland 下设置桌面歌词窗口属性
 * KWin 脚本 init() 会在加载时自动执行
 */
const setupKWinScript = (): void => {
  if (kwinScriptLoaded || !isNativeWayland) return;
  try {
    const scriptDir = join(app.getPath("userData"), "app-data", "kwin-scripts");
    const scriptPath = join(scriptDir, "splayer-desktop-lyric.js");
    if (!existsSync(scriptDir)) mkdirSync(scriptDir, { recursive: true });

    const cfg = store.get("desktopLyric");
    const alwaysOnTop = cfg.alwaysOnTop;

    const scriptContent = `function init() {
  function setupWindow(w) {
    if (w.caption === "SPlayer-Next - Desktop Lyric") {
      w.skipTaskbar = true;
      w.noBorder = true;
      w.keepAbove = ${alwaysOnTop};
      print("SPlayer desktop lyric setup: skipTaskbar=true, noBorder=true, keepAbove=" + ${alwaysOnTop});
    }
  }
  var windows = workspace.windowList ? workspace.windowList() : workspace.clientList();
  for (var i = 0; i < windows.length; i++) setupWindow(windows[i]);
  var signal = workspace.windowAdded || workspace.clientAdded;
  signal.connect(setupWindow);
  print("SPlayer desktop lyric init script loaded, alwaysOnTop=${alwaysOnTop}");
}`;

    writeFileSync(scriptPath, scriptContent, "utf-8");
    runKWinScriptCommand(scriptPath);
    kwinScriptLoaded = true;
  } catch (error) {
    console.error("[desktop-lyric] KWin setup script failed:", error);
  }
};

/**
 * 执行 KWin 脚本片段，用于动态修改桌面歌词窗口状态
 * 脚本会同时处理当前已存在的窗口，并监听新窗口加入事件
 * @param body - 脚本函数体（不含 function init() 包装）
 */
const runKWinScript = (body: string): void => {
  if (!isNativeWayland) return;
  try {
    const scriptDir = join(app.getPath("userData"), "app-data", "kwin-scripts");
    const scriptPath = join(scriptDir, `splayer-kwin-${Date.now()}.js`);
    if (!existsSync(scriptDir)) mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      scriptPath,
      `function init() { ${body} }`,
      "utf-8",
    );
    runKWinScriptCommand(scriptPath);
    try {
      unlinkSync(scriptPath);
    } catch {
      // 清理失败忽略
    }
  } catch (error) {
    console.error("[desktop-lyric] KWin dynamic script failed:", error);
  }
};

/** Electron 置顶层级，Linux 不支持 "overlay"，回退到 "screen-saver" */
const ALWAYS_ON_TOP_LEVEL = (isLinux ? "screen-saver" : "overlay") as "screen-saver";

/** 最小宽度 */
const MIN_WIDTH = 400;
/** 最小高度 */
const MIN_HEIGHT = 100;
/** 最大高度 */
const MAX_HEIGHT = 600;
/** 默认高度 */
const FALLBACK_HEIGHT = 200;
/** 默认宽度 */
const FALLBACK_WIDTH = 800;
/** 光标位置轮询间隔（ms） */
const CURSOR_POLL_MS = 150;

/**
 * 权威尺寸缓存
 * 所有 setBounds 写宽高都用它，绝不从 getBounds 读尺寸回写，
 * 避免 Windows 高 DPI 下 DIP↔物理像素有损回环造成尺寸漂移
 */
const cachedSize = { width: 0, height: 0 };

/**
 * 光标位置轮询
 * 用 OS 级 screen.getCursorScreenPoint() 判断鼠标是否在歌词窗口内
 */
let cursorPollTimer: NodeJS.Timeout | null = null;
let lastCursorInside = false;

const isCursorInsideBounds = (): boolean => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return false;
  const cursor = screen.getCursorScreenPoint();
  const b = desktopLyricWindow.getBounds();
  return (
    cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height
  );
};

/** 启动光标位置轮询 */
const startCursorPolling = (): void => {
  if (cursorPollTimer) return;
  lastCursorInside = isCursorInsideBounds();
  // 推一次初始值
  desktopLyricWindow?.webContents.send("desktopLyric:cursorInside", lastCursorInside);
  cursorPollTimer = setInterval(() => {
    if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) {
      stopCursorPolling();
      return;
    }
    const inside = isCursorInsideBounds();
    if (inside !== lastCursorInside) {
      lastCursorInside = inside;
      desktopLyricWindow.webContents.send("desktopLyric:cursorInside", inside);
    }
  }, CURSOR_POLL_MS);
};

/** 停止光标位置轮询 */
const stopCursorPolling = (): void => {
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer);
    cursorPollTimer = null;
  }
};

/** 保存窗口状态 */
const saveWindowState = (): void => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  const { x, y } = desktopLyricWindow.getBounds();
  store.set("windowStates.desktopLyric", {
    ...store.get("windowStates.desktopLyric"),
    x,
    y,
    width: cachedSize.width,
    height: cachedSize.height,
  });
};

/**
 * 同步应用桌面歌词的状态（置顶、锁定）
 * 部分窗口管理器/桌面环境下，窗口映射完成前 setAlwaysOnTop 可能不生效，
 * 延迟后再同步一次置顶状态，确保桌面歌词始终保持在最上层
 */
const syncDesktopLyricState = (): void => {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
  const cfg = store.get("desktopLyric");
  desktopLyricWindow.setAlwaysOnTop(cfg.alwaysOnTop, ALWAYS_ON_TOP_LEVEL);
  if (isLinux) {
    desktopLyricWindow.setVisibleOnAllWorkspaces(cfg.alwaysOnTop, { visibleOnFullScreen: cfg.alwaysOnTop });
  }
  if (!isLinux && cfg.locked) {
    desktopLyricWindow.setIgnoreMouseEvents(true, { forward: true });
  }

  // 第一次延迟同步（300ms）
  setTimeout(() => {
    if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
    const currentCfg = store.get("desktopLyric");
    desktopLyricWindow.setAlwaysOnTop(currentCfg.alwaysOnTop, ALWAYS_ON_TOP_LEVEL);
    if (isLinux) {
      desktopLyricWindow.setVisibleOnAllWorkspaces(currentCfg.alwaysOnTop, {
        visibleOnFullScreen: currentCfg.alwaysOnTop,
      });
      if (isNativeWayland) {
        desktopLyricWindow.setMovable(!currentCfg.locked);
        desktopLyricWindow.setResizable(!currentCfg.locked);
        runKWinScript(
          `function applyToWindow(w) {
    if (w.caption === "SPlayer-Next - Desktop Lyric") {
      w.keepAbove = ${currentCfg.alwaysOnTop};
      print("SPlayer desktop lyric keepAbove = " + ${currentCfg.alwaysOnTop});
    }
  }
  var windows = workspace.windowList ? workspace.windowList() : workspace.clientList();
  for (var i = 0; i < windows.length; i++) applyToWindow(windows[i]);
  var signal = workspace.windowAdded || workspace.clientAdded;
  signal.connect(applyToWindow);
  print("SPlayer desktop lyric sync script loaded, keepAbove = " + ${currentCfg.alwaysOnTop});`,
        );
      } else {
        if (currentCfg.locked) {
          desktopLyricWindow.setIgnoreMouseEvents(true);
          forceX11IgnoreMouseEvents(true);
        } else {
          desktopLyricWindow.setIgnoreMouseEvents(false);
          forceX11IgnoreMouseEvents(false);
        }
        forceX11AlwaysOnTop(currentCfg.alwaysOnTop);
      }
    }
  }, 300);

  // 第二次延迟同步（900ms），覆盖窗口管理器延迟映射场景
  setTimeout(() => {
    if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return;
    const currentCfg = store.get("desktopLyric");
    desktopLyricWindow.setAlwaysOnTop(currentCfg.alwaysOnTop, ALWAYS_ON_TOP_LEVEL);
    if (isLinux) {
      desktopLyricWindow.setVisibleOnAllWorkspaces(currentCfg.alwaysOnTop, {
        visibleOnFullScreen: currentCfg.alwaysOnTop,
      });
      if (isNativeWayland) {
        runKWinScript(
          `function applyToWindow(w) {
    if (w.caption === "SPlayer-Next - Desktop Lyric") {
      w.keepAbove = ${currentCfg.alwaysOnTop};
      print("SPlayer desktop lyric keepAbove = " + ${currentCfg.alwaysOnTop});
    }
  }
  var windows = workspace.windowList ? workspace.windowList() : workspace.clientList();
  for (var i = 0; i < windows.length; i++) applyToWindow(windows[i]);
  var signal = workspace.windowAdded || workspace.clientAdded;
  signal.connect(applyToWindow);
  print("SPlayer desktop lyric sync script loaded, keepAbove = " + ${currentCfg.alwaysOnTop});`,
        );
      } else {
        forceX11AlwaysOnTop(currentCfg.alwaysOnTop);
      }
    }
  }, 900);
};

/**
 * 应用锁定状态
 * @param locked 是否锁定
 */
export const applyDesktopLyricLock = (locked: boolean): void => {
  const win = getDesktopLyricWindow();
  if (!win) return;
  if (isNativeWayland) {
    // Wayland 下 Electron setIgnoreMouseEvents 不生效，workaround：强制 resize 触发 input region 更新
    win.setIgnoreMouseEvents(locked);
    const b = win.getBounds();
    win.setBounds({ ...b, width: b.width + 1 });
    setTimeout(() => win.setBounds(b), 0);
    win.setMovable(!locked);
    win.setResizable(!locked);
  } else if (isLinux) {
    win.setIgnoreMouseEvents(locked);
    forceX11IgnoreMouseEvents(locked);
    win.setMovable(!locked);
    win.setResizable(!locked);
  } else {
    win.setIgnoreMouseEvents(locked, { forward: true });
    win.setMovable(!locked);
    win.setResizable(!locked);
  }
};

/**
 * 应用窗口置顶
 * @param alwaysOnTop 是否置顶
 */
export const applyDesktopLyricAlwaysOnTop = (alwaysOnTop: boolean): void => {
  const win = getDesktopLyricWindow();
  if (!win) return;
  win.setAlwaysOnTop(alwaysOnTop, ALWAYS_ON_TOP_LEVEL);
  if (isLinux) {
    win.setVisibleOnAllWorkspaces(alwaysOnTop, {
      visibleOnFullScreen: alwaysOnTop,
    });
    if (isNativeWayland) {
      runKWinScript(
        `function applyToWindow(w) {
    if (w.caption === "SPlayer-Next - Desktop Lyric") {
      w.keepAbove = ${alwaysOnTop};
      print("SPlayer desktop lyric keepAbove = " + ${alwaysOnTop});
    }
  }
  var windows = workspace.windowList ? workspace.windowList() : workspace.clientList();
  for (var i = 0; i < windows.length; i++) applyToWindow(windows[i]);
  var signal = workspace.windowAdded || workspace.clientAdded;
  signal.connect(applyToWindow);
  print("SPlayer desktop lyric apply script loaded, keepAbove = " + ${alwaysOnTop});`,
      );
      // Wayland 下 KWin 脚本可能异步执行，延迟后再次尝试
      setTimeout(() => {
        runKWinScript(
          `function applyToWindow(w) {
    if (w.caption === "SPlayer-Next - Desktop Lyric") {
      w.keepAbove = ${alwaysOnTop};
      print("SPlayer desktop lyric keepAbove retry = " + ${alwaysOnTop});
    }
  }
  var windows = workspace.windowList ? workspace.windowList() : workspace.clientList();
  for (var i = 0; i < windows.length; i++) applyToWindow(windows[i]);
  var signal = workspace.windowAdded || workspace.clientAdded;
  signal.connect(applyToWindow);
  print("SPlayer desktop lyric retry script loaded, keepAbove = " + ${alwaysOnTop});`,
        );
      }, 600);
    } else {
      forceX11AlwaysOnTop(alwaysOnTop);
      // X11 MapWindow 异步，延迟后再强制一次
      setTimeout(() => forceX11AlwaysOnTop(alwaysOnTop), 300);
    }
  }
};

/** 锁定状态下由渲染端切换鼠标事件穿透 */
export const applyDesktopLyricMouseIgnore = (ignore: boolean): void => {
  const win = getDesktopLyricWindow();
  if (!win) return;
  if (isNativeWayland) return; // Wayland 下 Electron setIgnoreMouseEvents 不生效，跳过
  if (isLinux) {
    win.setIgnoreMouseEvents(ignore);
  } else {
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }
};

/**
 * 移动窗口到指定位置
 * 尺寸始终用权威 cachedSize 写回
 * 开启 limitBounds 时把 x/y clamp 到光标所在显示器的 workArea，避免拖出屏幕 / 被任务栏挡住
 */
export const moveDesktopLyricWindow = (x: number, y: number): void => {
  const win = getDesktopLyricWindow();
  if (!win) return;
  let tx = Math.round(x);
  let ty = Math.round(y);
  if (store.get("desktopLyric").limitBounds) {
    const display = screen.getDisplayMatching({
      x: tx,
      y: ty,
      width: cachedSize.width,
      height: cachedSize.height,
    });
    const wa = display.workArea;
    tx = Math.max(wa.x, Math.min(wa.x + wa.width - cachedSize.width, tx));
    ty = Math.max(wa.y, Math.min(wa.y + wa.height - cachedSize.height, ty));
  }
  win.setBounds({ x: tx, y: ty, width: cachedSize.width, height: cachedSize.height });
};

/** 拖拽结束后保存最终位置 */
export const saveDesktopLyricState = (): void => {
  saveWindowState();
};

/** 锁定窗口高度 */
export const applyDesktopLyricHeight = (height: number): void => {
  const win = getDesktopLyricWindow();
  if (!win) return;
  const h = Math.round(height);
  cachedSize.height = h;
  const { x, y } = win.getBounds();
  win.setBounds({ x, y, width: cachedSize.width, height: h });
};

/** 创建桌面歌词窗口，如果窗口已存在则显示并聚焦 */
export const createDesktopLyricWindow = (): BrowserWindow => {
  if (isNativeWayland) setupKWinScript();
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    desktopLyricWindow.show();
    syncDesktopLyricState();
    desktopLyricWindow.focus();
    return desktopLyricWindow;
  }
  const config = store.get("desktopLyric");
  const saved = store.get("windowStates.desktopLyric");
  const initialHeight = saved.height || FALLBACK_HEIGHT;
  const initialWidth = saved.width || FALLBACK_WIDTH;

  desktopLyricWindow = createWindow({
    width: initialWidth,
    height: initialHeight,
    ...(saved.x !== null && saved.y !== null ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    title: "SPlayer-Next - Desktop Lyric",
    show: false, // 显式隐藏，在 ready-to-show 后再显示，确保状态同步时机正确
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: !config.locked,
    movable: !config.locked,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: config.alwaysOnTop, // 创建时即置顶
    skipTaskbar: true,
    focusable: !isLinux, // Linux 下不抢焦点，避免点击其他窗口时歌词窗口被激活
    backgroundColor: "#00000000",
    webPreferences: {
      images: false,
      disableDialogs: true,
      zoomFactor: 1.0,
    },
  });

  cachedSize.width = initialWidth;
  cachedSize.height = initialHeight;

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    desktopLyricWindow.loadURL(
      `${process.env["ELECTRON_RENDERER_URL"]}/windows/desktop-lyric/index.html`,
    );
  } else {
    desktopLyricWindow.loadFile(join(__dirname, "../renderer/windows/desktop-lyric/index.html"));
  }

  desktopLyricWindow.webContents.on("did-finish-load", () => {
    desktopLyricWindow?.webContents.setZoomFactor(1.0);
  });

  // 内容就绪后显示窗口，状态同步交给 show 事件处理
  desktopLyricWindow.once("ready-to-show", () => {
    if (!desktopLyricWindow) return;
    const b = desktopLyricWindow.getBounds();
    cachedSize.width = b.width;
    cachedSize.height = b.height;
    desktopLyricWindow.show();
    desktopLyricWindow.setAlwaysOnTop(config.alwaysOnTop, ALWAYS_ON_TOP_LEVEL);
    startCursorPolling();
  });

  // 窗口从隐藏恢复时重新同步状态
  desktopLyricWindow.on("show", () => {
    syncDesktopLyricState();
  });

  /** 窗口大小变化事件 */
  desktopLyricWindow.on("resized", () => {
    if (!desktopLyricWindow) return;
    const b = desktopLyricWindow.getBounds();
    cachedSize.width = b.width;
    cachedSize.height = b.height;
    saveWindowState();
  });

  /** 设置托盘图标 */
  setTrayDesktopLyric(true);
  broadcast("desktopLyric:visibilityChange", true);
  store.set("windowStates.desktopLyric.visible", true);

  /** 窗口关闭事件 */
  desktopLyricWindow.on("closed", () => {
    stopCursorPolling();
    desktopLyricWindow = null;
    setTrayDesktopLyric(false);
    broadcast("desktopLyric:visibilityChange", false);
    if (!isAppQuitting()) {
      store.set("windowStates.desktopLyric.visible", false);
    }
  });
  return desktopLyricWindow;
};

/** 关闭桌面歌词窗口 */
export const closeDesktopLyricWindow = (): void => {
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    desktopLyricWindow.setAlwaysOnTop(false);
    desktopLyricWindow.close();
  }
};

/** 切换桌面歌词窗口 */
export const toggleDesktopLyricWindow = (): boolean => {
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    closeDesktopLyricWindow();
    return false;
  }
  createDesktopLyricWindow();
  return true;
};

/** 获取桌面歌词窗口实例 */
export const getDesktopLyricWindow = (): BrowserWindow | null => {
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) return desktopLyricWindow;
  return null;
};
