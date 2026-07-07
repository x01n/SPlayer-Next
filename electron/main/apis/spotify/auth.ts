/**
 * Spotify 认证模块
 *
 * 支持两种模式：
 * 1. Client Credentials Flow（应用级别，用于搜索等公开接口）
 * 2. Authorization Code + PKCE（用户级别，用于访问用户私有数据）
 */

import { store } from "@main/store";
import { coreLog } from "@main/utils/logger";
import { decryptSecureText, encryptSecureText, isSecureText } from "@main/utils/secureText";
import { randomBytes, createHash } from "node:crypto";

interface TokenCache {
  accessToken: string;
  expireAt: number;
}

interface UserTokenCache {
  accessToken: string;
  refreshToken: string;
  expireAt: number;
}

let tokenCache: TokenCache | null = null;
let fetchingPromise: Promise<string | null> | null = null;

let userTokenCache: UserTokenCache | null = null;
let userFetchingPromise: Promise<string | null> | null = null;
let userTokenGeneration = 0;

interface BrowserTokenCache {
  accessToken: string;
  expireAt: number;
}

let browserTokenCache: BrowserTokenCache | null = null;

/** Spotify OAuth 授权地址 */
const AUTH_URL = "https://accounts.spotify.com/authorize";
/** Spotify Token 交换地址 */
const TOKEN_URL = "https://accounts.spotify.com/api/token";
/** 本地回调地址 */
const REDIRECT_URI = "http://localhost/callback";
/** 请求权限范围 */
const SCOPES = "user-read-private user-read-email playlist-read-private user-library-read";

/**
 * 生成 PKCE code_verifier
 * @returns 随机 43+ 字符的 verifier
 */
const generateCodeVerifier = (): string => randomBytes(32).toString("base64url");

/**
 * 生成 PKCE code_challenge (S256)
 * @param verifier - code_verifier
 * @returns code_challenge
 */
const generateCodeChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/**
 * 获取 Spotify access token（Client Credentials Flow）
 * @returns access token 或 null（未配置 clientId / clientSecret）
 */
export const getAccessToken = async (): Promise<string | null> => {
  if (tokenCache && tokenCache.expireAt > Date.now()) {
    return tokenCache.accessToken;
  }
  if (fetchingPromise) return fetchingPromise;

  fetchingPromise = (async (): Promise<string | null> => {
    try {
      const clientId = store.get("spotify.clientId");
      const clientSecret = store.get("spotify.clientSecret");
      if (!clientId || !clientSecret) {
        coreLog.warn("[spotify] clientId / clientSecret 未配置，跳过认证");
        return null;
      }

      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const text = await res.text();
        coreLog.warn(`[spotify] token 请求失败: ${res.status} ${text}`);
        return null;
      }

      const data = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!data.access_token) {
        coreLog.warn("[spotify] token 响应缺少 access_token");
        return null;
      }

      // 提前 60 秒过期，避免边界
      const expireAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
      tokenCache = { accessToken: data.access_token, expireAt };
      return data.access_token;
    } catch (err) {
      coreLog.warn("[spotify] 获取 token 失败:", err);
      return null;
    } finally {
      fetchingPromise = null;
    }
  })();

  return fetchingPromise;
};

/** 清空 token 缓存（配置变更后调用） */
export const clearTokenCache = (): void => {
  tokenCache = null;
  fetchingPromise = null;
};

/**
 * 从 store 读取用户 token
 * @returns 用户 token 缓存或 null
 */
const readUserTokenFromStore = (): UserTokenCache | null => {
  const storedAccessToken = store.get("spotify.userAccessToken") ?? "";
  const storedRefreshToken = store.get("spotify.userRefreshToken") ?? "";
  const accessToken = decryptSecureText(storedAccessToken);
  const refreshToken = decryptSecureText(storedRefreshToken);
  const expireAt = store.get("spotify.userTokenExpireAt");
  if (!accessToken || !refreshToken || !expireAt) return null;

  const cache = { accessToken, refreshToken, expireAt };
  if (!isSecureText(storedAccessToken) || !isSecureText(storedRefreshToken)) {
    writeUserTokenToStore(cache);
  }
  return cache;
};

/**
 * 写入用户 token 到 store
 * @param cache - 用户 token 缓存
 */
const writeUserTokenToStore = (cache: UserTokenCache): void => {
  store.set("spotify.userAccessToken", encryptSecureText(cache.accessToken));
  store.set("spotify.userRefreshToken", encryptSecureText(cache.refreshToken));
  store.set("spotify.userTokenExpireAt", cache.expireAt);
};

/**
 * 用 refresh_token 换取新 access_token
 * @param refreshToken - refresh token
 * @returns 新 token 缓存或 null
 */
const doRefreshToken = async (refreshToken: string): Promise<UserTokenCache | null> => {
  const clientId = store.get("spotify.clientId");
  if (!clientId) {
    coreLog.warn("[spotify] clientId 未配置，无法刷新 token");
    return null;
  }

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text();
      coreLog.warn(`[spotify] 刷新 token 失败: ${res.status} ${text}`);
      return null;
    }

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      coreLog.warn("[spotify] 刷新 token 响应缺少 access_token");
      return null;
    }

    const expireAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expireAt,
    };
  } catch (err) {
    coreLog.warn("[spotify] 刷新 token 失败:", err);
    return null;
  }
};

/**
 * 获取 Spotify 用户 access token（自动 refresh）
 * @returns access token 或 null
 */
export const getUserAccessToken = async (): Promise<string | null> => {
  if (userFetchingPromise) return userFetchingPromise;

  const generation = userTokenGeneration;
  userFetchingPromise = (async (): Promise<string | null> => {
    if (generation !== userTokenGeneration) return null;

    if (userTokenCache && userTokenCache.expireAt > Date.now()) {
      return userTokenCache.accessToken;
    }

    const stored = readUserTokenFromStore();
    if (stored && stored.expireAt > Date.now()) {
      if (generation !== userTokenGeneration) return null;
      userTokenCache = stored;
      return stored.accessToken;
    }

    if (stored?.refreshToken) {
      const refreshed = await doRefreshToken(stored.refreshToken);
      if (refreshed) {
        if (generation !== userTokenGeneration) return null;
        userTokenCache = refreshed;
        writeUserTokenToStore(refreshed);
        return refreshed.accessToken;
      }
    }

    if (browserTokenCache && browserTokenCache.expireAt > Date.now()) {
      return browserTokenCache.accessToken;
    }

    const browserCookie = getSpotifyBrowserCookie();
    if (browserCookie) {
      const exchanged = await exchangeBrowserCookieForToken(browserCookie);
      if (exchanged) {
        if (generation !== userTokenGeneration) return null;
        browserTokenCache = exchanged;
        return exchanged.accessToken;
      }
    }

    return null;
  })().finally(() => {
    if (generation === userTokenGeneration) userFetchingPromise = null;
  });

  return userFetchingPromise;
};

/**
 * 启动 Spotify OAuth 登录
 * @returns 登录成功返回 token 缓存；失败或取消返回 null
 */
export const startSpotifyLogin = async (): Promise<UserTokenCache | null> => {
  const generation = userTokenGeneration;
  const clientId = store.get("spotify.clientId");
  if (!clientId) {
    coreLog.warn("[spotify] clientId 未配置，无法启动登录");
    return null;
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const authUrl =
    `${AUTH_URL}?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&code_challenge_method=S256` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&scope=${encodeURIComponent(SCOPES)}`;

  const { openSpotifyLoginWindow } = await import("@main/window/spotifyLogin");
  const code = await openSpotifyLoginWindow(authUrl);
  if (!code) {
    coreLog.warn("[spotify] 登录窗口未返回 code");
    return null;
  }
  if (generation !== userTokenGeneration) return null;

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text();
      coreLog.warn(`[spotify] 换取 token 失败: ${res.status} ${text}`);
      return null;
    }

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token || !data.refresh_token) {
      coreLog.warn("[spotify] 换取 token 响应缺少字段");
      return null;
    }

    if (generation !== userTokenGeneration) return null;
    const expireAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
    const cache: UserTokenCache = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expireAt,
    };
    userTokenCache = cache;
    writeUserTokenToStore(cache);
    userFetchingPromise = null;
    return cache;
  } catch (err) {
    coreLog.warn("[spotify] 换取 token 失败:", err);
    return null;
  }
};

/** Spotify 用户资料原始响应 */
export interface SpotifyUserProfileRaw {
  id: string;
  display_name: string | null;
  email?: string;
  images?: Array<{ url: string }>;
}

/**
 * 获取 Spotify 用户资料
 * @param token - access token
 * @returns 用户资料或 null
 */
export const getSpotifyUserProfile = async (
  token: string,
): Promise<SpotifyUserProfileRaw | null> => {
  try {
    const res = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      coreLog.warn(`[spotify] 获取用户资料失败: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as SpotifyUserProfileRaw;
    return data;
  } catch (err) {
    coreLog.warn("[spotify] 获取用户资料失败:", err);
    return null;
  }
};

/**
 * 登出 Spotify（清除用户 token）
 */
export const logoutSpotify = (): void => {
  clearUserTokenCache();
  store.set("spotify.userAccessToken", "");
  store.set("spotify.userRefreshToken", "");
  store.set("spotify.userTokenExpireAt", 0);
  clearSpotifyBrowserCookie();
};

/** 清空用户 token 缓存（配置变更后调用） */
export const clearUserTokenCache = (): void => {
  userTokenGeneration += 1;
  userTokenCache = null;
  userFetchingPromise = null;
  browserTokenCache = null;
};

/** 写入浏览器登录 cookie 到 store */
export const setSpotifyBrowserCookie = (cookie: string): void => {
  store.set("spotify.browserCookie", encryptSecureText(cookie));
};

/** 从 store 读取浏览器登录 cookie */
export const getSpotifyBrowserCookie = (): string | null => {
  const stored = (store.get("spotify.browserCookie") as string | null) ?? null;
  if (!stored) return null;
  const cookie = decryptSecureText(stored);
  if (cookie && !isSecureText(stored)) setSpotifyBrowserCookie(cookie);
  return cookie;
};

/** 清空浏览器登录 cookie */
export const clearSpotifyBrowserCookie = (): void => {
  store.set("spotify.browserCookie", "");
};

/**
 * 使用 sp_dc cookie 换取 access token
 * @param cookie - cookie 字符串
 * @returns token 缓存或 null
 */
export const exchangeBrowserCookieForToken = async (
  cookie: string,
): Promise<BrowserTokenCache | null> => {
  try {
    const res = await fetch(
      "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
      {
        headers: {
          Cookie: cookie,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!res.ok) {
      coreLog.warn(`[spotify] cookie exchange failed: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      accessToken?: string;
      accessTokenExpirationTimestampMs?: number;
    };

    if (!data.accessToken) {
      coreLog.warn("[spotify] cookie exchange response missing accessToken");
      return null;
    }

    const expireAt = data.accessTokenExpirationTimestampMs ?? Date.now() + 3600_000;
    return { accessToken: data.accessToken, expireAt };
  } catch (err) {
    coreLog.warn("[spotify] exchange browser cookie failed:", err);
    return null;
  }
};
