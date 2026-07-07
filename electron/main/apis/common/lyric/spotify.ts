/**
 * Spotify 歌词匹配
 *
 * Spotify 官方 Web API 不提供歌词获取接口，
 * 返回空实现，建议通过其他平台（netease/qqmusic/kugou）匹配歌词。
 */

import type { LyricMatchResult, LyricSearchCandidate } from "@shared/types/lyrics";
import type { Track } from "@shared/types/player";

/**
 * 按 Spotify track id 直取歌词（不支持）
 * @param _id 歌曲 id
 */
export const getByPlatformId = async (_id: string): Promise<LyricMatchResult | null> => {
  return null;
};

/** 按 Track 元数据搜索候选（不支持）
 * @param _track 歌曲信息
 */
export const searchCandidates = async (_track: Track): Promise<LyricSearchCandidate[]> => {
  return [];
};

/**
 * 按 Track 元数据模糊搜索歌词（不支持）
 * @param _track 歌曲信息
 */
export const getByQuery = async (_track: Track): Promise<LyricMatchResult | null> => {
  return null;
};
