/**
 * PlaySessionId 生成器
 * Jellyfin/Emby stream URL 需要带 PlaySessionId 参数
 * 用来在 server 端区分相邻两次解码上下文
 */

/**
 * 生成新的 PlaySessionId；不复用全局状态，由调用方自行维护是否复用
 * @param _trackId - Track 全局 id（保留参数以兼容旧调用）
 * @returns PlaySessionId（UUID）
 */
export const sessionIdForTrack = (_trackId: string): string => crypto.randomUUID();
