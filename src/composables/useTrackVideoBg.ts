import { getVideoUrl } from "@/apis/bilibili";
import localforage from "localforage";
import { shallowRef } from "vue";

/** 视频来源 */
export type TrackVideoSource = "bilibili" | "custom";

/** 按歌曲配置的视频背景信息 */
export interface TrackVideoBgItem {
  /** 视频流地址 */
  videoUrl: string;
  /** 视频来源 */
  source: TrackVideoSource;
  /** 视频标题 */
  title: string;
  /** Bilibili BV 号 */
  bvid?: string;
  /** Bilibili 视频 cid */
  cid?: number;
}

/** 按歌曲配置的视频背景存储 */
const db = localforage.createInstance({ name: "splayer", storeName: "trackVideoBg" });

/** 内存缓存 */
const cache = new Map<string, TrackVideoBgItem>();

/** 是否已加载全部数据 */
let loaded = false;

/** 首次加载锁 */
let loadAllPromise: Promise<void> | null = null;

/**
 * 从持久化存储加载全部数据到内存缓存
 */
const loadAll = async (): Promise<void> => {
  if (loaded) return;
  if (loadAllPromise) {
    await loadAllPromise;
    return;
  }
  const promise = (async () => {
    cache.clear();
    await db.iterate<TrackVideoBgItem, void>((value, key) => {
      cache.set(key, value);
    });
    loaded = true;
  })();
  loadAllPromise = promise;
  try {
    await promise;
  } catch (err) {
    loadAllPromise = null;
    throw err;
  }
};

/**
 * 获取指定歌曲的视频背景配置
 * @param trackId - 歌曲全局 id
 * @returns 视频背景配置，不存在时返回 null
 */
export const getTrackVideoBg = async (trackId: string): Promise<TrackVideoBgItem | null> => {
  await loadAll();
  return cache.get(trackId) ?? null;
};

/**
 * 设置指定歌曲的视频背景配置
 * @param trackId - 歌曲全局 id
 * @param item - 视频背景信息
 */
export const setTrackVideoBg = async (trackId: string, item: TrackVideoBgItem): Promise<void> => {
  await loadAll();
  await db.setItem(trackId, item);
  cache.set(trackId, item);
};

/**
 * 移除指定歌曲的视频背景配置
 * @param trackId - 歌曲全局 id
 */
export const removeTrackVideoBg = async (trackId: string): Promise<void> => {
  await loadAll();
  await db.removeItem(trackId);
  cache.delete(trackId);
};

/**
 * 获取所有已配置的视频背景（按歌曲 id 映射）
 * @returns 只读 Map
 */
export const getAllTrackVideoBgs = async (): Promise<ReadonlyMap<string, TrackVideoBgItem>> => {
  await loadAll();
  return new Map(cache);
};

/**
 * 检查指定歌曲是否已配置视频背景
 * @param trackId - 歌曲全局 id
 * @returns 是否已配置
 */
export const hasTrackVideoBg = async (trackId: string): Promise<boolean> => {
  await loadAll();
  return cache.has(trackId);
};

/**
 * 清空全部按歌曲配置的视频背景
 */
export const clearAllTrackVideoBgs = async (): Promise<void> => {
  cache.clear();
  await db.clear().catch(console.error);
  loaded = false;
  loadAllPromise = null;
};

/**
 * 刷新指定歌曲的视频背景 URL（Bilibili 来源时重新获取 DASH 流）
 * @param trackId - 歌曲全局 id
 * @returns 刷新后的配置，无法刷新时返回 null
 */
export const refreshTrackVideoBg = async (trackId: string): Promise<TrackVideoBgItem | null> => {
  const current = await getTrackVideoBg(trackId);
  if (!current || current.source !== "bilibili" || !current.bvid || !current.cid) return null;
  try {
    const videoUrl = await getVideoUrl(current.bvid, current.cid);
    const updated = { ...current, videoUrl };
    await setTrackVideoBg(trackId, updated);
    return updated;
  } catch (err) {
    console.warn("[useTrackVideoBg] refresh failed:", err);
    return null;
  }
};

/**
 * 按歌曲配置视频背景的组合式函数
 * 提供响应式当前歌曲视频背景及 CRUD 操作
 */
export const useTrackVideoBg = () => {
  /** 当前歌曲的视频背景（响应式） */
  const currentTrackVideoBg = shallowRef<TrackVideoBgItem | null>(null);

  /**
   * 加载指定歌曲的视频背景配置
   * @param trackId - 歌曲全局 id
   */
  const loadTrackVideoBg = async (trackId: string): Promise<void> => {
    currentTrackVideoBg.value = await getTrackVideoBg(trackId);
  };

  /**
   * 设置当前歌曲的视频背景配置
   * @param trackId - 歌曲全局 id
   * @param item - 视频背景信息
   */
  const saveTrackVideoBg = async (trackId: string, item: TrackVideoBgItem): Promise<void> => {
    await setTrackVideoBg(trackId, item);
    currentTrackVideoBg.value = item;
  };

  /**
   * 移除当前歌曲的视频背景配置
   * @param trackId - 歌曲全局 id
   */
  const deleteTrackVideoBg = async (trackId: string): Promise<void> => {
    await removeTrackVideoBg(trackId);
    currentTrackVideoBg.value = null;
  };

  return {
    currentTrackVideoBg,
    loadTrackVideoBg,
    saveTrackVideoBg,
    deleteTrackVideoBg,
  };
};

/**
 * 同步获取指定歌曲的视频背景配置（仅限已加载缓存后）
 * 用于 computed 等同步场景，首次可能返回 null，随后异步加载
 * @param trackId - 歌曲全局 id
 * @returns 视频背景配置或 null
 */
export const getTrackVideoBgSync = (trackId: string): TrackVideoBgItem | null => {
  return cache.get(trackId) ?? null;
};
