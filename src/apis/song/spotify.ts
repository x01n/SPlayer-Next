import type { Track } from "@shared/types/player";
import type { QualityLevel } from "@/utils/quality";

/**
 * 解析 Spotify Track 的可播放 URL
 *
 * Spotify 不直接提供公开 MP3 URL，需要通过官方 SDK 或 Web Playback SDK 播放，
 * 此处返回 null，实际播放由用户通过插件或外部方案实现。
 *
 * @param _track - track.id 为 Spotify track ID
 * @param _songLevel - 音质档位（Spotify 不支持）
 */
export const resolveSpotifyUrl = async (
  _track: Track,
  _songLevel: QualityLevel,
): Promise<string | null> => {
  // Spotify 官方 API 不提供直接可播放的 MP3 URL
  return null;
};
