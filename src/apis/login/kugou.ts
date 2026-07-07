/**
 * 酷狗登录封装
 */

import type { ApiCallResponse } from "@shared/types/apis";

/**
 * 使用 Cookie 登录酷狗
 * @param cookie - Cookie 字符串
 */
export const loginKugou = async (cookie: string): Promise<boolean> => {
  const res: ApiCallResponse = await window.api.apis.setCookie("kugou", cookie);
  return res.ok;
};

/**
 * 获取酷狗登录状态
 */
export const fetchKugouLoginStatus = async (): Promise<{
  userId: string;
  nickname: string;
  avatarUrl?: string;
} | null> => {
  const res = await window.api.kugou.getStatus();
  if (!res.ok) return null;
  return res.profile ?? null;
};

/**
 * 退出酷狗登录
 */
export const logoutKugou = async (): Promise<void> => {
  await window.api.kugou.logout();
};
