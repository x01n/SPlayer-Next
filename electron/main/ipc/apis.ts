/**
 * 音源 API 统一 IPC
 *
 * 只注册两个通道：
 * - apis:call(platform, name, params)   调用对应平台的任意接口
 * - apis:clearSession(platform)         清空某平台登录态
 */

import { ipcMain } from "electron";
import { callNetease, clearNeteaseCookies, mergeNeteaseCookies } from "@main/apis/netease";
import { cookieToJson } from "@main/apis/netease/core/cookie";
import { callQQMusic, clearQQMusicCache } from "@main/apis/qqmusic";
import {
  setQQMusicCookie,
  clearQQMusicCookie,
  fetchQQMusicLoginStatus,
} from "@main/apis/qqmusic/auth";
import { callKugou, clearKugouCache } from "@main/apis/kugou";
import { setKugouCookie, clearKugouCookie, fetchKugouLoginStatus } from "@main/apis/kugou/auth";
import { callSpotify, clearSpotifyCache } from "@main/apis/spotify";
import {
  getUserAccessToken,
  getSpotifyUserProfile,
  logoutSpotify,
  clearTokenCache,
  setSpotifyBrowserCookie,
  exchangeBrowserCookieForToken,
} from "@main/apis/spotify/auth";
import {
  setBilibiliCookie,
  getBilibiliProxyCookie,
  clearBilibiliCookie,
  fetchBilibiliLoginStatus,
  generateQrKey,
  pollQrStatus,
  loginWithPassword,
} from "@main/apis/bilibili/auth";
import { openNeteaseLoginWindow } from "@main/window/login";
import { openQQMusicLoginWindow } from "@main/window/qqmusicLogin";
import { openBilibiliLoginWindow } from "@main/window/bilibiliLogin";
import { coreLog } from "@main/utils/logger";
import type { ApiPlatform } from "@shared/types/apis";

/** 各平台的调用器：统一返回 `{ status?, body?, data? }` 由前端按需取 */
const dispatch = async (
  platform: ApiPlatform,
  name: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  switch (platform) {
    case "netease": {
      const res = await callNetease(name, params);
      return { status: res.status, body: res.body };
    }
    case "qqmusic": {
      const data = await callQQMusic(name, params);
      return { data };
    }
    case "kugou": {
      const data = await callKugou(name, params);
      return { data };
    }
    case "spotify": {
      const data = await callSpotify(name, params);
      return { data };
    }
    case "bilibili": {
      throw new Error("bilibili api not implemented");
    }
    default:
      throw new Error(`unknown platform: ${platform}`);
  }
};

export const registerApisIpc = (): void => {
  ipcMain.handle(
    "apis:call",
    async (_evt, platform: ApiPlatform, name: string, params?: Record<string, unknown>) => {
      try {
        const result = await dispatch(platform, name, params ?? {});
        return { ok: true, ...result };
      } catch (err) {
        coreLog.warn(`[apis] ${platform}.${name} failed:`, err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle("apis:clearSession", (_evt, platform: ApiPlatform) => {
    if (platform === "netease") {
      clearNeteaseCookies();
    } else if (platform === "qqmusic") {
      clearQQMusicCookie();
      clearQQMusicCache();
    } else if (platform === "kugou") {
      clearKugouCookie();
      clearKugouCache();
    } else if (platform === "spotify") {
      logoutSpotify();
      clearTokenCache();
      clearSpotifyCache();
    } else if (platform === "bilibili") {
      clearBilibiliCookie();
    }
  });

  // 打开 NCM/QQ/Bilibili 官方网页登录，成功后把 cookies 合并写入 session
  ipcMain.handle("apis:openLoginWeb", async (_evt, platform: ApiPlatform) => {
    try {
      if (platform === "netease") {
        const cookies = await openNeteaseLoginWindow();
        if (!cookies) return { ok: false, error: "canceled" };
        mergeNeteaseCookies(cookies);
        return { ok: true };
      }
      if (platform === "qqmusic") {
        const cookie = await openQQMusicLoginWindow();
        if (!cookie) return { ok: false, error: "canceled" };
        setQQMusicCookie(cookie);
        clearQQMusicCache();
        return { ok: true };
      }
      if (platform === "bilibili") {
        const cookie = await openBilibiliLoginWindow();
        if (!cookie) return { ok: false, error: "canceled" };
        setBilibiliCookie(cookie);
        return { ok: true };
      }
      if (platform === "spotify") {
        const { openSpotifyBrowserLoginWindow } = await import("@main/window/spotifyBrowserLogin");
        const cookie = await openSpotifyBrowserLoginWindow();
        if (!cookie) return { ok: false, error: "canceled" };
        setSpotifyBrowserCookie(cookie);
        clearTokenCache();
        clearSpotifyCache();
        const exchanged = await exchangeBrowserCookieForToken(cookie);
        if (!exchanged) return { ok: false, error: "cookie exchange failed" };
        return { ok: true };
      }
      return { ok: false, error: "unsupported platform" };
    } catch (err) {
      coreLog.warn("[apis] openLoginWeb failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 手动写入 cookie 登录
  ipcMain.handle("apis:setCookie", (_evt, platform: ApiPlatform, raw: string) => {
    if (platform === "netease") {
      const parsed = cookieToJson(raw);
      if (!parsed.MUSIC_U) return { ok: false, error: "missing MUSIC_U" };
      mergeNeteaseCookies(parsed);
      return { ok: true };
    }
    if (platform === "qqmusic") {
      if (!raw || !raw.includes("uin=")) return { ok: false, error: "missing uin" };
      setQQMusicCookie(raw);
      clearQQMusicCache();
      return { ok: true };
    }
    if (platform === "kugou") {
      if (!raw) return { ok: false, error: "empty cookie" };
      setKugouCookie(raw);
      clearKugouCache();
      return { ok: true };
    }
    if (platform === "bilibili") {
      if (!raw || !raw.includes("SESSDATA")) return { ok: false, error: "missing SESSDATA" };
      setBilibiliCookie(raw);
      return { ok: true };
    }
    return { ok: false, error: "unsupported platform" };
  });

  // QQ 音乐登录态专用 IPC
  ipcMain.handle("qqmusic:login", async () => {
    try {
      const cookie = await openQQMusicLoginWindow();
      if (!cookie) return { ok: false, error: "canceled" };
      setQQMusicCookie(cookie);
      clearQQMusicCache();
      const profile = await fetchQQMusicLoginStatus();
      return { ok: true, profile };
    } catch (err) {
      coreLog.warn("[qqmusic] login failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("qqmusic:logout", () => {
    clearQQMusicCookie();
    clearQQMusicCache();
    return { ok: true };
  });

  ipcMain.handle("qqmusic:fetchStatus", async () => {
    try {
      const profile = await fetchQQMusicLoginStatus();
      return { ok: true, profile };
    } catch (err) {
      coreLog.warn("[qqmusic] fetch status failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Spotify 用户登录态专用 IPC
  ipcMain.handle("spotify:login", async () => {
    try {
      const { openSpotifyBrowserLoginWindow } = await import("@main/window/spotifyBrowserLogin");
      const cookie = await openSpotifyBrowserLoginWindow();
      if (!cookie) return { ok: false, error: "登录失败或已取消" };

      setSpotifyBrowserCookie(cookie);
      clearTokenCache();
      clearSpotifyCache();
      const exchanged = await exchangeBrowserCookieForToken(cookie);
      if (!exchanged) return { ok: false, error: "cookie 换取 token 失败" };

      const profile = await getSpotifyUserProfile(exchanged.accessToken);
      if (!profile) return { ok: false, error: "获取用户资料失败" };
      return { ok: true, profile };
    } catch (err) {
      coreLog.warn("[spotify] login failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("spotify:logout", () => {
    logoutSpotify();
    clearTokenCache();
    clearSpotifyCache();
    return { ok: true };
  });

  ipcMain.handle("spotify:fetchStatus", async () => {
    try {
      const token = await getUserAccessToken();
      if (!token) return { ok: true, loggedIn: false };
      const profile = await getSpotifyUserProfile(token);
      return { ok: true, loggedIn: !!profile, profile };
    } catch (err) {
      coreLog.warn("[spotify] fetch status failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 酷狗登录态专用 IPC
  ipcMain.handle("kugou:fetchStatus", async () => {
    try {
      const profile = await fetchKugouLoginStatus();
      return { ok: true, profile };
    } catch (err) {
      coreLog.warn("[kugou] fetch status failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("kugou:logout", () => {
    clearKugouCookie();
    clearKugouCache();
    return { ok: true };
  });

  // Bilibili 登录态专用 IPC
  ipcMain.handle("bilibili:fetchStatus", async () => {
    try {
      const profile = await fetchBilibiliLoginStatus();
      return { ok: true, profile };
    } catch (err) {
      coreLog.warn("[bilibili] fetch status failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("bilibili:logout", () => {
    clearBilibiliCookie();
    return { ok: true };
  });

  // Bilibili 二维码登录
  ipcMain.handle("bilibili:qrKey", async () => {
    try {
      const result = await generateQrKey();
      return { ok: true, key: result.key, url: result.url };
    } catch (err) {
      coreLog.warn("[bilibili] qr key failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("bilibili:qrCheck", async (_evt, key: string) => {
    try {
      const result = await pollQrStatus(key);
      return { ok: true, ...result };
    } catch (err) {
      coreLog.warn("[bilibili] qr check failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Bilibili 密码登录
  ipcMain.handle("bilibili:pwdLogin", async (_evt, username: string, password: string) => {
    try {
      const result = await loginWithPassword(username, password);
      if (result.success && result.cookie) {
        setBilibiliCookie(result.cookie);
      }
      return { ok: true, ...result };
    } catch (err) {
      coreLog.warn("[bilibili] pwd login failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  const BILIBILI_PROXY_PATHS = new Set([
    "/x/web-interface/search/type",
    "/x/web-interface/view",
    "/x/player/playurl",
    "/x/passport-login/web/qrcode/generate",
    "/x/passport-login/web/qrcode/poll",
  ]);
  const BILIBILI_PROXY_HEADERS: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: "https://www.bilibili.com/",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  ipcMain.handle("bilibili:proxy", async (_evt, path: string, query: string) => {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    if (!BILIBILI_PROXY_PATHS.has(normalizedPath)) {
      return { ok: false, error: "path not allowed" };
    }
    try {
      const engine = (await import("@main/services/engine")).getEngine();
      const host = normalizedPath.startsWith("/x/passport-login")
        ? "https://passport.bilibili.com"
        : "https://api.bilibili.com";
      const url = `${host}${normalizedPath}${query}`;
      const cookie = await getBilibiliProxyCookie();
      const headers = { ...BILIBILI_PROXY_HEADERS, ...(cookie ? { Cookie: cookie } : {}) };
      const res = await engine.httpGet(url, headers);
      return JSON.parse(res.body);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
};
