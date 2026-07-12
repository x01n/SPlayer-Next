/**
 * Bilibili 登录封装
 */

import type { ApiCallResponse } from "@shared/types/apis";
import { setBilibiliLoginState } from "@/apis/bilibili";

/** Bilibili 二维码状态码 */
export type BiliQrStatusCode = 0 | 86038 | 86090 | 86101;

export interface BiliQrCheckResult {
  code: BiliQrStatusCode;
  message: string;
  cookie?: string;
  url?: string;
}

export interface BiliPwdResult {
  success: boolean;
  cookie?: string;
  message?: string;
  needCaptcha?: boolean;
  needVerify?: boolean;
}

/**
 * 使用 Cookie 登录 Bilibili
 * @param cookie - Cookie 字符串（需包含 SESSDATA）
 */
export const loginBilibili = async (cookie: string): Promise<boolean> => {
  const res: ApiCallResponse = await window.api.apis.setCookie("bilibili", cookie);
  return res.ok;
};

/**
 * 通过浏览器窗口登录 Bilibili
 * @returns 登录成功返回 true
 */
export const loginBilibiliByBrowser = async (): Promise<boolean> => {
  const res: ApiCallResponse = await window.api.apis.openLoginWeb("bilibili");
  return res.ok;
};

/**
 * 获取 Bilibili 登录状态
 */
export const fetchBilibiliLoginStatus = async (): Promise<{
  userId: number;
  nickname: string;
  avatarUrl?: string;
} | null> => {
  const res = await window.api.bilibili.getStatus();
  const profile = res.ok ? (res.profile ?? null) : null;
  setBilibiliLoginState(profile !== null);
  return profile;
};

/**
 * 退出 Bilibili 登录
 */
export const logoutBilibili = async (): Promise<void> => {
  await window.api.bilibili.logout();
  setBilibiliLoginState(false);
};

/**
 * 获取二维码登录 key 和确认 URL
 * @returns 二维码 key 和确认 URL
 */
export const qrKey = async (): Promise<{ key: string; url: string }> => {
  const res = await window.api.bilibili.qrKey();
  if (!res.ok) throw new Error(res.error);
  return { key: res.key, url: res.url };
};

/**
 * 轮询二维码扫码状态
 * @param key 二维码 key
 * @returns 扫码状态和结果
 */
export const qrCheck = async (key: string): Promise<BiliQrCheckResult> => {
  const res = await window.api.bilibili.qrCheck(key);
  if (!res.ok) throw new Error(res.error);
  return {
    code: res.code as BiliQrStatusCode,
    message: res.message,
    cookie: res.cookie,
    url: res.url,
  };
};

/**
 * 使用密码登录 Bilibili
 * @param username 用户名（手机号或邮箱）
 * @param password 密码
 * @returns 登录结果
 */
export const loginBilibiliByPassword = async (username: string, password: string): Promise<BiliPwdResult> => {
  const res = await window.api.bilibili.pwdLogin(username, password);
  if (!res.ok) throw new Error(res.error);
  return {
    success: res.success,
    cookie: res.cookie,
    message: res.message,
    needCaptcha: res.needCaptcha,
    needVerify: res.needVerify,
  };
};
