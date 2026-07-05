/**
 * 本地音乐分片下发
 * 房主将本地音乐文件分片通过WS广播给房间成员
 */

import { readFile } from "node:fs/promises";
import { store } from "@main/store";
import { serverLog } from "@main/utils/logger";
import { broadcastToRoom, getRoom } from "./room";
import type { WSContext } from "hono/ws";

const CHUNK_SIZE = 65536; // 64KB

/** 分片缓存：文件路径 -> 分片数据 */
const chunkCache = new Map<string, Uint8Array[]>();

/**
 * 检查曲目是否为在线音乐（不需要分片下发）
 * @param track - 曲目信息
 * @returns 是否是在线音乐
 */
export const isOnlineTrack = (
  track: { source?: { type?: string; url?: string } } | null,
): boolean => {
  if (!track?.source) return false;
  return track.source.type === "streaming" || track.source.type === "online";
};

/**
 * 获取在线音乐URL广播消息
 * @param trackId - 曲目ID
 * @param url - 在线音乐URL
 * @returns 广播消息
 */
export const createOnlineUrlMessage = (trackId: string, url: string): unknown => {
  return {
    kind: "onlineUrl",
    data: {
      trackId,
      url,
    },
  };
};

/**
 * 读取本地音乐文件并分片
 * @param filePath - 本地文件路径
 * @returns 分片列表
 */
export const readFileChunks = async (filePath: string): Promise<Uint8Array[]> => {
  const cached = chunkCache.get(filePath);
  if (cached) return cached;

  const data = await readFile(filePath);
  const chunks: Uint8Array[] = [];
  const chunkSize = store.get("listenTogether.chunkSize") || CHUNK_SIZE;

  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.subarray(i, i + chunkSize));
  }

  chunkCache.set(filePath, chunks);
  serverLog.info(`本地音乐文件已分片: ${filePath}, ${chunks.length} 片`);
  return chunks;
};

/**
 * 向房间广播音乐分片
 * @param roomId - 房间ID
 * @param trackId - 曲目ID
 * @param filePath - 本地文件路径
 * @param trackSource - 曲目来源信息（用于判断是否在线音乐）
 * @param excludeWs - 排除的WS连接（通常是房主自己）
 */
export const broadcastMusicChunks = async (
  roomId: string,
  trackId: string,
  filePath: string,
  trackSource?: { type?: string; url?: string },
  excludeWs?: WSContext,
): Promise<void> => {
  const room = getRoom(roomId);
  if (!room) return;

  // 如果是在线音乐，直接广播URL而不分片
  if (
    trackSource &&
    (trackSource.type === "streaming" || trackSource.type === "online") &&
    trackSource.url
  ) {
    const urlMsg = createOnlineUrlMessage(trackId, trackSource.url);
    broadcastToRoom(roomId, urlMsg, excludeWs);
    serverLog.info(`在线音乐URL广播: ${trackId}, ${trackSource.url}`);
    return;
  }

  try {
    const chunks = await readFileChunks(filePath);
    const totalChunks = chunks.length;

    // 广播分片元信息
    const metaMsg = {
      kind: "chunk",
      data: {
        type: "meta",
        trackId,
        totalChunks,
        filePath,
      },
    };
    broadcastToRoom(roomId, metaMsg, excludeWs);

    // 逐片广播
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkMsg = {
        kind: "chunk",
        data: {
          type: "data",
          trackId,
          index: i,
          total: totalChunks,
          data: Buffer.from(chunk).toString("base64"),
        },
      };
      broadcastToRoom(roomId, chunkMsg, excludeWs);

      // 每10片暂停一下，避免网络拥塞
      if (i > 0 && i % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    // 广播完成
    const doneMsg = {
      kind: "chunk",
      data: {
        type: "done",
        trackId,
      },
    };
    broadcastToRoom(roomId, doneMsg, excludeWs);

    serverLog.info(`本地音乐分片广播完成: ${trackId}, ${totalChunks} 片`);
  } catch (err) {
    serverLog.error(`本地音乐分片广播失败: ${filePath}`, err);
  }
};

/**
 * 清理分片缓存
 * @param filePath - 文件路径，不传则清理全部
 */
export const clearChunkCache = (filePath?: string): void => {
  if (filePath) {
    chunkCache.delete(filePath);
  } else {
    chunkCache.clear();
  }
};
