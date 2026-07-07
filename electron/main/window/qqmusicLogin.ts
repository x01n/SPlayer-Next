/**
 * QQ 音乐网页登录窗口
 *
 * 打开独立 BrowserWindow 加载 QQ 音乐官方登录/个人主页，使用专属 session 分区
 * 隔离 cookie；用户登录成功后从该分区读取关键 cookie 返回。
 */

import { BrowserWindow, session } from "electron";
import { getMainWindow } from "./main";
import { coreLog } from "@main/utils/logger";

const LOGIN_PARTITION = "persist:qqmusic-login";
const LOGIN_URL = "https://y.qq.com/n/ryqq/profile";

/** 登录判定间隔（毫秒） */
const POLL_INTERVAL_MS = 1000;
/** 登录判定：cookie 中必须包含 uin 才视为已登录 */
const LOGIN_COOKIE_KEY = "uin";

/** 伪装成普通桌面 Chrome，避免被 QQ 音乐识别为 Electron 环境 */
const FAKE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let activeWin: BrowserWindow | null = null;
let pollTimer: NodeJS.Timeout | null = null;

const getLoginSession = (): Electron.Session => session.fromPartition(LOGIN_PARTITION);

const stopPolling = (): void => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

/**
 * 收集登录会话中的 cookie
 * @returns 含 uin 时返回完整 cookie 字符串，否则 null
 */
const collectCookieString = async (): Promise<string | null> => {
  const ses = getLoginSession();
  const all = await ses.cookies.get({ url: "https://y.qq.com" });
  const loginCookie = all.find((c) => c.name === LOGIN_COOKIE_KEY && c.value);
  if (!loginCookie?.value) return null;

  const parts: string[] = [];
  for (const c of all) {
    if (!c.value) continue;
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
};

/**
 * 打开 QQ 音乐网页登录窗口
 * @returns 登录成功返回 cookie 字符串；用户关闭窗口返回 null
 */
export const openQQMusicLoginWindow = async (): Promise<string | null> => {
  if (activeWin && !activeWin.isDestroyed()) {
    activeWin.focus();
    return null;
  }

  // 清除旧的登录会话，避免残留 cookie 干扰
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
    title: "登录 QQ 音乐",
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
      stopPolling();
      if (activeWin && !activeWin.isDestroyed()) activeWin.destroy();
      activeWin = null;
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
          coreLog.warn("[qqmusic] poll cookies failed:", err);
        }
      }, POLL_INTERVAL_MS);
    });

    activeWin!.on("closed", () => finish(null));

    activeWin!.loadURL(LOGIN_URL, { userAgent: FAKE_UA }).catch((err) => {
      coreLog.error("[qqmusic] loadURL failed:", err);
      finish(null);
    });
  });
};
