/**
 * Spotify OAuth 登录窗口
 *
 * 打开 BrowserWindow 加载 Spotify 授权页，
 * 监听重定向到 http://localhost/callback，提取 code 后关闭窗口。
 */

import { BrowserWindow } from "electron";
import { coreLog } from "@main/utils/logger";

const REDIRECT_URI = "http://localhost/callback";

let activeWin: BrowserWindow | null = null;

/**
 * 打开 Spotify OAuth 登录窗口
 * @param authUrl - Spotify 授权 URL（含 PKCE 参数）
 * @returns 成功返回 code；用户取消或失败返回 null
 */
export const openSpotifyLoginWindow = async (authUrl: string): Promise<string | null> => {
  if (activeWin && !activeWin.isDestroyed()) {
    activeWin.focus();
    return null;
  }

  activeWin = new BrowserWindow({
    width: 800,
    height: 800,
    minWidth: 600,
    minHeight: 600,
    center: true,
    title: "Spotify 登录",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      if (activeWin && !activeWin.isDestroyed()) activeWin.destroy();
      activeWin = null;
      resolve(result);
    };

    activeWin!.once("ready-to-show", () => activeWin?.show());
    activeWin!.on("closed", () => finish(null));

    const handleUrl = (url: string): boolean => {
      if (url.startsWith(REDIRECT_URI)) {
        try {
          const parsed = new URL(url);
          const code = parsed.searchParams.get("code");
          const error = parsed.searchParams.get("error");
          if (code) {
            finish(code);
            return true;
          }
          if (error) {
            coreLog.warn(`[spotify] OAuth error: ${error}`);
            finish(null);
            return true;
          }
        } catch (err) {
          coreLog.warn("[spotify] 解析回调 URL 失败:", err);
        }
      }
      return false;
    };

    activeWin!.webContents.on("will-redirect", (event, url) => {
      if (handleUrl(url)) {
        event.preventDefault();
      }
    });

    activeWin!.webContents.on("will-navigate", (event, url) => {
      if (handleUrl(url)) {
        event.preventDefault();
      }
    });

    activeWin!.loadURL(authUrl).catch((err) => {
      coreLog.error("[spotify] 加载授权页失败:", err);
      finish(null);
    });
  });
};
