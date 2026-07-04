/**
 * Spotify 歌曲 URL 解析
 *
 * Spotify 官方 API 不直接提供可播放的 MP3 URL，
 * 返回空实现，由插件或外部方案接管实际播放。
 */

const songUrl = async (_params: Record<string, unknown>): Promise<Record<string, unknown>> => {
  return { code: 200, url: null, message: "Spotify 不直接提供公开播放 URL" };
};

export default songUrl;
