/**
 * QQ 音乐登录相关（渲染端封装）
 */

import type { QQMusicUserProfile } from "@/types/user";

/**
 * 打开 QQ 音乐网页登录窗口
 * @returns 登录成功返回用户资料；失败返回 null
 */
export const loginQQMusic = async (): Promise<QQMusicUserProfile | null> => {
  const res = await window.api.qqmusic.login();
  if (!res.ok || !res.profile) return null;
  return {
    userId: res.profile.userId,
    nickname: res.profile.nickname,
    avatarUrl: res.profile.avatarUrl,
  };
};

/** 退出 QQ 音乐登录 */
export const logoutQQMusic = async (): Promise<void> => {
  await window.api.qqmusic.logout();
};

/**
 * 获取 QQ 音乐登录状态
 * @returns 已登录返回 profile；未登录返回 null
 */
export const fetchQQMusicLoginStatus = async (): Promise<QQMusicUserProfile | null> => {
  const res = await window.api.qqmusic.getStatus();
  if (!res.ok || !res.profile) return null;
  return {
    userId: res.profile.userId,
    nickname: res.profile.nickname,
    avatarUrl: res.profile.avatarUrl,
  };
};
