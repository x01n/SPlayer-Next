import { callNetease } from "@main/apis/netease";
import { pickBestCandidate, type LyricCandidate } from "@main/apis/common/lyric/utils";
import { pluginRegistry, type PluginRuntime } from "@main/plugins/registry";
import { callMusicComment, callMusicSearch } from "@main/plugins/router";
import { pluginLog } from "@main/utils/logger";
import type { CommentSource, MusicCommentPage, MusicCommentQuery } from "@shared/types/comment";
import type { MusicSearchCandidate } from "@shared/types/plugin";
import type { Track } from "@shared/types/player";
import { buildCommentSources, normalizeNeteaseCommentPage } from "./data";

const NETEASE_SOURCE_ID = "builtin:netease";
const NETEASE_RESOURCE_TYPE = "R_SO_4_";

const PLATFORM_TO_PLUGIN_SOURCE: Record<string, string> = {
  netease: "wy",
  qqmusic: "tx",
  kugou: "kg",
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface ParsedPluginSource {
  pluginId: string;
  source: string;
}

const parsePluginSource = (sourceId: string): ParsedPluginSource | null => {
  if (!sourceId.startsWith("plugin:")) return null;
  const rest = sourceId.slice("plugin:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  return {
    pluginId: rest.slice(0, sep),
    source: rest.slice(sep + 1),
  };
};

const toKeyword = (track: Track): string =>
  `${track.title} ${track.artists.map((artist) => artist.name).join(" ")}`.trim();

/** 清理搜索关键词，移除括号内内容、版本标识等干扰信息 */
const cleanKeyword = (keyword: string): string =>
  keyword
    .replace(/[（(].*?[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * 通过网易云搜索匹配歌曲 ID
 * 多轮策略：先完整关键词 → 仅标题 → 清理后标题
 */
const findNeteaseId = async (track: Track): Promise<string | null> => {
  if (track.source === "netease" && track.id) return track.id;

  const fullKeyword = toKeyword(track);
  const titleOnly = track.title;
  const cleanTitle = cleanKeyword(titleOnly);

  const searchKeywords = [
    fullKeyword,
    ...(fullKeyword !== titleOnly && titleOnly.length >= 2 ? [titleOnly] : []),
    ...(cleanTitle && cleanTitle !== titleOnly && cleanTitle.length >= 2 ? [cleanTitle] : []),
  ].filter((k, i, arr) => k && arr.indexOf(k) === i); // 去重

  for (const keyword of searchKeywords) {
    try {
      const { status, body } = await callNetease("search", {
        keywords: keyword,
        type: 1,
        limit: 20,
      });
      if (status !== 200) continue;

      const songs = body.result?.songs ?? [];
      if (!songs.length) continue;

      const candidates: LyricCandidate<{ id: string }>[] = songs.map(
        (song: {
          id: string | number;
          name?: string;
          artists?: { name: string }[];
          album?: { name?: string };
          duration?: number;
        }) => ({
          name: song.name ?? "",
          artist: (song.artists ?? []).map((artist) => artist.name).join(" / "),
          album: song.album?.name,
          duration: song.duration,
          extra: { id: String(song.id) },
        }),
      );

      const matched = pickBestCandidate(candidates, track);
      if (matched) return matched.extra.id;

      // 若 keyword 仅为标题且首结果标题高度相似，放宽匹配取第一首
      if (keyword === titleOnly || keyword === cleanTitle) {
        const first = candidates[0];
        const normTitle = track.title.toLowerCase().replace(/\s+/g, "");
        const normFirst = first.name.toLowerCase().replace(/\s+/g, "");
        if (normFirst.includes(normTitle) || normTitle.includes(normFirst)) {
          return first.extra.id;
        }
      }
    } catch (err) {
      // 单轮搜索失败继续下一轮，但记录日志便于排查
      pluginLog.warn("[comments] findNeteaseId search failed:", keyword, err instanceof Error ? err.message : String(err));
    }
  }

  return null;
};

const toPluginCandidate = (track: Track): MusicSearchCandidate => ({
  id: track.id,
  name: track.title,
  singer: track.artists.map((artist) => artist.name).join("/"),
  album: track.album?.name,
  durationMs: track.duration,
});

const findPluginMatch = async (
  rt: PluginRuntime,
  source: string,
  track: Track,
): Promise<MusicSearchCandidate | null> => {
  if (PLATFORM_TO_PLUGIN_SOURCE[track.source] === source && track.id)
    return toPluginCandidate(track);
  const keyword = toKeyword(track);
  if (!keyword) return null;
  const res = await callMusicSearch(rt, { source, keyword, limit: 20 });
  const list = res?.list ?? [];
  const candidates: LyricCandidate<MusicSearchCandidate>[] = list.map((item) => ({
    name: item.name,
    artist: item.singer ?? "",
    album: item.album,
    duration: item.durationMs,
    extra: item,
  }));
  return pickBestCandidate(candidates, track)?.extra ?? null;
};

const getNeteaseComments = async (args: MusicCommentQuery): Promise<MusicCommentPage> => {
  const id = await findNeteaseId(args.track);
  if (!id) return { list: [], total: 0, page: args.page, limit: args.limit };

  const apiName = args.type === "hot" ? "comment_hot" : "comment_music";
  try {
    const { body } = await callNetease(apiName, {
      id,
      type: NETEASE_RESOURCE_TYPE,
      limit: args.limit,
      offset: (args.page - 1) * args.limit,
    });
    return normalizeNeteaseCommentPage(body, args.type, args.page, args.limit);
  } catch (err) {
    pluginLog.warn("[comments] callNetease failed:", err instanceof Error ? err.message : String(err));
    return { list: [], total: 0, page: args.page, limit: args.limit };
  }
};

const getPluginComments = async (
  parsed: ParsedPluginSource,
  args: MusicCommentQuery,
): Promise<MusicCommentPage> => {
  const rt = pluginRegistry.getRuntime(parsed.pluginId);
  if (!rt || rt.status.state !== "ready") {
    return { list: [], total: 0, page: args.page, limit: args.limit };
  }
  try {
    const musicInfo = await findPluginMatch(rt, parsed.source, args.track);
    if (!musicInfo) return { list: [], total: 0, page: args.page, limit: args.limit };
    return await callMusicComment(rt, {
      source: parsed.source,
      musicInfo,
      type: args.type,
      page: args.page,
      limit: args.limit,
    });
  } catch (err) {
    pluginLog.warn(
      "matchComment failed",
      parsed.pluginId,
      parsed.source,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
};

const normalizeQuery = (args: MusicCommentQuery): MusicCommentQuery => ({
  ...args,
  page: Math.max(1, Math.floor(Number(args.page) || 1)),
  limit: Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit) || DEFAULT_LIMIT))),
});

/** 获取当前可用评论源 */
export const getCommentSources = (): CommentSource[] =>
  buildCommentSources(pluginRegistry.listInfo());

/** 获取歌曲评论 */
export const getMusicComments = async (args: MusicCommentQuery): Promise<MusicCommentPage> => {
  const query = normalizeQuery(args);
  if (query.sourceId === NETEASE_SOURCE_ID) return getNeteaseComments(query);
  const parsed = parsePluginSource(query.sourceId);
  if (parsed) return getPluginComments(parsed, query);
  // 对未知音源回退到网易云搜索（getNeteaseComments 内部已包含搜索匹配逻辑）
  return getNeteaseComments(query);
};
