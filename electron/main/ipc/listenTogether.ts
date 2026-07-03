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

/** 当前活跃的本地房间（作为房主） */
let localRoom: (ListenTogetherRoom & { roomKey: string; hostToken: string }) | null = null;

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
      serverLog.info(`[ListenTogether] IPC 创建房间请求, nickname=${nickname}, roomName=${roomName ?? "default"}`);
      if (!isListenTogetherEnabled()) {
        serverLog.info("[ListenTogether] 创建房间失败: 一起听功能未启用");
        return { ok: false, error: "一起听功能未启用" };
      }
      if (!store.get("listenTogether.authKey" as ConfigPath)) {
        serverLog.info("[ListenTogether] 创建房间失败: 未设置鉴权密钥");
        return { ok: false, error: "请先设置鉴权密钥" };
      }
      // 验证传入的鉴权密钥
      if (authKey !== store.get("listenTogether.authKey" as ConfigPath)) {
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
        localRoom = result;
        serverLog.info(`[ListenTogether] 房间创建成功, roomId=${localRoom.id}, name=${localRoom.name}`);

        // 监听播放状态变化，同步到房间并广播
        unsubTrackChange = nowPlaying.onTrackChange(({ track }) => {
          serverLog.info(`[ListenTogether] 检测到播放曲目变化, track=${track?.title ?? "null"}`);
          if (!localRoom) return;
          // 切歌过程中间可能出现 track=null 的过渡状态，此时只更新本地状态不广播，避免客户端收到 trackId=null
          if (!track) {
            localRoom.currentTrack = null;
            serverLog.info("[ListenTogether] 播放曲目变化为 null，跳过同步广播");
            return;
          }
          // 更新 localRoom 副本的 currentTrack，避免 onPositionSync 使用旧值
          localRoom.currentTrack = track as Track;
          const syncState = getRoomSyncState(localRoom.id);
          if (syncState) {
            // 切歌时重置位置为 0，避免广播旧歌的残余位置
            setRoomPlayback(
              localRoom.id,
              track as Track,
              0,
              syncState.isPlaying,
              localRoom.hostId,
            );
            lastPlayingState = syncState.isPlaying;
            broadcastSync(localRoom.id);
          }
        });

        unsubPositionSync = nowPlaying.onPositionSync((data) => {
          serverLog.info(`[ListenTogether] 检测到播放位置同步, position=${data.position}, playing=${data.playing}`);
          if (!localRoom) return;
          // 使用 rooms 中的最新 currentTrack，避免 localRoom 副本未同步
          const room = getRoom(localRoom.id);
          const currentTrack = room?.currentTrack ?? localRoom.currentTrack;
          setRoomPlayback(
            localRoom.id,
            currentTrack,
            data.position,
            data.playing,
            localRoom.hostId,
          );
          // 只在播放/暂停状态发生变化时立即广播，避免 position 推送（约200ms）造成消息洪泛
          if (data.playing !== lastPlayingState) {
            lastPlayingState = data.playing;
            serverLog.info(`[ListenTogether] 播放状态变化，立即广播: isPlaying=${data.playing}`);
            broadcastSync(localRoom.id);
          }
        });

        // 房主加入 WS 时 handleJoin 会启动带快照检测的同步定时器，此处不再重复启动

        serverLog.info(`[ListenTogether] IPC 创建一起听房间成功: ${localRoom.id}`);

        return {
          ok: true,
          room: {
            id: localRoom.id,
            name: localRoom.name,
            hostId: localRoom.hostId,
            members: localRoom.members,
            state: localRoom.state,
            createdAt: localRoom.createdAt,
          },
          roomKey: localRoom.roomKey,
          hostToken: localRoom.hostToken,
        };
      } catch (err) {
        serverLog.info(`[ListenTogether] 创建房间异常: ${err instanceof Error ? err.message : String(err)}`);
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
    if (!localRoom) return null;
    return {
      id: localRoom.id,
      name: localRoom.name,
      hostId: localRoom.hostId,
      members: localRoom.members,
      state: localRoom.state,
      currentTrack: localRoom.currentTrack,
      createdAt: localRoom.createdAt,
    };
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
    const room = getRoom(roomId);
    if (!room) {
      serverLog.info(`[ListenTogether] 获取分享链接失败: 房间不存在, roomId=${roomId}`);
      return null;
    }
    const key = localRoom?.roomKey ?? "";
    const port = store.get("externalApi.port") || 14558;
    const allowLan = store.get("externalApi.allowLan") || false;
    const host = allowLan ? (getLanAddress() ?? "127.0.0.1") : "127.0.0.1";

    // 使用 base62 编码邀请码
    const inviteCode = encodeInviteCode(roomId, key);
    const link = `splayer-listentogether://${host}:${port}/i/${inviteCode}`;
    serverLog.info(`[ListenTogether] 分享链接生成成功: ${link}`);
    return link;
  });

  // 获取原始分享链接（兼容旧格式）
  ipcMain.handle("listenTogether:getRawShareLink", (_e, roomId: string) => {
    serverLog.info(`[ListenTogether] IPC 获取原始分享链接, roomId=${roomId}`);
    const room = getRoom(roomId);
    if (!room) {
      serverLog.info(`[ListenTogether] 获取原始分享链接失败: 房间不存在, roomId=${roomId}`);
      return null;
    }
    const key = localRoom?.roomKey ?? "";
    const port = store.get("externalApi.port") || 14558;
    const allowLan = store.get("externalApi.allowLan") || false;
    const host = allowLan ? (getLanAddress() ?? "127.0.0.1") : "127.0.0.1";
    const link = `splayer-listentogether://${host}:${port}?roomId=${roomId}&roomKey=${key}`;
    serverLog.info(`[ListenTogether] 原始分享链接生成成功: ${link}`);
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
    if (!localRoom || localRoom.id !== roomId) {
      serverLog.info(`[ListenTogether] 踢出成员失败: 无权操作此房间, roomId=${roomId}`);
      return { ok: false, error: "无权操作此房间" };
    }
    const result = kickMember(roomId, localRoom.hostId, memberId);
    serverLog.info(`[ListenTogether] 踢出成员结果: ${result}, roomId=${roomId}, memberId=${memberId}`);
    return { ok: result };
  });

  // 拉黑成员
  ipcMain.handle("listenTogether:blacklistMember", (_e, roomId: string, memberId: string) => {
    serverLog.info(`[ListenTogether] IPC 拉黑成员, roomId=${roomId}, memberId=${memberId}`);
    if (!localRoom || localRoom.id !== roomId) {
      serverLog.info(`[ListenTogether] 拉黑成员失败: 无权操作此房间, roomId=${roomId}`);
      return { ok: false, error: "无权操作此房间" };
    }
    const result = blacklistMember(roomId, localRoom.hostId, memberId);
    serverLog.info(`[ListenTogether] 拉黑成员结果: ${result}, roomId=${roomId}, memberId=${memberId}`);
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
      serverLog.info(`[ListenTogether] 邀请码解码失败: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });

  serverLog.info("[ListenTogether] 一起听 IPC 处理注册完成");
};

/** 获取本地房间 */
export const getLocalRoom = (): (ListenTogetherRoom & { roomKey: string; hostToken: string }) | null => {
  serverLog.info(`[ListenTogether] 获取本地房间, localRoom=${localRoom?.id ?? "null"}`);
  return localRoom;
};

/** 设置本地房间 */
export const setLocalRoom = (room: (ListenTogetherRoom & { roomKey: string; hostToken: string }) | null): void => {
  serverLog.info(`[ListenTogether] 设置本地房间, roomId=${room?.id ?? "null"}`);
  localRoom = room;
};
