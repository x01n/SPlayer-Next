/**
 * Spotify 用户登录封装（渲染端）
 */

import type { SpotifyUserProfile } from "@/types/user";

/**
 * 启动 Spotify OAuth 登录
 * @returns 登录成功返回 profile；失败抛 Error
 */
export const loginSpotify = async (): Promise<SpotifyUserProfile> => {
  const res = await window.api.spotify.login();
  if (!res.ok) throw new Error(res.error);
  const raw = res.profile;
  if (!raw) throw new Error("获取用户资料失败");
  return {
    id: raw.id,
    displayName: raw.display_name || raw.id,
    email: raw.email,
    avatarUrl: raw.images?.[0]?.url,
  };
};

/**
 * 获取 Spotify 登录状态
 * @returns 已登录返回 profile；未登录返回 null
 */
export const fetchSpotifyStatus = async (): Promise<SpotifyUserProfile | null> => {
  const res = await window.api.spotify.getStatus();
  if (!res.ok) throw new Error(res.error);
  if (!res.loggedIn || !res.profile) return null;
  const raw = res.profile;
  return {
    id: raw.id,
    displayName: raw.display_name || raw.id,
    email: raw.email,
    avatarUrl: raw.images?.[0]?.url,
  };
};

/**
 * 登出 Spotify
 */
export const logoutSpotify = async (): Promise<void> => {
  const res = await window.api.spotify.logout();
  if (!res.ok) throw new Error("spotify logout failed");
};
