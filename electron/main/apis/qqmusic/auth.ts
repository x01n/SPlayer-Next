/**
 * QQ 音乐登录态管理
 *
 * 通过 Cookie 登录：打开 QQ 音乐网页版登录窗口，用户登录成功后读取 cookie 持久化。
 * 保存的 cookie 在 callQQMusic 请求时自动注入请求头，使 VIP 音质等权限生效。
 */

import { store } from "@main/store";
import { coreLog } from "@main/utils/logger";
import { decryptSecureText, encryptSecureText, isSecureText } from "@main/utils/secureText";

/** QQ 音乐用户资料 */
export interface QQMusicProfile {
  /** QQ 号 */
  userId: string;
  /** 昵称 */
  nickname: string;
  /** 头像 URL */
  avatarUrl?: string;
}

/** 从 store 读取 cookie */
export const getQQMusicCookie = (): string | null => {
  const stored = (store.get("qqmusic.cookie") as string | null) ?? null;
  if (!stored) return null;
  const cookie = decryptSecureText(stored);
  if (cookie && !isSecureText(stored)) setQQMusicCookie(cookie);
  return cookie;
};

/**
 * 从 cookie 字符串中提取 uin（QQ 号）
 * @param cookie cookie 字符串
 * @returns QQ 号，未找到返回 null
 */
const extractUinFromCookie = (cookie: string): string | null => {
  const match = cookie.match(/(?:^|;)\s*uin\s*=\s*o?([\d]+)/);
  if (match) return match[1];
  // 部分场景 uin 以 o 开头（如 o123456789），去掉前缀
  const match2 = cookie.match(/(?:^|;)\s*uin\s*=\s*([^;]+)/);
  if (match2) {
    const v = match2[1].trim();
    return v.replace(/^o/, "");
  }
  return null;
};

/**
 * 计算 g_tk（QQ 空间/音乐常用校验值）
 * @param skey p_skey 或 skey
 * @returns g_tk 值
 */
const computeGtk = (skey: string): number => {
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) {
    hash += (hash << 5) + skey.charCodeAt(i);
  }
  return hash & 0x7fffffff;
};

/**
 * 从 cookie 字符串中提取指定字段
 * @param cookie cookie 字符串
 * @param name 字段名
 * @returns 字段值，未找到返回 null
 */
const extractCookieValue = (cookie: string, name: string): string | null => {
  const match = cookie.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;]+)`));
  return match ? match[1].trim() : null;
};

/**
 * 写入 cookie 到 store
 * @param cookie cookie 字符串或 null
 */
export const setQQMusicCookie = (cookie: string | null): void => {
  store.set("qqmusic.cookie", cookie ? encryptSecureText(cookie) : null);
};

/** 清空 QQ 音乐登录态 */
export const clearQQMusicCookie = (): void => {
  store.set("qqmusic.cookie", null);
};

/**
 * 调用 QQ 音乐个人主页接口验证登录态并获取用户信息
 * @returns 登录成功返回用户资料；未登录或失效返回 null
 */
export const fetchQQMusicLoginStatus = async (): Promise<QQMusicProfile | null> => {
  const cookie = getQQMusicCookie();
  if (!cookie) return null;

  const uin = extractUinFromCookie(cookie);
  if (!uin) {
    clearQQMusicCookie();
    return null;
  }

  try {
    const pSkey = extractCookieValue(cookie, "p_skey");
    const skey = extractCookieValue(cookie, "skey");
    const gtk = pSkey ? computeGtk(pSkey) : skey ? computeGtk(skey) : "";

    const url = new URL("https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg");
    url.searchParams.set("cid", "205360838");
    url.searchParams.set("reqtype", "1");
    url.searchParams.set("userid", uin);
    if (gtk) url.searchParams.set("g_tk", String(gtk));

    const res = await fetch(url.toString(), {
      headers: {
        Cookie: cookie,
        Referer: "https://y.qq.com",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10000),
    });

    const data = (await res.json()) as {
      code?: number;
      data?: { creator?: { nick?: string; headpic?: string; uin?: string } };
    };

    if (data.code === 0 && data.data?.creator) {
      const creator = data.data.creator;
      return {
        userId: String(creator.uin || uin),
        nickname: creator.nick ?? "",
        avatarUrl: creator.headpic ?? undefined,
      };
    }

    clearQQMusicCookie();
    return null;
  } catch (err) {
    coreLog.warn("[qqmusic] fetch login status failed:", err);
    return {
      userId: uin,
      nickname: "",
      avatarUrl: undefined,
    };
  }
};
