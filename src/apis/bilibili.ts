/**
 * Bilibili 公开 API 封装
 * 用于搜索视频、获取视频信息及音频流地址
 */

const BASE = "https://api.bilibili.com";
const WEB_PROXY_BASE = "/api/bilibili";

/** 通用请求头 */
const COMMON_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/** 当前是否已登录 Bilibili */
let bilibiliLoggedIn = false;

/**
 * 更新 Bilibili 登录状态
 * @param loggedIn - 是否已登录
 */
export const setBilibiliLoginState = (loggedIn: boolean): void => {
  bilibiliLoggedIn = loggedIn;
};

/**
 * 构建带 Cookie 的请求头
 * @param extra - 额外请求头
 * @returns 合并后的请求头
 */
/** Electron 环境通过 IPC 代理 Bilibili API 请求 */
const useIpcProxy = (): boolean => typeof window !== "undefined" && !!window.api?.bilibili?.proxy;

const shouldUseWebProxy = (): boolean =>
  typeof window !== "undefined" && !window.api && !useIpcProxy();

const resolveRequestUrl = (url: string): string => {
  if (!shouldUseWebProxy()) return url;
  const parsed = new URL(url);
  if (parsed.origin !== BASE) return url;
  return `${WEB_PROXY_BASE}${parsed.pathname}${parsed.search}`;
};

const resolveRequestInit = (init?: RequestInit): RequestInit | undefined => {
  if (!shouldUseWebProxy()) return init;
  const headers = new Headers(init?.headers);
  headers.delete("Cookie");
  headers.delete("User-Agent");
  headers.delete("Referer");
  return { ...init, headers };
};

const buildHeaders = (extra?: Record<string, string>): Record<string, string> => {
  const headers = { ...COMMON_HEADERS };
  if (extra) Object.assign(headers, extra);
  return headers;
};

/** Bilibili 视频搜索结果项 */
export interface BiliVideoItem {
  /** 视频 BV 号 */
  bvid: string;
  /** 视频标题（已去 HTML 标签） */
  title: string;
  /** UP 主名称 */
  author: string;
  /** 封面图片 URL */
  pic: string;
  /** 视频时长（秒） */
  duration: number;
}

/** 搜索视频响应 */
interface SearchResp {
  items: BiliVideoItem[];
  total: number;
  hasMore: boolean;
}

/**
 * 解析 Bilibili 搜索响应中的 result 字段
 * @param result - 原始响应数据
 * @returns 保证为数组的搜索结果
 */
/**
 * 解析 Bilibili 搜索响应中的 result 字段
 * 兼容 result 为数组或嵌套在对象中的情况
 * @param result - 原始响应数据
 * @returns 保证为数组的搜索结果
 */
const normalizeSearchResult = (result: unknown): unknown[] => {
  if (Array.isArray(result)) return result;
  if (typeof result === "object" && result !== null) {
    // 某些版本 API 将结果嵌套在 data 字段中
    const nested = (result as Record<string, unknown>).data;
    if (Array.isArray(nested)) return nested;
  }
  return [];
};

/**
 * 解析时长字符串为秒数（支持 "MM:SS" 和 "H:MM:SS"）
 * @param duration - 时长字符串或数字
 * @returns 秒数
 */
const parseDuration = (duration: unknown): number => {
  if (typeof duration === "number") return duration;
  if (typeof duration !== "string") return 0;
  const parts = duration.split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
};

/**
 * 解析响应 JSON
 * @param res - fetch 响应
 * @returns 解析后的 JSON 数据
 */
const parseJson = async (res: Response): Promise<unknown> => {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
};

/**
 * 补全协议相对 URL（如 //i0.hdslb.com/... → https://i0.hdslb.com/...）
 * @param url - 原始 URL
 * @returns 补全后的 URL
 */
export const normalizeUrl = (url: string): string => {
  if (url.startsWith("//")) return `https:${url}`;
  return url;
};

/**
 * 通过 IPC 代理请求 Bilibili API（Electron 环境）
 * @param url - 原始 Bilibili API URL
 * @returns 响应 JSON
 */
const fetchViaIpc = async (url: string): Promise<unknown> => {
  const parsed = new URL(url);
  const data = await window.api.bilibili.proxy(parsed.pathname, parsed.search);
  return data;
};

/**
 * 带超时的 fetch 请求
 * @param url - 请求 URL
 * @param init - fetch 配置
 * @param timeoutMs - 超时毫秒数（默认 15000）
 * @returns fetch 响应
 */
const fetchWithTimeout = (
  url: string,
  init?: RequestInit,
  timeoutMs = 15000,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestUrl = resolveRequestUrl(url);
  const requestInit = resolveRequestInit(init);
  return fetch(requestUrl, { ...requestInit, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
};

/**
 * 搜索 Bilibili 视频
 * @param keyword - 搜索关键词
 * @param page - 页码（从 1 开始）
 * @param pageSize - 每页条数
 * @returns 搜索结果
 */
export const searchVideos = async (
  keyword: string,
  page: number,
  pageSize: number,
): Promise<SearchResp> => {
  if (!keyword?.trim()) return { items: [], total: 0, hasMore: false };
  if (page < 1) page = 1;
  if (pageSize <= 0) pageSize = 20;
  // 注意：Bilibili 搜索 API 的参数名是 pagesize（无下划线）
  const url = `${BASE}/x/web-interface/search/type?keyword=${encodeURIComponent(keyword.trim())}&search_type=video&page=${page}&pagesize=${pageSize}`;
  const data = useIpcProxy()
    ? await fetchViaIpc(url)
    : await parseJson(await fetchWithTimeout(url, { headers: buildHeaders() }));
  if (typeof data !== "object" || data === null || (data as { code?: number }).code !== 0) {
    throw new Error((data as { message?: string })?.message || "Bilibili 搜索失败");
  }
  const payload = (data as { data?: { result?: unknown; numResults?: number } }).data ?? {};
  const result = normalizeSearchResult(payload.result);
  const total = payload.numResults ?? 0;
  const items: BiliVideoItem[] = result
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      // Bilibili 搜索 API 字段名可能有差异，做兼容性映射
      const rawPic = item.pic ?? item.cover ?? item.img ?? item.image ?? "";
      const rawDuration = item.duration ?? item.length ?? item.time ?? 0;
      const rawAuthor =
        item.author ??
        (item.owner as Record<string, unknown>)?.name ??
        (item.up as Record<string, unknown>)?.name ??
        "";
      return {
        bvid: String(item.bvid ?? ""),
        title: String(item.title ?? "").replace(/<[^>]+>/g, ""),
        author: String(rawAuthor),
        pic: rawPic ? normalizeUrl(String(rawPic)) : "",
        duration: parseDuration(rawDuration),
      };
    })
    // 过滤掉无效结果（无 BV 号或无可识别视频类型）
    .filter((item) => item.bvid.length > 0);
  return { items, total, hasMore: page * pageSize < total };
};

/**
 * 获取视频信息（含 cid，用于进一步获取播放地址）
 * @param bvid - 视频 BV 号
 * @returns 视频 cid 和时长
 */
export const getVideoInfo = async (bvid: string): Promise<{ cid: number; duration: number }> => {
  if (!bvid?.trim()) throw new Error("BV 号为空");
  const url = `${BASE}/x/web-interface/view?bvid=${encodeURIComponent(bvid.trim())}`;
  const data = useIpcProxy()
    ? await fetchViaIpc(url)
    : await parseJson(await fetchWithTimeout(url, { headers: buildHeaders() }));
  if (typeof data !== "object" || data === null || (data as { code?: number }).code !== 0) {
    throw new Error((data as { message?: string })?.message || "获取 Bilibili 视频信息失败");
  }
  const payload = (data as { data?: { cid?: number; duration?: number } }).data ?? {};
  const cid = payload.cid;
  if (typeof cid !== "number" || cid <= 0) throw new Error("无法获取视频 cid");
  return { cid, duration: payload.duration ?? 0 };
};

/**
 * 获取音频流 URL（优先 DASH 音频，回退 durl）
 * 未登录时使用较低清晰度参数，避免 API 拒绝
 * @param bvid - 视频 BV 号
 * @param cid - 视频 cid
 * @returns 音频流地址
 */
export const getAudioUrl = async (bvid: string, cid: number): Promise<string> => {
  if (!bvid?.trim()) throw new Error("BV 号为空");
  if (typeof cid !== "number" || cid <= 0) throw new Error("cid 无效");
  // 未登录时使用 qn=80（1080P），登录后才请求 qn=112（1080P+）
  const qn = bilibiliLoggedIn ? 112 : 80;
  const url = `${BASE}/x/player/playurl?bvid=${encodeURIComponent(bvid.trim())}&cid=${cid}&qn=${qn}&fnval=16&fourk=1`;
  const data = useIpcProxy()
    ? await fetchViaIpc(url)
    : await parseJson(await fetchWithTimeout(url, { headers: buildHeaders() }));
  if (typeof data !== "object" || data === null || (data as { code?: number }).code !== 0) {
    throw new Error((data as { message?: string })?.message || "获取 Bilibili 音频流失败");
  }
  const payload =
    (data as { data?: { dash?: { audio?: unknown[] }; durl?: { url?: string }[] } }).data ?? {};
  const dashAudio = Array.isArray(payload.dash?.audio) ? payload.dash!.audio : [];
  if (dashAudio.length > 0) {
    const sorted = [...dashAudio].sort((a, b) => {
      const idA = typeof a === "object" && a !== null ? ((a as { id?: number }).id ?? 0) : 0;
      const idB = typeof b === "object" && b !== null ? ((b as { id?: number }).id ?? 0) : 0;
      return idB - idA;
    });
    const first = sorted[0];
    if (first && typeof first === "object") {
      const audioUrl =
        (first as { baseUrl?: string; url?: string }).baseUrl ?? (first as { url?: string }).url;
      if (audioUrl && typeof audioUrl === "string") return audioUrl;
    }
  }
  const durl = Array.isArray(payload.durl) ? payload.durl : [];
  if (durl.length > 0) {
    const fallbackUrl = durl[0].url;
    if (fallbackUrl && typeof fallbackUrl === "string") return fallbackUrl;
  }
  throw new Error("未找到可用音频流");
};

/**
 * 从 DASH 流列表中提取最高清晰度的 URL
 * @param streams - DASH 流数组
 * @returns 流地址或 null
 */
const pickDashStreamUrl = (streams: unknown[]): string | null => {
  if (streams.length === 0) return null;
  const sorted = [...streams].sort((a, b) => {
    const idA = typeof a === "object" && a !== null ? ((a as { id?: number }).id ?? 0) : 0;
    const idB = typeof b === "object" && b !== null ? ((b as { id?: number }).id ?? 0) : 0;
    return idB - idA;
  });
  const first = sorted[0];
  if (first && typeof first === "object") {
    const streamUrl =
      (first as { baseUrl?: string; url?: string }).baseUrl ?? (first as { url?: string }).url;
    if (streamUrl && typeof streamUrl === "string") return streamUrl;
  }
  return null;
};

/**
 * 获取视频流 URL（优先 fnval=0 获取可直接播放的 MP4/FLV，回退 fnval=16 的 DASH）
 * 未登录时使用较低清晰度参数，避免 API 拒绝
 * @param bvid - 视频 BV 号
 * @param cid - 视频 cid
 * @returns 视频流地址
 */
export const getVideoUrl = async (bvid: string, cid: number): Promise<string> => {
  if (!bvid?.trim()) throw new Error("BV 号为空");
  if (typeof cid !== "number" || cid <= 0) throw new Error("cid 无效");
  // 未登录时使用 qn=80（1080P），登录后才请求 qn=112（1080P+）
  const qn = bilibiliLoggedIn ? 112 : 80;

  // 先尝试 fnval=0 获取直接播放的 MP4/FLV 完整视频
  const directUrl = `${BASE}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}&fnval=0&fourk=1`;
  const directData = useIpcProxy()
    ? await fetchViaIpc(directUrl)
    : await parseJson(await fetchWithTimeout(directUrl, { headers: buildHeaders() }));
  if (
    typeof directData === "object" &&
    directData !== null &&
    (directData as { code?: number }).code === 0
  ) {
    const payload = (directData as { data?: { durl?: { url?: string }[] } }).data ?? {};
    const durl = Array.isArray(payload.durl) ? payload.durl : [];
    if (durl.length > 0) {
      const url = durl[0].url;
      if (url && typeof url === "string") return url;
    }
  }

  // 回退到 fnval=16 的 DASH 格式
  const dashUrl = `${BASE}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}&fnval=16&fourk=1`;
  const dashData = useIpcProxy()
    ? await fetchViaIpc(dashUrl)
    : await parseJson(await fetchWithTimeout(dashUrl, { headers: buildHeaders() }));
  if (
    typeof dashData !== "object" ||
    dashData === null ||
    (dashData as { code?: number }).code !== 0
  ) {
    throw new Error((dashData as { message?: string })?.message || "获取 Bilibili 视频流失败");
  }
  const payload =
    (dashData as { data?: { dash?: { video?: unknown[] }; durl?: { url?: string }[] } }).data ?? {};
  const durl = Array.isArray(payload.durl) ? payload.durl : [];
  if (durl.length > 0) {
    const directUrl = durl[0].url;
    if (directUrl && typeof directUrl === "string") return directUrl;
  }
  const dashVideo = Array.isArray(payload.dash?.video) ? payload.dash!.video : [];
  if (dashVideo.length > 0) {
    const videoUrl = pickDashStreamUrl(dashVideo);
    if (videoUrl) return videoUrl;
  }
  throw new Error("未找到可用视频流");
};
