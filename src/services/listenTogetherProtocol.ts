/**
 * 一起听协议URL处理
 * 解析 splayer-listentogether:// 链接并自动加入房间
 */

import i18n from "@/i18n";
import { useListenTogetherStore } from "@/stores/listenTogether";
import { useUserStore } from "@/stores/user";
import { toast } from "@/composables/useToast";

const { t } = i18n.global;

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
    const serverUrl = urlObj.hostname || "127.0.0.1";
    const port = parseInt(urlObj.port || "14558", 10);

    // 优先解析 /i/ 路径的 base62 邀请码
    const pathMatch = urlObj.pathname.match(/^\/i\/(.+)$/);
    if (pathMatch) {
      const inviteCode = pathMatch[1];
      const decoded = await window.api.listenTogether.decodeInviteCode(inviteCode);
      if (decoded) {
        return { serverUrl, port, roomId: decoded.roomId, roomKey: decoded.roomKey };
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
 * 处理一起听协议URL
 * @param url - 一起听分享链接
 */
export const handleListenTogetherUrl = async (url: string): Promise<void> => {
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
};
