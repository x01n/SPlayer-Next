/**
 * 一起听协议URL处理
 * 解析 splayer-listentogether:// 链接并自动加入房间
 */

import i18n from "@/i18n";
import { useListenTogetherStore } from "@/stores/listenTogether";
import { useUserStore } from "@/stores/user";
import { toast } from "@/composables/useToast";

const { t } = i18n.global;

/** 是否正在处理协议链接（防止并发加入多个房间） */
let isHandlingUrl = false;

/**
 * 解析一起听分享链接
 * 支持格式：
 * - splayer-listentogether://host:port?roomId=xxx&roomKey=xxx
 * - splayer-listentogether://host:port/i/xxxx（base62 邀请码）
 * @param url - 一起听分享链接
 * @returns 解析结果
 */
export const parseListenTogetherUrl = async (
  url: string,
): Promise<{ serverUrl: string; port: number; roomId: string; roomKey: string } | null> => {
  try {
    const urlObj = new URL(url);
    const configuredServerUrl = urlObj.searchParams.get("serverUrl")?.trim();
    const legacyHost = urlObj.hostname || "127.0.0.1";
    const legacyPort = Number.parseInt(urlObj.port || "14558", 10);
    const serverUrl = configuredServerUrl || legacyHost;
    const parsedServerUrl = configuredServerUrl ? new URL(configuredServerUrl) : null;
    const port = parsedServerUrl
      ? Number.parseInt(
          parsedServerUrl.port ||
            (parsedServerUrl.protocol === "https:" || parsedServerUrl.protocol === "wss:"
              ? "443"
              : "80"),
          10,
        )
      : legacyPort;

    const pathMatch = urlObj.pathname.match(/^\/i\/([^/]+)\/?$/);
    if (pathMatch) {
      const decoded = await window.api.listenTogether.decodeInviteCode(pathMatch[1]);
      if (decoded) {
        return { serverUrl, port, roomId: decoded.roomId, roomKey: decoded.roomKey };
      }
    }

    const roomId = urlObj.searchParams.get("roomId");
    const roomKey = urlObj.searchParams.get("roomKey");
    if (!roomId || !roomKey) return null;

    return { serverUrl, port, roomId, roomKey };
  } catch {
    return null;
  }
};

/**
 * 处理一起听协议URL
 * @param url - 一起听分享链接
 */
export const handleListenTogetherUrl = async (url: string): Promise<void> => {
  if (isHandlingUrl) {
    console.log("[ListenTogether] 已有协议链接正在处理，忽略本次请求");
    return;
  }
  isHandlingUrl = true;

  try {
    const parsed = await parseListenTogetherUrl(url);
    if (!parsed) {
      toast.error(t("listenTogether.protocol.invalidLink"));
      return;
    }

    const store = useListenTogetherStore();
    const userStore = useUserStore();

    if (store.isConnected) {
      toast.warning(t("listenTogether.protocol.alreadyInRoom"));
      return;
    }

    const nickname = userStore.profile?.nickname || "匿名用户";
    const neteaseUserId = userStore.profile?.userId;

    toast.info(t("listenTogether.protocol.joining"));

    const success = await store.joinRoom(
      parsed.serverUrl,
      parsed.port,
      parsed.roomId,
      parsed.roomKey,
      nickname,
      neteaseUserId,
    );

    if (success) {
      toast.success(t("listenTogether.protocol.joinSuccess"));
    } else {
      toast.error(t("listenTogether.protocol.joinFailed"));
    }
  } finally {
    isHandlingUrl = false;
  }
};
