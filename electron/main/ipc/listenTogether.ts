/**
 * 一起听 IPC 处理
 * 负责主进程与渲染进程之间的一起听相关通信
 */

import { ipcMain } from "electron";
import os from "node:os";
import { serverLog } from "@main/utils/logger";
import { store } from "@main/store";
import type { ConfigPath } from "@main/store/types";
import { encodeInviteCode, decodeInviteCode } from "@main/utils/base62";
import {
  createRoom,
  closeRoom,
  getRoom,
  isListenTogetherEnabled,
  verifyAuthKey,
  getRoomSyncState,
  broadcastToRoom,
  stopSyncTimer,
  setRoomPlayback,
  kickMember,
  blacklistMember,
} from "@main/server/listenTogether/room";
import * as nowPlaying from "@main/services/nowPlaying";
import type { Track } from "@shared/types/player";
import type { ListenTogetherRoom } from "@shared/types/listenTogether";

interface LocalRoomRef {
  id: string;
  roomKey: string;
  hostToken: string;
  hostId: string;
}

/** 当前活跃的本地房间身份；房间状态始终从 rooms 读取 */
let localRoom: LocalRoomRef | null = null;

const toRoomPayload = (room: ListenTogetherRoom): ListenTogetherRoom => ({
  id: room.id,
  name: room.name,
  hostId: room.hostId,
  members: room.members,
  blacklist: room.blacklist,
  state: room.state,
  currentTrack: room.currentTrack,
  position: room.position,
  positionUpdatedAt: room.positionUpdatedAt,
  createdAt: room.createdAt,
  controllerId: room.controllerId,
  cryptoKey: room.cryptoKey,
  queue: room.queue,
});

const getActiveRoom = (): ListenTogetherRoom | null => {
  if (!localRoom) return null;
  const room = getRoom(localRoom.id);
  if (!room) localRoom = null;
  return room ?? null;
};

/** 播放状态监听卸载函数 */
let unsubTrackChange: (() => void) | null = null;
let unsubPositionSync: (() => void) | null = null;
/** 上次播放状态，用于在位置同步中检测播放/暂停变化 */
let lastPlayingState = false;

/**
 * 取局域网地址，优先常见家用/企业网段
 */
const getLanAddress = (): string | null => {
  serverLog.info("[ListenTogether] 开始获取局域网地址");
  const candidates: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) candidates.push(item.address);
    }
  }
  const result =
    candidates.find((address) => address.startsWith("192.168.")) ??
    candidates.find((address) => address.startsWith("10.")) ??
    candidates[0] ??
    null;
  serverLog.info(`[ListenTogether] 获取到局域网地址: ${result}`);
  return result;
};

/**
 * 广播同步状态到房间内所有成员
 */
const getPublishedServerUrl = (): string => {
  const configured = String(store.get("listenTogether.serverUrl" as ConfigPath) ?? "").trim();
  if (configured) {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(configured)
      ? configured
      : `http://${configured}`;
    return withProtocol.replace(/\/+$/, "");
  }

  const port = store.get("externalApi.port") || 14558;
  const allowLan = store.get("externalApi.allowLan") || false;
  const host = allowLan ? (getLanAddress() ?? "127.0.0.1") : "127.0.0.1";
  return `http://${host}:${port}`;
};

const buildInviteLink = (roomId: string, roomKey: string): string => {
  const inviteCode = encodeInviteCode(roomId, roomKey);
  const serverUrl = encodeURIComponent(getPublishedServerUrl());
  return `splayer-listentogether://join/i/${inviteCode}?serverUrl=${serverUrl}`;
};

const buildRawInviteLink = (roomId: string, roomKey: string): string => {
  const params = new URLSearchParams({
    serverUrl: getPublishedServerUrl(),
    roomId,
    roomKey,
  });
  return `splayer-listentogether://join?${params.toString()}`;
};

const broadcastSync = (roomId: string): void => {
  serverLog.info(`[ListenTogether] 开始广播同步状态, roomId=${roomId}`);
  const syncState = getRoomSyncState(roomId);
  if (syncState) {
    broadcastToRoom(roomId, { kind: "sync", data: syncState });
    serverLog.info(`[ListenTogether] 同步状态已广播, roomId=${roomId}`);
  } else {
    serverLog.info(`[ListenTogether] 未获取到同步状态, roomId=${roomId}`);
  }
};

/** 注册一起听 IPC 处理 */
export const registerListenTogetherIpc = (): void => {
  serverLog.info("[ListenTogether] 注册一起听 IPC 处理");

  // 创建房间
  ipcMain.handle(
    "listenTogether:createRoom",
    (_e, nickname: string, neteaseUserId?: number, authKey?: string, roomName?: string) => {
      serverLog.info(
        `[ListenTogether] IPC 创建房间请求, nickname=${nickname}, roomName=${roomName ?? "default"}`,
      );
      if (!isListenTogetherEnabled()) {
        serverLog.info("[ListenTogether] 创建房间失败: 一起听功能未启用");
        return { ok: false, error: "一起听功能未启用" };
      }
      if (!store.get("listenTogether.authKey" as ConfigPath)) {
        serverLog.info("[ListenTogether] 创建房间失败: 未设置鉴权密钥");
        return { ok: false, error: "请先设置鉴权密钥" };
      }
      if (!authKey || !verifyAuthKey(authKey)) {
        serverLog.info("[ListenTogether] 创建房间失败: 鉴权密钥不正确");
        return { ok: false, error: "鉴权密钥不正确" };
      }

      try {
        // 清理旧房间
        if (localRoom) {
          serverLog.info(`[ListenTogether] 清理旧房间, roomId=${localRoom.id}`);
          stopSyncTimer(localRoom.id);
          closeRoom(localRoom.id);
          unsubTrackChange?.();
          unsubPositionSync?.();
          unsubTrackChange = null;
          unsubPositionSync = null;
          serverLog.info(`[ListenTogether] 旧房间已清理, roomId=${localRoom.id}`);
        }

        const result = createRoom(nickname, neteaseUserId, roomName);
        localRoom = {
          id: result.id,
          roomKey: result.roomKey,
          hostToken: result.hostToken,
          hostId: result.hostId,
        };
        serverLog.info(`[ListenTogether] 房间创建成功, roomId=${result.id}, name=${result.name}`);

        // 监听播放状态变化，同步到房间并广播
        unsubTrackChange = nowPlaying.onTrackChange(({ track }) => {
          serverLog.info(`[ListenTogether] 检测到播放曲目变化, track=${track?.title ?? "null"}`);
          if (!localRoom) return;
          if (!track) {
            serverLog.info("[ListenTogether] 播放曲目变化为 null，跳过同步广播");
            return;
          }
          const room = getActiveRoom();
          if (!room) return;
          const syncState = getRoomSyncState(room.id);
          if (syncState) {
            setRoomPlayback(room.id, track as Track, 0, syncState.isPlaying, localRoom.hostId);
            lastPlayingState = syncState.isPlaying;
            broadcastSync(room.id);
          }
        });

        unsubPositionSync = nowPlaying.onPositionSync((data) => {
          serverLog.info(
            `[ListenTogether] 检测到播放位置同步, position=${data.position}, playing=${data.playing}`,
          );
          if (!localRoom) return;
          const room = getActiveRoom();
          if (!room) return;
          setRoomPlayback(
            room.id,
            room.currentTrack,
            data.position,
            data.playing,
            localRoom.hostId,
          );
          if (data.playing !== lastPlayingState) {
            lastPlayingState = data.playing;
            serverLog.info(`[ListenTogether] 播放状态变化，立即广播: isPlaying=${data.playing}`);
            broadcastSync(room.id);
          }
        });

        // 房主加入 WS 时 handleJoin 会启动带快照检测的同步定时器，此处不再重复启动

        const room = getActiveRoom();
        if (!room) {
          throw new Error("房间创建后未找到房间状态");
        }

        serverLog.info(`[ListenTogether] IPC 创建一起听房间成功: ${room.id}`);

        return {
          ok: true,
          room: toRoomPayload(room),
          roomKey: localRoom.roomKey,
          hostToken: localRoom.hostToken,
        };
      } catch (err) {
        unsubTrackChange?.();
        unsubPositionSync?.();
        unsubTrackChange = null;
        unsubPositionSync = null;
        localRoom = null;
        serverLog.info(
          `[ListenTogether] 创建房间异常: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // 关闭房间
  ipcMain.handle("listenTogether:closeRoom", (_e, roomId: string) => {
    serverLog.info(`[ListenTogether] IPC 关闭房间请求, roomId=${roomId}`);
    if (localRoom && localRoom.id === roomId) {
      stopSyncTimer(roomId);
      unsubTrackChange?.();
      unsubPositionSync?.();
      unsubTrackChange = null;
      unsubPositionSync = null;
      closeRoom(roomId);
      localRoom = null;
      serverLog.info(`[ListenTogether] IPC 关闭一起听房间成功: ${roomId}`);
      return { ok: true };
    }
    serverLog.info(`[ListenTogether] 关闭房间失败: 无权关闭此房间, roomId=${roomId}`);
    return { ok: false, error: "无权关闭此房间" };
  });

  // 获取当前房间信息
  ipcMain.handle("listenTogether:getRoom", () => {
    serverLog.info(`[ListenTogether] IPC 获取房间信息, localRoom=${localRoom?.id ?? "null"}`);
    const room = getActiveRoom();
    if (!room) return null;
    return toRoomPayload(room);
  });

  // 获取房间密钥
  ipcMain.handle("listenTogether:getRoomKey", () => {
    serverLog.info(`[ListenTogether] IPC 获取房间密钥, localRoom=${localRoom?.id ?? "null"}`);
    if (!localRoom) return null;
    return localRoom.roomKey;
  });

  // 获取分享链接（base62压缩格式）
  ipcMain.handle("listenTogether:getShareLink", (_e, roomId: string) => {
    serverLog.info(`[ListenTogether] IPC 获取分享链接, roomId=${roomId}`);
    if (!localRoom || localRoom.id !== roomId) {
      serverLog.info(`[ListenTogether] 获取分享链接失败: 不是当前房间的房主, roomId=${roomId}`);
      return null;
    }
    const room = getActiveRoom();
    if (!room || room.id !== roomId) {
      serverLog.info(`[ListenTogether] 获取分享链接失败: 房间不存在, roomId=${roomId}`);
      return null;
    }
    const link = buildInviteLink(roomId, localRoom.roomKey);
    serverLog.info(`[ListenTogether] 分享链接生成成功, roomId=${roomId}`);
    return link;
  });

  // 获取原始分享链接（兼容旧格式）
  ipcMain.handle("listenTogether:getRawShareLink", (_e, roomId: string) => {
    serverLog.info(`[ListenTogether] IPC 获取原始分享链接, roomId=${roomId}`);
    if (!localRoom || localRoom.id !== roomId) {
      serverLog.info(`[ListenTogether] 获取原始分享链接失败: 不是当前房间的房主, roomId=${roomId}`);
      return null;
    }
    const room = getActiveRoom();
    if (!room || room.id !== roomId) {
      serverLog.info(`[ListenTogether] 获取原始分享链接失败: 房间不存在, roomId=${roomId}`);
      return null;
    }
    const link = buildRawInviteLink(roomId, localRoom.roomKey);
    serverLog.info(`[ListenTogether] 原始分享链接生成成功, roomId=${roomId}`);
    return link;
  });

  // 检查一起听是否启用
  ipcMain.handle("listenTogether:isEnabled", () => {
    serverLog.info(`[ListenTogether] IPC 检查一起听是否启用`);
    return isListenTogetherEnabled();
  });

  // 验证鉴权密钥
  ipcMain.handle("listenTogether:verifyAuthKey", (_e, key: string) => {
    serverLog.info(`[ListenTogether] IPC 验证鉴权密钥`);
    return verifyAuthKey(key);
  });

  // 踢出成员
  ipcMain.handle("listenTogether:kickMember", (_e, roomId: string, memberId: string) => {
    serverLog.info(`[ListenTogether] IPC 踢出成员, roomId=${roomId}, memberId=${memberId}`);
    const room = getActiveRoom();
    if (!localRoom || !room || room.id !== roomId) {
      serverLog.info(`[ListenTogether] 踢出成员失败: 无权操作此房间, roomId=${roomId}`);
      return { ok: false, error: "无权操作此房间" };
    }
    const result = kickMember(roomId, localRoom.hostId, memberId);
    serverLog.info(
      `[ListenTogether] 踢出成员结果: ${result}, roomId=${roomId}, memberId=${memberId}`,
    );
    return { ok: result };
  });

  // 拉黑成员
  ipcMain.handle("listenTogether:blacklistMember", (_e, roomId: string, memberId: string) => {
    serverLog.info(`[ListenTogether] IPC 拉黑成员, roomId=${roomId}, memberId=${memberId}`);
    const room = getActiveRoom();
    if (!localRoom || !room || room.id !== roomId) {
      serverLog.info(`[ListenTogether] 拉黑成员失败: 无权操作此房间, roomId=${roomId}`);
      return { ok: false, error: "无权操作此房间" };
    }
    const result = blacklistMember(roomId, localRoom.hostId, memberId);
    serverLog.info(
      `[ListenTogether] 拉黑成员结果: ${result}, roomId=${roomId}, memberId=${memberId}`,
    );
    return { ok: result };
  });

  // 解码 base62 邀请码
  ipcMain.handle("listenTogether:decodeInviteCode", (_e, code: string) => {
    serverLog.info(`[ListenTogether] IPC 解码邀请码, code=${code}`);
    try {
      const decoded = decodeInviteCode(code);
      serverLog.info(`[ListenTogether] 邀请码解码成功: ${JSON.stringify(decoded)}`);
      return decoded;
    } catch (err) {
      serverLog.info(
        `[ListenTogether] 邀请码解码失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  });

  serverLog.info("[ListenTogether] 一起听 IPC 处理注册完成");
};

/** 获取本地房间 */
export const getLocalRoom = (): LocalRoomRef | null => {
  serverLog.info(`[ListenTogether] 获取本地房间, localRoom=${localRoom?.id ?? "null"}`);
  return localRoom;
};

/** 设置本地房间 */
export const setLocalRoom = (room: LocalRoomRef | null): void => {
  serverLog.info(`[ListenTogether] 设置本地房间, roomId=${room?.id ?? "null"}`);
  localRoom = room;
};
