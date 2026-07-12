import type { Track } from "@shared/types/player";
import type { CoverItem } from "@/types/artist";
import type { SearchResult } from "./index";
import { searchVideos, normalizeUrl } from "@/apis/bilibili";

/**
 * 搜索 Bilibili 视频并映射为 Track
 * @param keyword - 搜索关键词
 * @param offset - 偏移量（按条数）
 * @param limit - 每页条数
 * @returns 搜索结果
 */
export const songs = async (
  keyword: string,
  offset: number,
  limit: number,
): Promise<SearchResult<Track>> => {
  if (!keyword.trim() || limit <= 0) {
    return { items: [], total: 0, hasMore: false };
  }
  const page = Math.floor(offset / limit) + 1;
  const { items, total, hasMore } = await searchVideos(keyword, page, limit);
  const tracks: Track[] = items.map((item) => ({
    id: item.bvid,
    source: "bilibili",
    title: item.title,
    artists: [{ name: item.author }],
    cover: normalizeUrl(item.pic),
    duration: item.duration * 1000,
  }));
  return { items: tracks, total, hasMore };
};

// Bilibili 不支持专辑/歌手/歌单搜索
const empty = <T>(): SearchResult<T> => ({ items: [], total: 0, hasMore: false });

export const albums = async (
  _keyword: string,
  _offset: number,
  _limit: number,
): Promise<SearchResult<CoverItem>> => empty();
export const artists = async (
  _keyword: string,
  _offset: number,
  _limit: number,
): Promise<SearchResult<CoverItem>> => empty();
export const playlists = async (
  _keyword: string,
  _offset: number,
  _limit: number,
): Promise<SearchResult<CoverItem>> => empty();
