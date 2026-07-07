/**
 * 用户登录相关类型
 */

/** 用户基础资料 */
export interface UserProfile {
  userId: number;
  nickname: string;
  avatarUrl?: string;
  backgroundUrl?: string;
  signature?: string;
  /** 0=普通，非 0=黑胶 VIP */
  vipType?: number;
  gender?: number;
  province?: number;
  city?: number;
}

/** Spotify 用户资料 */
export interface SpotifyUserProfile {
  id: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

/** QQ 音乐用户资料 */
export interface QQMusicUserProfile {
  /** QQ 号 */
  userId: string;
  /** 昵称 */
  nickname: string;
  /** 头像 URL */
  avatarUrl?: string;
}

/** 酷狗用户资料 */
export interface KugouUserProfile {
  userId: string;
  nickname: string;
  avatarUrl?: string;
}

/** Bilibili 用户资料 */
export interface BilibiliUserProfile {
  userId: number;
  nickname: string;
  avatarUrl?: string;
}

/** 用户订阅计数（/user/subcount） */
export interface UserSubcount {
  /** 自建歌单数 */
  createdPlaylistCount: number;
  /** 收藏歌单数 */
  subPlaylistCount: number;
  /** 收藏歌手数 */
  artistCount: number;
}
