/**
 * Bilibili 网页登录窗口
 *
 * 打开独立 BrowserWindow 加载 Bilibili 首页，使用专属 session 分区
 * 隔离 cookie；用户登录成功后从该分区读取 SESSDATA 等关键 cookie 返回。
 *
 * 同一时刻只允许一个登录窗口存在。
 */

import { BrowserWindow, session } from "electron";
import { getMainWindow } from "./main";
import { coreLog } from "@main/utils/logger";

const LOGIN_PARTITION = "persist:bilibili-login";
const LOGIN_URL = "https://www.bilibili.com";

/** 关心的关键 cookie；未取到 SESSDATA 视为未登录 */
const COOKIE_KEYS = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"];

/**
 * 伪装成普通桌面 Chrome
 * 默认 UA 含 "Electron/..."，Bilibili 会判定为不受支持环境
 */
const FAKE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let activeWin: BrowserWindow | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const getLoginSession = (): Electron.Session => session.fromPartition(LOGIN_PARTITION);

const stopPolling = (): void => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

/**
 * 清理登录窗口引用，防止内存泄漏
 */
const cleanupWindow = (): void => {
  stopPolling();
  if (activeWin && !activeWin.isDestroyed()) {
    try {
      activeWin.destroy();
    } catch {
      // 窗口已销毁时忽略错误
    }
  }
  activeWin = null;
};

/**
 * 收集登录会话中的 cookies
 * @returns 含 SESSDATA 时返回完整 cookie 字符串，否则 null
 */
const collectCookieString = async (): Promise<string | null> => {
  const ses = getLoginSession();
  const all = await ses.cookies.get({ url: "https://www.bilibili.com" });
  const sessData = all.find((c) => c.name === "SESSDATA");
  if (!sessData?.value) return null;

  const parts: string[] = [];
  for (const key of COOKIE_KEYS) {
    const hit = all.find((c) => c.name === key);
    if (hit?.value) parts.push(`${hit.name}=${hit.value}`);
  }
  // 补充其他可能有用的 cookie
  for (const c of all) {
    if (!COOKIE_KEYS.includes(c.name) && c.value) {
      parts.push(`${c.name}=${c.value}`);
    }
  }
  return parts.join("; ");
};

/**
 * 打开 Bilibili 网页登录窗口
 * @returns 登录成功返回 cookie 字符串；用户关闭窗口返回 null
 */
export const openBilibiliLoginWindow = async (): Promise<string | null> => {
  // 已存在则先聚焦
  if (activeWin && !activeWin.isDestroyed()) {
    activeWin.focus();
    return null;
  }

  // 确保清理上一个窗口的残留，防止内存泄漏
  cleanupWindow();
  const ses = getLoginSession();
  await ses.clearStorageData({ storages: ["cookies", "localstorage", "indexdb"] });
  ses.setUserAgent(FAKE_UA);

  const parent = getMainWindow() ?? undefined;

  activeWin = new BrowserWindow({
    parent,
    modal: false,
    width: 1024,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    center: true,
    title: "登录 Bilibili",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      session: ses,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  activeWin.webContents.setUserAgent(FAKE_UA);
  activeWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  return await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      cleanupWindow();
      resolve(result);
    };

    activeWin!.once("ready-to-show", () => activeWin?.show());

    activeWin!.webContents.once("dom-ready", () => {
      stopPolling();
      pollTimer = setInterval(async () => {
        try {
          const cookies = await collectCookieString();
          if (cookies) finish(cookies);
        } catch (err) {
          coreLog.warn("[bilibili] poll cookies failed:", err);
        }
      }, 1000);
    });

    activeWin!.on("closed", () => finish(null));

    activeWin!.loadURL(LOGIN_URL, { userAgent: FAKE_UA }).catch((err) => {
      coreLog.error("[bilibili] loadURL failed:", err);
      finish(null);
    });
  });
};
