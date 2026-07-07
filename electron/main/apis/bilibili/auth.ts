/**
 * Bilibili Cookie 管理与登录
 */

import { store } from "@main/store";
import { coreLog } from "@main/utils/logger";
import { decryptSecureText, encryptSecureText, isSecureText } from "@main/utils/secureText";

export const setBilibiliCookie = (cookie: string): void => {
  store.set("bilibili.cookie", cookie ? encryptSecureText(cookie) : "");
};

export const getBilibiliCookie = (): string => {
  const stored = store.get("bilibili.cookie") ?? "";
  const cookie = decryptSecureText(stored);
  if (cookie && !isSecureText(stored)) setBilibiliCookie(cookie);
  return cookie;
};

export const clearBilibiliCookie = (): void => {
  store.set("bilibili.cookie", "");
};

const splitSetCookieHeader = (cookieHeader: string): string[] =>
  cookieHeader
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);

const normalizeSetCookie = (setCookies: string[]): string | undefined => {
  const cookieParts = setCookies
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie));
  return cookieParts.length > 0 ? cookieParts.join("; ") : undefined;
};

const extractCookieFromHeaders = (headers: Headers): string | undefined => {
  let setCookies: string[] = [];
  try {
    setCookies = headers.getSetCookie();
  } catch {
    setCookies = [];
  }

  const cookie = normalizeSetCookie(setCookies);
  if (cookie) return cookie;

  const rawCookie = headers.get("set-cookie");
  if (!rawCookie) return undefined;
  return normalizeSetCookie(splitSetCookieHeader(rawCookie));
};

const extractCookieFromLoginUrl = (loginUrl?: string): string | undefined => {
  if (!loginUrl) return undefined;
  const queryStart = loginUrl.indexOf("?");
  if (queryStart < 0) return undefined;
  const query = loginUrl.slice(queryStart + 1).split("#")[0];
  if (!query.includes("SESSDATA=")) return undefined;
  return query.replaceAll("&", "; ").replaceAll(",", "%2C");
};

/** 验证 cookie 并取当前用户信息 */
export const fetchBilibiliLoginStatus = async (): Promise<{
  userId: number;
  nickname: string;
  avatarUrl?: string;
} | null> => {
  const cookie = getBilibiliCookie();
  if (!cookie) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    const data = (await res.json()) as {
      code?: number;
      data?: { isLogin?: boolean; mid?: number; uname?: string; face?: string };
    };
    if (data?.code !== 0 || data.data?.isLogin === false || !data.data?.mid) return null;
    return {
      userId: data.data.mid,
      nickname: data.data.uname ?? "",
      avatarUrl: data.data.face,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Bilibili 二维码状态码 */
export type BiliQrCode = 0 | 86038 | 86090 | 86101;

/** 二维码登录轮询结果 */
export interface BiliQrPollResult {
  code: BiliQrCode;
  message: string;
  cookie?: string;
  url?: string;
}

/**
 * 获取二维码登录 key 和确认 URL
 * @returns 二维码 key 和确认 URL
 */
export const generateQrKey = async (): Promise<{ key: string; url: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(
      "https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header",
      {
        headers: { Referer: "https://passport.bilibili.com" },
        signal: controller.signal,
      },
    );
    const data = (await res.json()) as {
      code?: number;
      data?: { qrcode_key?: string; url?: string };
    };
    if (data?.code !== 0 || !data.data?.qrcode_key || !data.data?.url) {
      throw new Error("获取二维码失败");
    }
    return { key: data.data.qrcode_key, url: data.data.url };
  } catch (err) {
    coreLog.error("[bilibili] generate qr key failed:", err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 轮询二维码扫码状态
 * @param key 二维码 key
 * @returns 扫码状态和 cookie（登录成功时）
 */
export const pollQrStatus = async (key: string): Promise<BiliQrPollResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`,
      { signal: controller.signal },
    );
    const data = (await res.json()) as {
      code?: number;
      data?: { code?: number; message?: string; url?: string; refresh_token?: string };
      message?: string;
    };
    const code = (data?.data?.code ?? 86101) as BiliQrCode;
    const message = data?.data?.message ?? data?.message ?? "未知状态";

    let cookie: string | undefined;
    if (code === 0) {
      cookie = extractCookieFromHeaders(res.headers);
      cookie ??= extractCookieFromLoginUrl(data?.data?.url);

      if (!cookie && data?.data?.url) {
        try {
          const confirmRes = await fetch(data.data.url, {
            headers: {
              Referer: "https://passport.bilibili.com",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(10000),
          });
          cookie = extractCookieFromHeaders(confirmRes.headers);
        } catch (confirmErr) {
          coreLog.warn("[bilibili] extract cookie from confirm url failed:", confirmErr);
        }
      }
    }

    return { code, message, cookie, url: data?.data?.url };
  } catch (err) {
    coreLog.error("[bilibili] poll qr status failed:", err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

/** 密码登录结果 */
export interface BiliPwdResult {
  success: boolean;
  cookie?: string;
  message?: string;
  needCaptcha?: boolean;
  needVerify?: boolean;
}

/**
 * 使用密码登录 Bilibili
 * @param username 用户名（手机号或邮箱）
 * @param password 密码
 * @returns 登录结果
 */
export const loginWithPassword = async (
  username: string,
  password: string,
): Promise<BiliPwdResult> => {
  try {
    // 1. 获取 RSA key
    const keyRes = await fetch("https://passport.bilibili.com/x/passport-login/web/key", {
      signal: AbortSignal.timeout(10000),
    });
    const keyData = (await keyRes.json()) as {
      code?: number;
      data?: { hash?: string; key?: string };
    };
    if (keyData?.code !== 0 || !keyData.data?.hash || !keyData.data?.key) {
      return { success: false, message: "获取加密 key 失败" };
    }

    const { hash, key } = keyData.data;

    // 2. 使用 RSA 加密密码
    const { publicEncrypt } = await import("crypto");
    const encrypted = publicEncrypt(
      {
        key,
        padding: 1, // RSA_PKCS1_PADDING
      },
      Buffer.from(hash + password),
    );
    const encodedPassword = encrypted.toString("base64");

    // 3. 发送登录请求
    const formData = new URLSearchParams();
    formData.append("username", username);
    formData.append("password", encodedPassword);
    formData.append("keep", "1");

    const loginRes = await fetch("https://passport.bilibili.com/x/passport-login/web/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://www.bilibili.com",
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(15000),
    });

    const cookie = extractCookieFromHeaders(loginRes.headers);

    const loginData = (await loginRes.json()) as {
      code?: number;
      data?: { status?: number; message?: string; url?: string; token_info?: unknown };
      message?: string;
    };

    if (loginData?.code === 0) {
      return { success: true, cookie };
    }

    // 需要验证码
    if (loginData?.code === -105) {
      return { success: false, needCaptcha: true, message: loginData?.message ?? "需要验证码" };
    }

    // 需要验证（异地登录等）
    if (loginData?.data?.status === 2) {
      return { success: false, needVerify: true, message: loginData?.message ?? "需要验证" };
    }

    return { success: false, message: loginData?.message ?? "登录失败" };
  } catch (err) {
    coreLog.error("[bilibili] password login failed:", err);
    return { success: false, message: err instanceof Error ? err.message : "登录失败" };
  }
};
