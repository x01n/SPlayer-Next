import type { Track, TrackSource } from "@shared/types/player";
import type { Platform } from "@shared/types/platform";
import type { QualityLevel } from "@/utils/quality";
import { useStreamingStore } from "@/stores/streaming";
import { useSettingsStore } from "@/stores/settings";
import { usePluginsStore } from "@/stores/plugins";
import { resolveNeteaseUrl } from "@/apis/song/netease";
import { searchVideos, getVideoInfo, getAudioUrl, getVideoUrl } from "@/apis/bilibili";
import { getNetworkState } from "@/services/network";
import { ErrorCode } from "@shared/types/errors";
import { handleError } from "@/utils/errors";

/** 在线平台 source → 插件 source key */
const PLATFORM_TO_PLUGIN_SOURCE: Record<Platform, string> = {
  netease: "wy",
  qqmusic: "tx",
  kugou: "kg",
  spotify: "sp",
  bilibili: "bili",
};

/**
 * 检查给定 source 是否为在线平台
 * @param source - 要检查的 source
 */
const isOnlinePlatform = (source: TrackSource): source is Platform =>
  source === "netease" || source === "qqmusic" || source === "kugou" || source === "spotify";

/** 离线缓存回退时的音质档位优先级（从高到低） */
const OFFLINE_QUALITY_PRIORITY: QualityLevel[] = ["hi-res", "lossless", "hq", "sq", "lq"];

/**
 * 离线时尝试查找任意音质档位的缓存
 * @param track - 要解析的 track
 * @param songLevel - 当前请求的音质档位
 * @returns 命中的缓存路径，无缓存则返回 null
 */
const findOfflineCache = async (
  track: Track,
  songLevel: QualityLevel,
): Promise<string | null> => {
  // 只有 netease 和 streaming 的缓存键包含音质档位，需要回退查找
  if (track.source === "netease" && track.id) {
    for (const level of OFFLINE_QUALITY_PRIORITY) {
      if (level === songLevel) continue; // 已在主流程中查过
      const key = `o:netease:${track.id}:${level}`;
      const cached = await window.api.cache.song.lookup(key);
      if (cached) return cached;
    }
    return null;
  }
  if (track.source === "streaming" && track.serverId && track.originalId) {
    for (const level of OFFLINE_QUALITY_PRIORITY) {
      if (level === songLevel) continue;
      const key = `s:${track.serverId}:${track.originalId}:${level}`;
      const cached = await window.api.cache.song.lookup(key);
      if (cached) return cached;
    }
    // 兼容旧版无 songLevel 后缀的缓存键
    const legacyKey = `s:${track.serverId}:${track.originalId}:`;
    const cached = await window.api.cache.song.lookup(legacyKey);
    if (cached) return cached;
    return null;
  }
  // 其他在线平台缓存键与音质无关，已在主流程中查过
  return null;
};

/**
 * 派生缓存键
 * netease / streaming 把音质档位并入键，使不同音质的同一首歌互不覆盖
 * @param track - 要解析的 track
 * @param songLevel - 在线歌曲音质档位
 * @returns 派生缓存键，如果该 track 不参与歌曲缓存则返回 null
 */
const cacheKeyForTrack = (track: Track, songLevel: QualityLevel): string | null => {
  if (track.source === "streaming" && track.serverId && track.originalId) {
    return `s:${track.serverId}:${track.originalId}:${songLevel}`;
  }
  if (track.source === "netease" && track.id) {
    return `o:netease:${track.id}:${songLevel}`;
  }
  if (isOnlinePlatform(track.source) && track.id) {
    return `o:${track.source}:${track.id}:`;
  }
  return null;
};

/** 在线 URL 解析结果 */
export type OnlineResolveResult = { url: string } | { url: null; errorCode: ErrorCode };

/**
 * 经插件解析在线音频源 URL
 * @param track - 要解析的 track
 * @param quality - 音质档位（播放默认 hq，下载传下载档位）
 * @returns 解析结果，失败时带原因码
 */
export const resolveByPlugin = async (
  track: Track,
  quality: QualityLevel = "hq",
): Promise<OnlineResolveResult> => {
  const fail = (errorCode: ErrorCode): OnlineResolveResult => ({ url: null, errorCode });
  if (!isOnlinePlatform(track.source)) return fail(ErrorCode.URL_RESOLVE_FAILED);
  const pluginSource = PLATFORM_TO_PLUGIN_SOURCE[track.source];
  if (!pluginSource) return fail(ErrorCode.URL_RESOLVE_FAILED);
  const plugins = usePluginsStore();
  const candidates = plugins.list.filter(
    (info) =>
      info.enabled &&
      info.status.state === "ready" &&
      info.status.sources[pluginSource]?.actions.includes("musicUrl"),
  );
  if (candidates.length === 0) return fail(ErrorCode.NO_PLUGIN_AVAILABLE);
  // MusicInfoBase 形状；id / songmid / songId 三种别名都给，兼容不同年代脚本
  const totalSec = track.duration > 0 ? Math.round(track.duration / 1000) : 0;
  const interval =
    totalSec > 0
      ? `${Math.floor(totalSec / 60)
          .toString()
          .padStart(2, "0")}:${(totalSec % 60).toString().padStart(2, "0")}`
      : null;
  const singer = track.artists.map((artist) => artist.name).join("/");
  const musicInfo = {
    id: track.id,
    songmid: track.id,
    songId: track.id,
    name: track.title,
    singer,
    source: pluginSource,
    interval,
    meta: {
      songId: track.id,
      albumName: track.album?.name ?? "",
      albumId: track.album?.id,
      picUrl: track.cover ?? null,
    },
  };
  for (const plugin of candidates) {
    try {
      const res = await window.api.plugins.resolveUrl({
        pluginId: plugin.manifest.id,
        source: pluginSource,
        quality,
        musicInfo,
      });
      if (res?.url) return { url: res.url };
    } catch (err) {
      console.warn("[plugin] resolveUrl failed", plugin.manifest.id, err);
    }
  }
  return { url: null, errorCode: ErrorCode.URL_RESOLVE_FAILED };
};

/**
 * 解析在线音频源 URL
 * @param track - 要解析的 track
 * @param songLevel - 在线歌曲音质档位（仅网易云官方接口生效）
 */
const resolveOnlineUrl = async (
  track: Track,
  songLevel: QualityLevel,
): Promise<OnlineResolveResult> => {
  try {
    if (track.source === "netease") {
      const resolved = await resolveNeteaseUrl(track, songLevel);
      if (resolved) return { url: resolved };
    }
  } catch (err) {
    // 官方 API 异常回落插件
    console.warn("[audioSource] resolveNeteaseUrl failed:", err);
  }
  return resolveByPlugin(track);
};

/**
 * 尝试 Bilibili fallback：当在线音源解析失败或音质较低时，搜索 Bilibili 视频提取音频
 * @param track - 要解析的 track
 * @returns 解析到的音频源和视频源，失败返回 null
 */
const tryBilibiliFallback = async (track: Track): Promise<ResolvedTrackSource | null> => {
  try {
    const keyword = `${track.title} ${track.artists.map((a) => a.name).join(" ")}`;
    const resp = await searchVideos(keyword, 1, 5);
    if (resp.items.length === 0) return null;
    // 取第一个结果
    const item = resp.items[0];
    const { cid } = await getVideoInfo(item.bvid);
    const [audioUrl, videoUrl] = await Promise.all([
      getAudioUrl(item.bvid, cid),
      getVideoUrl(item.bvid, cid),
    ]);
    return {
      source: audioUrl,
      fromCache: false,
      videoUrl,
      videoBvid: item.bvid,
      videoCid: cid,
    };
  } catch (err) {
    console.warn("[audioSource] Bilibili fallback failed:", err);
    return null;
  }
};

/**
 * 解析结果
 * - fromCache 为 true 时表示音源直接命中本地缓存
 * - cacheRequest 存在时表示尚未缓存，调用方应在合适时机（如播放达到阈值后）触发它
 * - videoUrl / videoBvid / videoCid 存在时表示同时获取到了视频源（用于视频背景）
 */
export interface ResolvedTrackSource {
  source: string;
  fromCache: boolean;
  cacheRequest?: () => Promise<void>;
  videoUrl?: string;
  videoBvid?: string;
  videoCid?: number;
}

/**
 * 根据 track 信息解析出最终的音频源 URL
 * @param track - 要解析的 track
 */
export const resolveTrackSource = async (track: Track): Promise<ResolvedTrackSource | null> => {
  // 本地文件
  if (track.source === "local") {
    return track.path ? { source: track.path, fromCache: false } : null;
  }
  const settings = useSettingsStore();
  const songLevel = settings.player.songLevel;
  const cacheKey = cacheKeyForTrack(track, songLevel);
  const cacheEnabled = settings.system.cache?.songCache?.enabled === true && cacheKey !== null;
  if (cacheEnabled) {
    const cached = await window.api.cache.song.lookup(cacheKey!);
    if (cached) return { source: cached, fromCache: true };
  }
  // 离线时若启用了缓存回退，尝试查找任意音质档位的缓存
  const offlineFallbackEnabled = settings.system.cache?.songCache?.offlineFallback !== false;
  if (cacheEnabled && offlineFallbackEnabled) {
    const net = await getNetworkState();
    if (!net.online) {
      const fallback = await findOfflineCache(track, songLevel);
      if (fallback) return { source: fallback, fromCache: true };
      // 离线且无缓存，直接失败
      return null;
    }
  }
  // 流媒体
  if (track.source === "streaming") {
    try {
      const store = useStreamingStore();
      const streamUrl = await store.getStreamUrl(track);
      const result: ResolvedTrackSource = { source: streamUrl, fromCache: false };
      if (cacheEnabled) {
        // 缓存下载用独立 PlaySessionId
        result.cacheRequest = async () => {
          try {
            const cacheUrl = await store.getStreamUrl(track, {
              playSessionId: crypto.randomUUID(),
            });
            void window.api.cache.song.fetch(cacheKey, "streaming", cacheUrl);
          } catch (err) {
            console.warn("[cache] streaming getStreamUrl failed", err);
          }
        };
      }
      return result;
    } catch (err) {
      handleError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  // 在线源（netease / qqmusic / kugou / spotify）
  if (isOnlinePlatform(track.source)) {
    try {
      // 如果启用了 Bili 高品质音频源，优先尝试 Bilibili fallback
      const biliHqEnabled = settings.system.bilibili?.highQualityAudio === true;
      if (biliHqEnabled) {
        const fallback = await tryBilibiliFallback(track);
        if (fallback) return fallback;
      }
      const resolved = await resolveOnlineUrl(track, songLevel);
      if (resolved.url === null) {
        // URL 解析失败时尝试 Bilibili fallback
        const fallback = await tryBilibiliFallback(track);
        if (fallback) return fallback;
        handleError(resolved.errorCode);
        return null;
      }
      // 音质较低时尝试 Bilibili fallback 获取更高品质
      if (songLevel === "lq" || songLevel === "hq") {
        const fallback = await tryBilibiliFallback(track);
        if (fallback) return fallback;
      }
      const url = resolved.url;
      const result: ResolvedTrackSource = { source: url, fromCache: false };
      if (cacheEnabled) {
        // 缓存下载时重新解析最新 URL，避免使用已失效的 URL
        result.cacheRequest = async () => {
          try {
            const reResolved = await resolveOnlineUrl(track, songLevel);
            if (reResolved.url) {
              void window.api.cache.song.fetch(cacheKey, track.source, reResolved.url);
            }
          } catch (err) {
            console.warn("[cache] cacheRequest re-resolve failed", err);
          }
        };
      }
      return result;
    } catch (err) {
      handleError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  return null;
};
