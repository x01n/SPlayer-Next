/**
 * 酷狗 Cookie 管理
 *
 * 酷狗公开 API 无需鉴权，但登录后可获取个性化内容。
 * 此处仅做 Cookie 存储与携带。
 */

import { store } from "@main/store";
import { decryptSecureText, encryptSecureText, isSecureText } from "@main/utils/secureText";

export const setKugouCookie = (cookie: string): void => {
  store.set("kugou.cookie", cookie ? encryptSecureText(cookie) : "");
};

export const getKugouCookie = (): string => {
  const stored = store.get("kugou.cookie") ?? "";
  const cookie = decryptSecureText(stored);
  if (cookie && !isSecureText(stored)) setKugouCookie(cookie);
  return cookie;
};

export const clearKugouCookie = (): void => {
  store.set("kugou.cookie", "");
};

/** 验证 cookie 是否有效（酷狗无标准用户 API，仅检查存在性） */
export const fetchKugouLoginStatus = async (): Promise<{
  userId: string;
  nickname: string;
  avatarUrl?: string;
} | null> => {
  const cookie = getKugouCookie();
  if (!cookie) return null;
  // 酷狗无标准用户资料 API，仅返回占位信息
  return { userId: "kugou", nickname: "酷狗用户" };
};
