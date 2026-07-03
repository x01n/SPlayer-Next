/**
 * 一起听 AppLink 协议处理
 * splayer-listentogether://host:port?roomId=xxx&roomKey=xxx
 * splayer-listentogether://host:port/i/xxxx（base62 邀请码）
 */

import { app } from "electron";
import { coreLog } from "@main/utils/logger";
import { getMainWindow } from "@main/window";
import { decodeInviteCode, isValidBase62 } from "@main/utils/base62";

const LISTEN_TOGETHER_SCHEME = "splayer-listentogether";

/** 冷启动暂存的一起听唤起 URL */
let pendingListenTogetherUrl: string | null = null;
/** 渲染层是否已就绪 */
let rendererReady = false;

/**
 * 注册一起听协议处理程序
 */
export const registerListenTogetherProtocol = (): void => {
  app.setAsDefaultProtocolClient(LISTEN_TOGETHER_SCHEME);
  coreLog.info(`[listentogether] 已注册 ${LISTEN_TOGETHER_SCHEME} 协议处理程序`);
};

/**
 * 从命令行参数中提取首个一起听 URL
 */
export const extractListenTogetherUrl = (argv: readonly string[]): string | null => {
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith(`${LISTEN_TOGETHER_SCHEME}://`)) return arg;
  }
  return null;
};

/**
 * 解析一起听分享链接
 * @param url - splayer-listentogether://host:port?roomId=xxx&roomKey=xxx
 * @returns 解析结果
 */
export const parseListenTogetherUrl = (
  url: string,
): { serverUrl: string; port: number; roomId: string; roomKey: string } | null => {
  try {
    const urlObj = new URL(url);
    const serverUrl = urlObj.hostname || "127.0.0.1";
    const port = parseInt(urlObj.port || "14558", 10);

    // 优先解析 /i/ 路径的 base62 邀请码
    const pathMatch = urlObj.pathname.match(/^\/i\/(.+)$/);
    if (pathMatch) {
      const inviteCode = pathMatch[1];
      if (isValidBase62(inviteCode)) {
        try {
          const { roomId, roomKey } = decodeInviteCode(inviteCode);
          return { serverUrl, port, roomId, roomKey };
        } catch {
          coreLog.warn(`[listentogether] 邀请码解码失败: ${inviteCode}`);
        }
      }
    }

    // 兼容旧格式 query 参数
    const roomId = urlObj.searchParams.get("roomId");
    const roomKey = urlObj.searchParams.get("roomKey");

    if (!roomId || !roomKey) return null;

    return { serverUrl, port, roomId, roomKey };
  } catch {
    return null;
  }
};

/**
 * 捕获一起听唤起 URL
 */
export const captureListenTogetherUrl = (url: string): void => {
  const win = getMainWindow();
  if (rendererReady && win) {
    win.webContents.send("protocol:listenTogether", url);
  } else {
    pendingListenTogetherUrl = url;
  }
  coreLog.info("[listentogether] 捕获唤起 URL", url);
};

/**
 * 渲染层拉取冷启动暂存的一起听唤起 URL
 */
export const consumePendingListenTogetherUrl = (): string | null => {
  rendererReady = true;
  const url = pendingListenTogetherUrl;
  pendingListenTogetherUrl = null;
  return url;
};

/** 在应用核心初始化时注册协议 */
export const initListenTogetherProtocol = (): void => {
  registerListenTogetherProtocol();
};
