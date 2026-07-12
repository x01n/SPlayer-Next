/**
 * Bilibili Cookie 管理与登录
 * 所有 HTTP 请求通过 Rust 原生模块代理，绕过 CORS 限制
 */

import { store } from "@main/store";
import { coreLog } from "@main/utils/logger";
import { decryptSecureText, encryptSecureText, isSecureText } from "@main/utils/secureText";

const getRustHttp = async () => (await import("@main/services/engine")).getEngine();

const BILIBILI_ANON_COOKIE_TTL = 30 * 60 * 1000;
let anonCookie = "";
let anonCookieExpireAt = 0;

const BILIBILI_PROXY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * 获取 Bilibili 匿名 Cookie（从首页 buvid3 提取，30 分钟缓存）
 * @returns Cookie 字符串
 */
export const getBilibiliAnonymousCookie = async (): Promise<string> => {
  if (anonCookie && Date.now() < anonCookieExpireAt) return anonCookie;
  try {
    const engine = await getRustHttp();
    const res = await engine.httpGet("https://www.bilibili.com/", {
      "User-Agent": BILIBILI_PROXY_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: "https://www.bilibili.com/",
    });
    const setCookies = res.headers
      .filter((h: string[]) => h[0].toLowerCase() === "set-cookie")
      .map((h: string[]) => h[1].split(";")[0]?.trim())
      .filter(Boolean);
    if (setCookies.length > 0) {
      const unique = [...new Set(setCookies)];
      anonCookie = unique.join("; ");
      anonCookieExpireAt = Date.now() + BILIBILI_ANON_COOKIE_TTL;
    }
  } catch {
    /* 网络异常时沿用旧缓存 */
  }
  return anonCookie;
};

/**
 * 获取 Bilibili 代理请求用的 Cookie
 * 登录 Cookie 和匿名反爬 Cookie 合并，搜索等接口需要两者同时存在
 * @returns Cookie 字符串
 */
export const getBilibiliProxyCookie = async (): Promise<string> => {
  const parts: string[] = [];
  const login = getBilibiliCookie();
  if (login) parts.push(login);
  const anon = await getBilibiliAnonymousCookie();
  if (anon) parts.push(anon);
  return parts.join("; ");
};

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

const normalizeSetCookie = (setCookies: string[]): string | undefined => {
  const cookieParts = setCookies
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie));
  return cookieParts.length > 0 ? cookieParts.join("; ") : undefined;
};

/** 从 Rust HTTP 响应头中提取 Set-Cookie */
const extractCookieFromRustHeaders = (headers: string[][]): string | undefined => {
  const setCookies = headers
    .filter(([name]) => name.toLowerCase() === "set-cookie")
    .map(([, value]) => value);
  return normalizeSetCookie(setCookies);
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
  try {
    const engine = await getRustHttp();
    const res = await engine.httpGet("https://api.bilibili.com/x/web-interface/nav", {
      Cookie: cookie,
      Referer: "https://www.bilibili.com/",
    });
    const data = JSON.parse(res.body) as {
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
  try {
    const engine = await getRustHttp();
    const res = await engine.httpGet(
      "https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header",
      { Referer: "https://passport.bilibili.com" },
    );
    const data = JSON.parse(res.body) as {
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
  }
};

/**
 * 轮询二维码扫码状态
 * @param key 二维码 key
 * @returns 扫码状态和 cookie（登录成功时）
 */
export const pollQrStatus = async (key: string): Promise<BiliQrPollResult> => {
  try {
    const engine = await getRustHttp();
    const res = await engine.httpGet(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`,
      { Referer: "https://passport.bilibili.com" },
    );
    const data = JSON.parse(res.body) as {
      code?: number;
      data?: { code?: number; message?: string; url?: string; refresh_token?: string };
      message?: string;
    };
    const code = (data?.data?.code ?? 86101) as BiliQrCode;
    const message = data?.data?.message ?? data?.message ?? "未知状态";

    let cookie: string | undefined;
    if (code === 0) {
      cookie = extractCookieFromRustHeaders(res.headers);
      cookie ??= extractCookieFromLoginUrl(data?.data?.url);

      if (!cookie && data?.data?.url) {
        try {
          const confirmRes = await engine.httpGet(data.data.url, {
            Referer: "https://passport.bilibili.com",
          });
          cookie = extractCookieFromRustHeaders(confirmRes.headers);
        } catch (confirmErr) {
          coreLog.warn("[bilibili] extract cookie from confirm url failed:", confirmErr);
        }
      }
    }

    return { code, message, cookie, url: data?.data?.url };
  } catch (err) {
    coreLog.error("[bilibili] poll qr status failed:", err);
    throw err;
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
    const engine = await getRustHttp();

    const keyRes = await engine.httpGet(
      "https://passport.bilibili.com/x/passport-login/web/key",
      { Referer: "https://passport.bilibili.com" },
    );
    const keyData = JSON.parse(keyRes.body) as {
      code?: number;
      data?: { hash?: string; key?: string };
    };
    if (keyData?.code !== 0 || !keyData.data?.hash || !keyData.data?.key) {
      return { success: false, message: "获取加密 key 失败" };
    }

    const { hash, key } = keyData.data;

    const { publicEncrypt } = await import("crypto");
    const encrypted = publicEncrypt(
      { key, padding: 1 },
      Buffer.from(hash + password),
    );
    const encodedPassword = encrypted.toString("base64");

    const formData = new URLSearchParams();
    formData.append("username", username);
    formData.append("password", encodedPassword);
    formData.append("keep", "1");

    const loginRes = await engine.httpPost(
      "https://passport.bilibili.com/x/passport-login/web/login",
      {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://www.bilibili.com",
      },
      formData.toString(),
    );

    const cookie = extractCookieFromRustHeaders(loginRes.headers);

    const loginData = JSON.parse(loginRes.body) as {
      code?: number;
      data?: { status?: number; message?: string; url?: string; token_info?: unknown };
      message?: string;
    };

    if (loginData?.code === 0) {
      return { success: true, cookie };
    }
    if (loginData?.code === -105) {
      return { success: false, needCaptcha: true, message: loginData?.message ?? "需要验证码" };
    }
    if (loginData?.data?.status === 2) {
      return { success: false, needVerify: true, message: loginData?.message ?? "需要验证" };
    }
    return { success: false, message: loginData?.message ?? "登录失败" };
  } catch (err) {
    coreLog.error("[bilibili] password login failed:", err);
    return { success: false, message: err instanceof Error ? err.message : "登录失败" };
  }
};
