/**
 * Spotify 认证模块（Client Credentials Flow）
 *
 * 从设置读取 spotify.clientId / spotify.clientSecret，
 * 获取 access token 并缓存至过期。
 */

import { store } from "@main/store";
import { coreLog } from "@main/utils/logger";

interface TokenCache {
  accessToken: string;
  expireAt: number;
}

let tokenCache: TokenCache | null = null;
let fetchingPromise: Promise<string | null> | null = null;

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
      const clientId = (store.get as any)("spotify.clientId") as string | undefined;
      const clientSecret = (store.get as any)("spotify.clientSecret") as string | undefined;
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
};
