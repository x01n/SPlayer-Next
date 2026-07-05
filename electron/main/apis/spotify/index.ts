/**
 * Spotify 主进程服务
 *
 * 与 qqmusic 类似：无持久化 session，access token 内存缓存 1 小时
 * 统一入口：callSpotify(name, params)
 */

import { createHash } from "node:crypto";
import { modules } from "./modules";

/** 2 分钟响应缓存 */
const DEFAULT_TTL = 2 * 60 * 1000;
const MAX_ENTRIES = 200;

interface CacheEntry {
  value: unknown;
  expireAt: number;
}

const cache = new Map<string, CacheEntry>();

const hashParams = (params: unknown): string =>
  createHash("md5")
    .update(JSON.stringify(params ?? {}))
    .digest("hex")
    .slice(0, 8);

const cacheGet = (key: string): unknown => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expireAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
};

const cacheSet = (key: string, value: unknown, ttl = DEFAULT_TTL): void => {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expireAt: Date.now() + ttl });
};

export const clearSpotifyCache = (): void => {
  cache.clear();
};

/**
 * 调用任意 Spotify API
 * @param name  见 modules/index.ts 中的 key（search / song_url）
 * @param params 业务参数；不想命中缓存可传 `timestamp: Date.now()`
 */
export const callSpotify = async (
  name: string,
  params: Record<string, unknown> = {},
): Promise<any> => {
  // hasOwn 守卫
  const fn = Object.hasOwn(modules, name) ? modules[name] : undefined;
  if (!fn) throw new Error(`unknown spotify api: ${name}`);

  const key = `${name}|${hashParams(params)}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const value = await fn(params);
  cacheSet(key, value);
  return value;
};
