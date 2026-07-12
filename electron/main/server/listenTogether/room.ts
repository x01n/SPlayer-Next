/**
 * 一起听房间管理
 * 负责房间的创建、销毁、成员管理和状态同步
 */

import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import type { WSContext } from "hono/ws";
import type { Track } from "@shared/types/player";
import type {
  ListenTogetherRoom,
  ListenTogetherMember,
  ListenTogetherChatMessage,
  ListenTogetherActionProposal,
  ListenTogetherQueueItem,
  ListenTogetherSyncState,
  ListenTogetherAudioSource,
} from "@shared/types/listenTogether";
import { serverLog } from "@main/utils/logger";
import { store } from "@main/store";

/** 房间密钥映射（不暴露给客户端） */
const roomKeyMap = new Map<string, string>();
/** 房主令牌映射：roomId -> hostToken（房主凭此token通过WS加入，避免重复创建成员） */
const hostTokenMap = new Map<string, string>();
/** 提案ID到房间ID的映射 */
const proposalRoomMap = new Map<string, string>();

/** 房间存储：房间ID -> 房间 */
const rooms = new Map<string, ListenTogetherRoom>();
const MAX_ACTIVE_ROOMS = 64;
const MAX_ROOM_MEMBERS = 50;
const HOST_DISCONNECT_TTL = 30 * 60 * 1000;
const EMPTY_ROOM_TTL = 120 * 60 * 1000;
const roomExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 成员令牌映射：token -> { roomId, memberId } */
const tokenMap = new Map<string, { roomId: string; memberId: string }>();
/** WS上下文映射：ws -> token */
export const wsTokenMap = new Map<WSContext, string>();

const closeWsQuietly = (ws: WSContext): void => {
  wsTokenMap.delete(ws);
  try {
    ws.close();
  } catch {
    // 忽略已关闭连接
  }
};

const closeMemberSockets = (roomId: string, memberId: string, exceptWs?: WSContext): void => {
  const removedTokens: string[] = [];
  for (const [token, info] of tokenMap.entries()) {
    if (info.roomId === roomId && info.memberId === memberId) {
      removedTokens.push(token);
    }
  }

  for (const [ws, token] of wsTokenMap.entries()) {
    if (ws === exceptWs || !removedTokens.includes(token)) continue;
    closeWsQuietly(ws);
  }

  for (const token of removedTokens) {
    tokenMap.delete(token);
  }
};
/** 聊天消息缓存：房间ID -> 消息列表（上限100条） */
const chatHistory = new Map<string, ListenTogetherChatMessage[]>();
/** 活跃投票：提案ID -> 提案 */
const activeProposals = new Map<string, ListenTogetherActionProposal>();
/** 同步定时器：房间ID -> timer */
const syncTimers = new Map<string, ReturnType<typeof setInterval>>();
/** 上次广播的同步状态快照：房间ID -> key */
const lastBroadcastSnapshots = new Map<string, string>();
/** 成员音源存储：房间ID -> Map<成员ID, 音源信息> */
const memberAudioSources = new Map<string, Map<string, ListenTogetherAudioSource>>();
/** 房间消息序列号计数器：房间ID -> 当前seqId */
const messageSeqCounters = new Map<string, number>();

const MAX_CHAT_HISTORY = 100;
const DEFAULT_SYNC_INTERVAL = 8000;

/** 生成唯一房间ID */
const generateRoomId = (): string => {
  serverLog.info(`[ListenTogether] 生成房间ID`);
  return randomUUID().slice(0, 8);
};

/** 生成成员令牌 */
const generateToken = (): string => {
  return randomUUID();
};

/** 生成房间密钥 */
const generateRoomKey = (): string => {
  return randomBytes(4).toString("hex").toUpperCase();
};

/** 生成加密密钥 */
const generateCryptoKey = (): string => {
  return randomUUID().replace(/-/g, "").slice(0, 16);
};

/**
 * 创建房间
 * @param hostNickname - 房主昵称
 * @param hostNeteaseUserId - 房主网易云用户ID（可选）
 * @param roomName - 房间名称（可选，覆盖默认设置）
 * @returns 创建的Room对象（包含roomKey和hostToken）
 */
export const createRoom = (
  hostNickname: string,
  hostNeteaseUserId?: number,
  roomName?: string,
): ListenTogetherRoom & { roomKey: string; hostToken: string } => {
  serverLog.info(`[ListenTogether] 开始创建房间，房主昵称: ${hostNickname}`);
  if (rooms.size >= MAX_ACTIVE_ROOMS) {
    throw new Error("活跃房间数量已达上限");
  }

  const roomId = generateRoomId();
  const hostId = randomUUID();
  const roomKey = generateRoomKey();
  const hostToken = generateToken();

  const room: ListenTogetherRoom = {
    id: roomId,
    name: roomName || store.get("listenTogether.defaultRoomName") || "一起听房间",
    hostId,
    members: [
      {
        id: hostId,
        nickname: hostNickname,
        role: "host",
        neteaseUserId: hostNeteaseUserId,
        joinedAt: Date.now(),
        lastActiveAt: Date.now(),
        online: true,
      },
    ],
    blacklist: [],
    state: "waiting",
    currentTrack: null,
    position: 0,
    positionUpdatedAt: Date.now(),
    createdAt: Date.now(),
    controllerId: hostId,
    cryptoKey: generateCryptoKey(),
    queue: [],
  };

  rooms.set(roomId, room);
  roomKeyMap.set(roomId, roomKey);
  hostTokenMap.set(roomId, hostToken);
  chatHistory.set(roomId, []);
  messageSeqCounters.set(roomId, 0);

  // 房主token也注册到tokenMap，但暂不关联WS（WS连接时通过hostToken识别）
  tokenMap.set(hostToken, { roomId, memberId: hostId });

  serverLog.info(
    `[ListenTogether] 一起听房间已创建: ${roomId}, 房主: ${hostNickname}, 成员数: ${room.members.length}`,
  );

  return { ...room, roomKey, hostToken };
};

/** 关闭房间 */
export const closeRoom = (roomId: string): boolean => {
  serverLog.info(`[ListenTogether] 开始关闭房间: ${roomId}`);
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 关闭房间失败，房间不存在: ${roomId}`);
    return false;
  }

  const closingTokens = new Set<string>();
  for (const [token, info] of tokenMap.entries()) {
    if (info.roomId === roomId) {
      closingTokens.add(token);
    }
  }

  const closeMessage = JSON.stringify({ kind: "roomClosed" });
  for (const [ws, token] of wsTokenMap.entries()) {
    if (!closingTokens.has(token)) continue;
    try {
      ws.send(closeMessage);
    } catch {
      // 忽略发送失败的连接
    }
    closeWsQuietly(ws);
  }

  const timer = syncTimers.get(roomId);
  if (timer) {
    clearInterval(timer);
    syncTimers.delete(roomId);
    serverLog.info(`[ListenTogether] 房间同步定时器已停止: ${roomId}`);
  }

  for (const token of closingTokens) {
    tokenMap.delete(token);
  }

  for (const [proposalId, pRoomId] of proposalRoomMap.entries()) {
    if (pRoomId === roomId) {
      proposalRoomMap.delete(proposalId);
      activeProposals.delete(proposalId);
    }
  }

  const expiryTimer = roomExpiryTimers.get(roomId);
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    roomExpiryTimers.delete(roomId);
  }

  rooms.delete(roomId);
  roomKeyMap.delete(roomId);
  hostTokenMap.delete(roomId);
  chatHistory.delete(roomId);
  lastBroadcastSnapshots.delete(roomId);
  memberAudioSources.delete(roomId);
  messageSeqCounters.delete(roomId);

  serverLog.info(`[ListenTogether] 一起听房间已关闭: ${roomId}`);
  return true;
};

const scheduleRoomExpiry = (roomId: string): void => {
  const activeTimer = roomExpiryTimers.get(roomId);
  if (activeTimer) {
    clearTimeout(activeTimer);
    roomExpiryTimers.delete(roomId);
  }

  const room = rooms.get(roomId);
  if (!room) return;

  const host = room.members.find((member) => member.id === room.hostId);
  const deadlines: number[] = [];
  if (host && !host.online && host.disconnectedAt !== undefined) {
    deadlines.push(host.disconnectedAt + HOST_DISCONNECT_TTL);
  }

  if (!room.members.some((member) => member.online)) {
    const lastDisconnectAt = Math.max(
      ...room.members.map((member) => member.disconnectedAt ?? member.lastActiveAt),
    );
    deadlines.push(lastDisconnectAt + EMPTY_ROOM_TTL);
  }

  if (deadlines.length === 0) return;

  const expiresAt = Math.min(...deadlines);
  const timer = setTimeout(() => {
    roomExpiryTimers.delete(roomId);
    const currentRoom = rooms.get(roomId);
    if (!currentRoom) return;

    const now = Date.now();
    const currentHost = currentRoom.members.find((member) => member.id === currentRoom.hostId);
    const hostExpired =
      currentHost !== undefined &&
      !currentHost.online &&
      currentHost.disconnectedAt !== undefined &&
      now >= currentHost.disconnectedAt + HOST_DISCONNECT_TTL;
    const hasOnlineMember = currentRoom.members.some((member) => member.online);
    const lastDisconnectAt = Math.max(
      ...currentRoom.members.map((member) => member.disconnectedAt ?? member.lastActiveAt),
    );
    const emptyRoomExpired =
      !hasOnlineMember && now >= lastDisconnectAt + EMPTY_ROOM_TTL;

    if (hostExpired || emptyRoomExpired) {
      serverLog.info(
        `[ListenTogether] 房间已到保留期限，关闭房间: ${roomId}, reason=${hostExpired ? "host-timeout" : "empty-timeout"}`,
      );
      closeRoom(roomId);
      return;
    }

    scheduleRoomExpiry(roomId);
  }, Math.max(0, expiresAt - Date.now()));

  roomExpiryTimers.set(roomId, timer);
};

/**
 * 加入房间
 * @param roomId - 房间ID
 * @param roomKey - 房间密钥（房主可用hostToken代替）
 * @param nickname - 昵称
 * @param neteaseUserId - 网易云用户ID（可选）
 * @returns 加入结果
 */
export const joinRoom = (
  roomId: string,
  roomKey: string,
  nickname: string,
  neteaseUserId?: number,
): {
  ok: boolean;
  token?: string;
  room?: ListenTogetherRoom;
  cryptoKey?: string;
  memberId?: string;
  error?: string;
} => {
  serverLog.info(`[ListenTogether] 成员尝试加入房间: ${roomId}, 昵称: ${nickname}`);
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 加入房间失败，房间不存在: ${roomId}`);
    return { ok: false, error: "房间不存在" };
  }

  const storedKey = roomKeyMap.get(roomId);
  const storedHostToken = hostTokenMap.get(roomId);

  // 判断是否为房主用hostToken加入
  const isHostRejoin = storedHostToken && roomKey === storedHostToken;

  if (!isHostRejoin && storedKey && storedKey !== roomKey) {
    serverLog.info(`[ListenTogether] 加入房间失败，密钥错误: ${roomId}`);
    return { ok: false, error: "房间密钥错误" };
  }

  if (!isHostRejoin && room.members.length >= MAX_ROOM_MEMBERS) {
    serverLog.info(`[ListenTogether] 加入房间失败，房间人数已达上限: ${roomId}`);
    return { ok: false, error: "房间人数已达上限" };
  }

  // 房主重新加入：复用已有成员，生成新WS会话token
  if (isHostRejoin) {
    serverLog.info(`[ListenTogether] 房主尝试重新加入房间: ${roomId}, ${nickname}`);
    const hostMember = room.members.find((m) => m.id === room.hostId);
    if (!hostMember) {
      serverLog.info(`[ListenTogether] 房主重新加入失败，房主信息异常: ${roomId}`);
      return { ok: false, error: "房主信息异常" };
    }

    closeMemberSockets(roomId, room.hostId);

    // 生成新的WS会话token
    const wsToken = generateToken();
    tokenMap.set(wsToken, { roomId, memberId: room.hostId });
    hostMember.lastActiveAt = Date.now();
    hostMember.online = true;
    delete hostMember.disconnectedAt;
    scheduleRoomExpiry(roomId);

    serverLog.info(
      `[ListenTogether] 房主重新加入房间成功: ${roomId}, ${nickname}`,
    );
    return { ok: true, token: wsToken, room, cryptoKey: room.cryptoKey, memberId: room.hostId };
  }

  // 普通成员加入
  const memberId = randomUUID();
  const token = generateToken();

  // 检查是否在黑名单中（基于 neteaseUserId，避免随机 memberId 永不命中）
  if (neteaseUserId !== undefined) {
    const neteaseIdStr = String(neteaseUserId);
    if (room.blacklist.includes(neteaseIdStr)) {
      serverLog.info(
        `[ListenTogether] 加入房间失败，成员在黑名单中: ${roomId}, neteaseUserId=${neteaseUserId}`,
      );
      return { ok: false, error: "房间不存在" };
    }
  } else if (room.blacklist.length > 0) {
    // 匿名用户且黑名单非空，拒绝加入
    serverLog.info(`[ListenTogether] 加入房间失败，匿名用户被禁止: ${roomId}`);
    return { ok: false, error: "房间不存在" };
  }

  const member: ListenTogetherMember = {
    id: memberId,
    nickname,
    role: "guest",
    neteaseUserId,
    joinedAt: Date.now(),
    lastActiveAt: Date.now(),
    online: true,
  };

  room.members.push(member);
  tokenMap.set(token, { roomId, memberId });
  scheduleRoomExpiry(roomId);

  serverLog.info(
    `[ListenTogether] 成员加入房间成功: ${roomId}, ${nickname}, 当前成员数: ${room.members.length}`,
  );

  return { ok: true, token, room, cryptoKey: room.cryptoKey, memberId };
};

/** 离开房间 */
export const leaveRoom = (
  token: string,
): { roomId: string; memberId: string; wasHost: boolean } | null => {
  serverLog.info(`[ListenTogether] 成员尝试离开房间`);
  const info = tokenMap.get(token);
  if (!info) {
    serverLog.info("[ListenTogether] 离开房间失败，会话令牌无效");
    return null;
  }

  const { roomId, memberId } = info;
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 离开房间时房间已不存在，清理会话: ${roomId}`);
    tokenMap.delete(token);
    return null;
  }

  const wasHost = room.hostId === memberId;

  // 仅当是非房主时才从房间成员中移除（房主重连后断开不应被误判为离开）
  if (!wasHost) {
    room.members = room.members.filter((m) => m.id !== memberId);
    serverLog.info(
      `[ListenTogether] 成员从房间移除: ${roomId}, ${memberId}, 剩余成员数: ${room.members.length}`,
    );
  } else {
    const hasOtherHostWs = Array.from(wsTokenMap.values()).some((activeToken) => {
      if (activeToken === token) return false;
      const activeInfo = tokenMap.get(activeToken);
      return activeInfo?.roomId === roomId && activeInfo.memberId === memberId;
    });
    if (!hasOtherHostWs) {
      const hostMember = room.members.find((m) => m.id === memberId);
      if (hostMember) {
        hostMember.online = false;
        hostMember.disconnectedAt = Date.now();
        hostMember.lastActiveAt = hostMember.disconnectedAt;
      }
    }
    serverLog.info(`[ListenTogether] 房主WS会话断开，保留房主成员: ${roomId}`);
  }

  tokenMap.delete(token);

  // 清理离开成员的音源数据
  const roomAudioSources = memberAudioSources.get(roomId);
  if (roomAudioSources) {
    roomAudioSources.delete(memberId);
    if (roomAudioSources.size === 0) {
      memberAudioSources.delete(roomId);
    }
  }

  // 如果离开者是 controllerId，重置为 hostId
  if (room.controllerId === memberId && room.controllerId !== room.hostId) {
    room.controllerId = room.hostId;
    serverLog.info(
      `[ListenTogether] 主控成员离开，重置主控为房主: ${roomId}, controllerId=${room.hostId}`,
    );
  }

  if (wasHost) {
    scheduleRoomExpiry(roomId);
    serverLog.info(`[ListenTogether] 房主离开，保留房间: ${roomId}`);
    return { roomId, memberId, wasHost: true };
  }

  if (room.members.length === 0) {
    serverLog.info(`[ListenTogether] 房间成员为空，关闭房间: ${roomId}`);
    closeRoom(roomId);
    return { roomId, memberId, wasHost: false };
  }

  scheduleRoomExpiry(roomId);

  // 广播成员离开给房间内其他人
  const memberLeftMsg = {
    kind: "memberLeft",
    data: { memberId, memberCount: room.members.length },
  };
  broadcastToRoom(roomId, memberLeftMsg);

  serverLog.info(`[ListenTogether] 成员离开房间完成: ${roomId}, ${memberId}`);
  return { roomId, memberId, wasHost: false };
};

/** 踢出成员 */
export const kickMember = (roomId: string, hostId: string, memberId: string): boolean => {
  serverLog.info(
    `[ListenTogether] 尝试踢出成员: ${roomId}, 操作者: ${hostId}, 目标成员: ${memberId}`,
  );
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 踢出成员失败，房间不存在: ${roomId}`);
    return false;
  }
  if (room.hostId !== hostId) {
    serverLog.info(`[ListenTogether] 踢出成员失败，非房主操作: ${roomId}`);
    return false;
  }
  if (memberId === hostId) {
    serverLog.info(`[ListenTogether] 踢出成员失败，不能踢出房主自己: ${roomId}`);
    return false;
  }

  const member = room.members.find((m) => m.id === memberId);
  if (!member) {
    serverLog.info(`[ListenTogether] 踢出成员失败，成员不存在: ${roomId}, ${memberId}`);
    return false;
  }

  const removedTokens: string[] = [];
  for (const [token, info] of tokenMap.entries()) {
    if (info.roomId === roomId && info.memberId === memberId) {
      removedTokens.push(token);
    }
  }

  const kickedMsg = JSON.stringify({ kind: "kicked", data: { memberId, reason: "被房主踢出" } });
  for (const [ws, token] of wsTokenMap.entries()) {
    if (!removedTokens.includes(token)) continue;
    try {
      ws.send(kickedMsg);
    } catch {
      // 忽略发送失败的连接
    }
    closeWsQuietly(ws);
  }

  for (const token of removedTokens) {
    tokenMap.delete(token);
  }

  room.members = room.members.filter((m) => m.id !== memberId);

  if (room.controllerId === memberId && room.controllerId !== room.hostId) {
    room.controllerId = room.hostId;
    serverLog.info(
      `[ListenTogether] 被踢成员是主控，重置主控为房主: ${roomId}, controllerId=${room.hostId}`,
    );
  }

  const roomAudioSources = memberAudioSources.get(roomId);
  if (roomAudioSources) {
    roomAudioSources.delete(memberId);
    if (roomAudioSources.size === 0) {
      memberAudioSources.delete(roomId);
    }
  }

  const memberLeftMsg = {
    kind: "memberLeft",
    data: { memberId, memberCount: room.members.length },
  };
  broadcastToRoom(roomId, memberLeftMsg);

  serverLog.info(
    `[ListenTogether] 成员被踢出房间: ${roomId}, ${member.nickname}, 剩余成员数: ${room.members.length}`,
  );
  return true;
};

/** 拉黑成员 */
export const blacklistMember = (roomId: string, hostId: string, memberId: string): boolean => {
  serverLog.info(
    `[ListenTogether] 尝试拉黑成员: ${roomId}, 操作者: ${hostId}, 目标成员: ${memberId}`,
  );
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 拉黑成员失败，房间不存在: ${roomId}`);
    return false;
  }
  if (room.hostId !== hostId) {
    serverLog.info(`[ListenTogether] 拉黑成员失败，非房主操作: ${roomId}`);
    return false;
  }
  if (memberId === hostId) {
    serverLog.info(`[ListenTogether] 拉黑成员失败，不能拉黑房主自己: ${roomId}`);
    return false;
  }

  const member = room.members.find((m) => m.id === memberId);
  if (!member) {
    serverLog.info(`[ListenTogether] 拉黑成员失败，成员不存在: ${roomId}, ${memberId}`);
    return false;
  }

  if (member.neteaseUserId) {
    const neteaseIdStr = String(member.neteaseUserId);
    if (!room.blacklist.includes(neteaseIdStr)) {
      room.blacklist.push(neteaseIdStr);
      serverLog.info(
        `[ListenTogether] 成员 neteaseUserId 已加入黑名单: ${roomId}, ${member.neteaseUserId}`,
      );
    }
  }

  const removedTokens: string[] = [];
  for (const [token, info] of tokenMap.entries()) {
    if (info.roomId === roomId && info.memberId === memberId) {
      removedTokens.push(token);
    }
  }

  const blacklistedMsg = JSON.stringify({
    kind: "blacklisted",
    data: { memberId, reason: "被房主拉黑" },
  });
  for (const [ws, token] of wsTokenMap.entries()) {
    if (!removedTokens.includes(token)) continue;
    try {
      ws.send(blacklistedMsg);
    } catch {
      // 忽略发送失败的连接
    }
    closeWsQuietly(ws);
  }

  for (const token of removedTokens) {
    tokenMap.delete(token);
  }

  room.members = room.members.filter((m) => m.id !== memberId);

  if (room.controllerId === memberId && room.controllerId !== room.hostId) {
    room.controllerId = room.hostId;
    serverLog.info(
      `[ListenTogether] 被拉黑成员是主控，重置主控为房主: ${roomId}, controllerId=${room.hostId}`,
    );
  }

  const roomAudioSources = memberAudioSources.get(roomId);
  if (roomAudioSources) {
    roomAudioSources.delete(memberId);
    if (roomAudioSources.size === 0) {
      memberAudioSources.delete(roomId);
    }
  }

  const memberLeftMsg = {
    kind: "memberLeft",
    data: { memberId, memberCount: room.members.length },
  };
  broadcastToRoom(roomId, memberLeftMsg);

  serverLog.info(`[ListenTogether] 拉黑成员完成: ${roomId}, ${memberId}`);
  return true;
};

/** 检查成员是否在黑名单 */
export const isBlacklisted = (roomId: string, neteaseUserId: number | undefined): boolean => {
  const room = rooms.get(roomId);
  if (!room) return true;
  if (neteaseUserId === undefined) return false;
  return room.blacklist.includes(String(neteaseUserId));
};

/** 获取加密密钥 */
export const getCryptoKey = (roomId: string): string | undefined => {
  const room = rooms.get(roomId);
  return room?.cryptoKey;
};

/** 根据令牌获取成员信息 */
export const getMemberByToken = (
  token: string,
): { room: ListenTogetherRoom; member: ListenTogetherMember } | null => {
  const info = tokenMap.get(token);
  if (!info) return null;

  const room = rooms.get(info.roomId);
  if (!room) return null;

  const member = room.members.find((m) => m.id === info.memberId);
  if (!member) return null;

  return { room, member };
};

/** 更新成员最后活跃时间 */
export const updateMemberActive = (token: string): void => {
  const result = getMemberByToken(token);
  if (result) {
    result.member.lastActiveAt = Date.now();
    result.member.online = true;
    delete result.member.disconnectedAt;
  }
};

/** 获取按更新时间推进后的房间播放位置 */
const getCurrentRoomPosition = (room: ListenTogetherRoom): number => {
  if (room.state !== "playing") return room.position;
  return room.position + Math.max(Date.now() - room.positionUpdatedAt, 0);
};

/** 设置当前播放状态 */
export const setRoomPlayback = (
  roomId: string,
  track: Track | null,
  position: number,
  isPlaying: boolean,
  controllerId: string,
): void => {
  serverLog.info(
    `[ListenTogether] 设置房间播放状态: ${roomId}, 播放: ${isPlaying}, 位置: ${position}, 控制者: ${controllerId}`,
  );
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 设置播放状态失败，房间不存在: ${roomId}`);
    return;
  }

  room.currentTrack = track;
  room.position = position;
  room.positionUpdatedAt = Date.now();
  room.state = isPlaying ? "playing" : "paused";
  room.controllerId = controllerId;
  serverLog.info(
    `[ListenTogether] 房间播放状态已更新: ${roomId}, 状态: ${room.state}, 曲目: ${track?.title || "null"}`,
  );
};

/** 获取房间播放同步状态 */
export const getRoomSyncState = (roomId: string): ListenTogetherSyncState | null => {
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 获取同步状态失败，房间不存在: ${roomId}`);
    return null;
  }

  const position = getCurrentRoomPosition(room);
  const sendTimestamp = Date.now();
  serverLog.info(
    `[ListenTogether] 获取房间同步状态: ${roomId}, 状态: ${room.state}, 位置: ${position}`,
  );
  return {
    track: room.currentTrack,
    position,
    isPlaying: room.state === "playing",
    sendTimestamp,
    senderId: room.controllerId || room.hostId,
  };
};

/** 添加聊天消息 */
export const addChatMessage = (roomId: string, message: ListenTogetherChatMessage): number => {
  serverLog.info(
    `[ListenTogether] 添加聊天消息: ${roomId}, 发送者: ${message.senderId}, 内容长度: ${message.content?.length || 0}`,
  );
  const history = chatHistory.get(roomId);
  if (!history) {
    serverLog.info(`[ListenTogether] 添加聊天消息失败，房间聊天记录不存在: ${roomId}`);
    return -1;
  }

  const nextSeq = (messageSeqCounters.get(roomId) || 0) + 1;
  messageSeqCounters.set(roomId, nextSeq);
  message.seqId = nextSeq;

  history.push(message);
  if (history.length > MAX_CHAT_HISTORY) {
    history.shift();
  }
  serverLog.info(
    `[ListenTogether] 聊天消息已添加: ${roomId}, seqId=${nextSeq}, 当前历史消息数: ${history.length}`,
  );
  return nextSeq;
};
/** 获取聊天历史 */
export const getChatHistory = (roomId: string): ListenTogetherChatMessage[] => {
  serverLog.info(`[ListenTogether] 获取聊天历史: ${roomId}`);
  return chatHistory.get(roomId) ?? [];
};

/** 创建操作提案 */
export const createProposal = (
  roomId: string,
  type: ListenTogetherActionProposal["type"],
  proposerId: string,
  payload: unknown,
): ListenTogetherActionProposal => {
  serverLog.info(`[ListenTogether] 创建操作提案: ${roomId}, 类型: ${type}, 提议者: ${proposerId}`);
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 创建提案失败，房间不存在: ${roomId}`);
    throw new Error("房间不存在");
  }

  const proposal: ListenTogetherActionProposal = {
    id: randomUUID(),
    type,
    proposerId,
    payload,
    proposedAt: Date.now(),
    votes: {},
    voteDeadline: Date.now() + (store.get("listenTogether.voteTimeout") || 5000),
    executed: false,
  };

  activeProposals.set(proposal.id, proposal);
  proposalRoomMap.set(proposal.id, roomId);

  // 房主发起的提案直接通过，无需投票
  if (proposerId === room.hostId) {
    proposal.votes[proposerId] = true;
    proposal.executed = true;
    serverLog.info(
      `[ListenTogether] 房主提案直接通过: ${roomId}, 提案ID: ${proposal.id}, 类型: ${type}`,
    );
  } else {
    serverLog.info(
      `[ListenTogether] 提案创建成功，等待投票: ${roomId}, 提案ID: ${proposal.id}, 类型: ${type}, 截止: ${proposal.voteDeadline}`,
    );
  }

  return proposal;
};

/** 投票 */
export const voteOnProposal = (
  roomId: string,
  proposalId: string,
  memberId: string,
  agree: boolean,
): boolean => {
  serverLog.info(
    `[ListenTogether] 成员投票: 提案ID: ${proposalId}, 成员: ${memberId}, 同意: ${agree}`,
  );
  const proposal = activeProposals.get(proposalId);
  if (!proposal) {
    serverLog.info(`[ListenTogether] 投票失败，提案不存在: ${proposalId}`);
    return false;
  }
  if (proposal.executed) {
    serverLog.info(`[ListenTogether] 投票失败，提案已执行: ${proposalId}`);
    return false;
  }
  if (Date.now() > proposal.voteDeadline) {
    serverLog.info(`[ListenTogether] 投票失败，提案已过期: ${proposalId}`);
    return false;
  }

  const proposalRoomId = proposalRoomMap.get(proposalId);
  if (!proposalRoomId || proposalRoomId !== roomId) {
    serverLog.warn(
      `[ListenTogether] 投票失败，提案不属于当前房间: proposalId=${proposalId}, roomId=${roomId}`,
    );
    return false;
  }

  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 投票失败，提案所属房间不存在: ${proposalId}, ${roomId}`);
    return false;
  }
  if (!room.members.some((member) => member.id === memberId && member.online)) {
    serverLog.warn(
      `[ListenTogether] 投票失败，成员不属于当前房间: proposalId=${proposalId}, memberId=${memberId}`,
    );
    return false;
  }

  proposal.votes[memberId] = agree;

  const onlineMembers = room.members.filter((member) => member.online);
  const onlineMemberIds = new Set(onlineMembers.map((member) => member.id));
  const votedCount = Object.keys(proposal.votes).filter((voterId) =>
    onlineMemberIds.has(voterId),
  ).length;
  serverLog.info(
    `[ListenTogether] 投票统计: 提案ID: ${proposalId}, 已投票: ${votedCount}/${onlineMembers.length}`,
  );
  if (votedCount >= onlineMembers.length) {
    const agreeCount = Object.entries(proposal.votes).filter(
      ([voterId, vote]) => onlineMemberIds.has(voterId) && vote,
    ).length;
    const passed = agreeCount > onlineMembers.length / 2;
    if (passed) {
      proposal.executed = true;
      serverLog.info(
        `[ListenTogether] 提案投票通过: ${proposalId}, 同意: ${agreeCount}/${onlineMembers.length}`,
      );
    } else {
      serverLog.info(
        `[ListenTogether] 提案投票未通过: ${proposalId}, 同意: ${agreeCount}/${onlineMembers.length}`,
      );
    }
    return passed;
  }

  serverLog.info(`[ListenTogether] 投票已记录，等待更多投票: ${proposalId}`);
  return false;
};

/** 获取提案 */
export const getProposal = (proposalId: string): ListenTogetherActionProposal | undefined => {
  serverLog.info(`[ListenTogether] 获取提案: ${proposalId}`);
  return activeProposals.get(proposalId);
};

/** 清理已过期的提案 */
export const cleanupProposals = (): void => {
  const now = Date.now();
  let cleanedCount = 0;
  for (const [id, proposal] of activeProposals.entries()) {
    if (now > proposal.voteDeadline && !proposal.executed) {
      activeProposals.delete(id);
      proposalRoomMap.delete(id);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    serverLog.info(`[ListenTogether] 清理过期提案: ${cleanedCount} 个`);
  }
};

/** 启动房间同步定时器 */
export const startSyncTimer = (roomId: string, callback: () => void): void => {
  serverLog.info(`[ListenTogether] 启动房间同步定时器: ${roomId}`);
  const existing = syncTimers.get(roomId);
  if (existing) {
    clearInterval(existing);
    serverLog.info(`[ListenTogether] 房间已有同步定时器，先停止旧定时器: ${roomId}`);
  }

  const interval = store.get("listenTogether.syncInterval") || DEFAULT_SYNC_INTERVAL;
  const timer = setInterval(callback, interval);
  syncTimers.set(roomId, timer);
  serverLog.info(`[ListenTogether] 房间同步定时器已启动: ${roomId}, 间隔: ${interval}ms`);
};

/** 停止房间同步定时器 */
export const stopSyncTimer = (roomId: string): void => {
  serverLog.info(`[ListenTogether] 停止房间同步定时器: ${roomId}`);
  const timer = syncTimers.get(roomId);
  if (timer) {
    clearInterval(timer);
    syncTimers.delete(roomId);
    serverLog.info(`[ListenTogether] 房间同步定时器已停止: ${roomId}`);
  } else {
    serverLog.info(`[ListenTogether] 停止同步定时器失败，不存在: ${roomId}`);
  }
};

/** 获取上次广播快照 */
export const getLastBroadcastSnapshot = (roomId: string): string | undefined => {
  return lastBroadcastSnapshots.get(roomId);
};

/** 设置上次广播快照 */
export const setLastBroadcastSnapshot = (roomId: string, snapshot: string): void => {
  lastBroadcastSnapshots.set(roomId, snapshot);
};

/** 注册WS连接 */
export const registerWs = (ws: WSContext, token: string): void => {
  serverLog.info(`[ListenTogether] 注册WebSocket连接`);
  wsTokenMap.set(ws, token);
  serverLog.info(`[ListenTogether] WebSocket连接已注册，当前连接数: ${wsTokenMap.size}`);
};

/** 注销WS连接 */
export const unregisterWs = (ws: WSContext): void => {
  serverLog.info(`[ListenTogether] 注销WebSocket连接`);
  const token = wsTokenMap.get(ws);
  if (token) {
    serverLog.info(`[ListenTogether] 注销WS时触发成员离开`);
    leaveRoom(token);
  } else {
    serverLog.info(`[ListenTogether] 注销WS时未找到对应token`);
  }
  wsTokenMap.delete(ws);
  serverLog.info(`[ListenTogether] WebSocket连接已注销，当前连接数: ${wsTokenMap.size}`);
};

/** 根据WS获取令牌 */
export const getTokenByWs = (ws: WSContext): string | undefined => {
  return wsTokenMap.get(ws);
};

/** 广播消息给房间内所有成员 */
export const broadcastToRoom = (roomId: string, message: unknown, excludeWs?: WSContext): void => {
  serverLog.info(`[ListenTogether] 广播消息到房间: ${roomId}, 排除WS: ${excludeWs ? "是" : "否"}`);
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 广播失败，房间不存在: ${roomId}`);
    return;
  }

  const payload = JSON.stringify(message);
  let sentCount = 0;
  for (const [ws, token] of wsTokenMap.entries()) {
    if (excludeWs && ws === excludeWs) continue;
    const info = tokenMap.get(token);
    if (info && info.roomId === roomId) {
      try {
        ws.send(payload);
        sentCount++;
      } catch {
        // 忽略发送失败的连接
      }
    }
  }
  serverLog.info(
    `[ListenTogether] 广播完成: ${roomId}, 发送成功: ${sentCount}/${room.members.length}`,
  );
};

/** 发送消息给指定成员 */
export const sendToMember = (memberId: string, message: unknown): void => {
  serverLog.info(`[ListenTogether] 发送消息给指定成员: ${memberId}`);
  const payload = JSON.stringify(message);
  for (const [ws, token] of wsTokenMap.entries()) {
    const info = tokenMap.get(token);
    if (info && info.memberId === memberId) {
      try {
        ws.send(payload);
        serverLog.info(`[ListenTogether] 消息已发送给成员: ${memberId}`);
      } catch {
        // 忽略发送失败的连接
      }
      return;
    }
  }
  serverLog.info(`[ListenTogether] 发送消息失败，成员未连接: ${memberId}`);
};

/** 获取所有房间 */
export const getAllRooms = (): ListenTogetherRoom[] => {
  serverLog.info(`[ListenTogether] 获取所有房间，当前房间数: ${rooms.size}`);
  return Array.from(rooms.values());
};

/** 获取房间 */
export const getRoom = (roomId: string): ListenTogetherRoom | undefined => {
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 获取房间失败，房间不存在: ${roomId}`);
  }
  return room;
};

/** 验证鉴权密钥 */
export const verifyAuthKey = (key: string): boolean => {
  const configured = store.get("listenTogether.authKey");
  const configuredBuffer = Buffer.from(configured);
  const providedBuffer = Buffer.from(key);
  const valid =
    configuredBuffer.length === providedBuffer.length &&
    timingSafeEqual(configuredBuffer, providedBuffer);
  serverLog.info(`[ListenTogether] 验证鉴权密钥: ${valid ? "成功" : "失败"}`);
  return valid;
};

/** 检查一起听是否启用 */
export const isListenTogetherEnabled = (): boolean => {
  const enabled = store.get("listenTogether.enabled") === true;
  serverLog.info(`[ListenTogether] 检查一起听是否启用: ${enabled}`);
  return enabled;
};

/** 队列操作应用 */
export const applyQueueAction = (
  roomId: string,
  memberId: string,
  action: string,
  data: unknown,
): ListenTogetherQueueItem[] | null => {
  serverLog.info(
    `[ListenTogether] 应用队列操作: roomId=${roomId}, action=${action}, memberId=${memberId}`,
  );
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 队列操作失败，房间不存在: ${roomId}`);
    return null;
  }

  switch (action) {
    case "add": {
      const track = (data as { track?: unknown })?.track as Track | undefined;
      if (!track) {
        serverLog.info("[ListenTogether] 队列添加失败，缺少track");
        return null;
      }
      room.queue.push({ track, addedBy: memberId, addedAt: Date.now() });
      serverLog.info(
        `[ListenTogether] 队列添加成功: roomId=${roomId}, trackId=${track.id}, 队列长度=${room.queue.length}`,
      );
      return room.queue;
    }
    case "remove": {
      const index = (data as { index?: number })?.index ?? -1;
      if (index < 0 || index >= room.queue.length) {
        serverLog.info(
          `[ListenTogether] 队列移除失败，索引越界: index=${index}, length=${room.queue.length}`,
        );
        return null;
      }
      room.queue.splice(index, 1);
      serverLog.info(
        `[ListenTogether] 队列移除成功: roomId=${roomId}, index=${index}, 队列长度=${room.queue.length}`,
      );
      return room.queue;
    }
    case "clear": {
      room.queue = [];
      serverLog.info(`[ListenTogether] 队列清空成功: roomId=${roomId}`);
      return room.queue;
    }
    case "reorder":
    case "move": {
      const from = (data as { from?: number })?.from ?? -1;
      const to = (data as { to?: number })?.to ?? -1;
      if (from < 0 || from >= room.queue.length || to < 0 || to >= room.queue.length) {
        serverLog.info(
          `[ListenTogether] 队列重排序失败，索引越界: from=${from}, to=${to}, length=${room.queue.length}`,
        );
        return null;
      }
      const [item] = room.queue.splice(from, 1);
      room.queue.splice(to, 0, item);
      serverLog.info(`[ListenTogether] 队列重排序成功: roomId=${roomId}, from=${from}, to=${to}`);
      return room.queue;
    }
    case "set": {
      const newQueue = (data as { queue?: ListenTogetherQueueItem[] })?.queue;
      if (!Array.isArray(newQueue)) {
        serverLog.info("[ListenTogether] 队列设置失败，数据格式错误");
        return null;
      }
      room.queue = newQueue;
      serverLog.info(
        `[ListenTogether] 队列设置成功: roomId=${roomId}, length=${room.queue.length}`,
      );
      return room.queue;
    }
    default:
      serverLog.info(`[ListenTogether] 未知队列操作: ${action}`);
      return null;
  }
};

/** 品质等级排名 */
const qualityRank: Record<string, number> = {
  "hi-res": 5,
  lossless: 4,
  hq: 3,
  sq: 2,
  lq: 1,
};

/** 音源类型排名 */
const typeRank: Record<string, number> = {
  local: 3,
  online: 2,
  streaming: 1,
};

/** 更新成员音源 */
export const updateMemberAudioSource = (
  roomId: string,
  memberId: string,
  source: ListenTogetherAudioSource,
): void => {
  serverLog.info(`[ListenTogether] 更新成员音源: roomId=${roomId}, memberId=${memberId}`);
  let roomSources = memberAudioSources.get(roomId);
  if (!roomSources) {
    roomSources = new Map<string, ListenTogetherAudioSource>();
    memberAudioSources.set(roomId, roomSources);
  }
  roomSources.set(memberId, source);
  serverLog.info(
    `[ListenTogether] 成员音源已更新: roomId=${roomId}, memberId=${memberId}, quality=${source.quality}, type=${source.sourceType}`,
  );
};

/** 选举最优音源 */
export const electBestAudioSource = (roomId: string): ListenTogetherAudioSource | null => {
  serverLog.info(`[ListenTogether] 开始选举最优音源: roomId=${roomId}`);
  const roomSources = memberAudioSources.get(roomId);
  if (!roomSources || roomSources.size === 0) {
    serverLog.info(`[ListenTogether] 选举最优音源失败，无音源数据: roomId=${roomId}`);
    return null;
  }

  let best: ListenTogetherAudioSource | null = null;
  let bestScore = -1;

  for (const source of roomSources.values()) {
    const qRank = qualityRank[source.quality] || 0;
    const tRank = typeRank[source.sourceType] || 0;
    const score = qRank * 10 + tRank;

    serverLog.info(
      `[ListenTogether] 音源评分: memberId=${source.memberId}, quality=${source.quality}(${qRank}), type=${source.sourceType}(${tRank}), score=${score}`,
    );

    if (score > bestScore) {
      bestScore = score;
      best = source;
    }
  }

  if (best) {
    serverLog.info(
      `[ListenTogether] 最优音源选举完成: roomId=${roomId}, memberId=${best.memberId}, quality=${best.quality}, type=${best.sourceType}`,
    );
  }
  return best;
};

/** 获取房间内所有音源 */
export const getRoomAudioSources = (roomId: string): ListenTogetherAudioSource[] => {
  const roomSources = memberAudioSources.get(roomId);
  return roomSources ? Array.from(roomSources.values()) : [];
};

/** 撤回聊天消息 */
export const recallChatMessage = (
  roomId: string,
  messageId: string,
  memberId: string,
): { success: boolean; reason?: string } => {
  serverLog.info(
    `[ListenTogether] 尝试撤回消息: roomId=${roomId}, messageId=${messageId}, memberId=${memberId}`,
  );
  const room = rooms.get(roomId);
  if (!room) {
    serverLog.info(`[ListenTogether] 撤回消息失败，房间不存在: ${roomId}`);
    return { success: false, reason: "房间不存在" };
  }

  const history = chatHistory.get(roomId);
  if (!history) {
    serverLog.info(`[ListenTogether] 撤回消息失败，聊天记录不存在: ${roomId}`);
    return { success: false, reason: "聊天记录不存在" };
  }

  const message = history.find((m) => m.id === messageId);
  if (!message) {
    serverLog.info(`[ListenTogether] 撤回消息失败，消息不存在: ${messageId}`);
    return { success: false, reason: "消息不存在" };
  }

  // 只能撤回自己发的消息，且5分钟内
  if (message.senderId !== memberId) {
    serverLog.info(`[ListenTogether] 撤回消息失败，无权撤回他人消息: ${messageId}`);
    return { success: false, reason: "无权撤回他人消息" };
  }

  if (Date.now() - message.timestamp > 5 * 60 * 1000) {
    serverLog.info(`[ListenTogether] 撤回消息失败，超过5分钟: ${messageId}`);
    return { success: false, reason: "消息发送超过5分钟，无法撤回" };
  }

  if (message.isRecalled) {
    serverLog.info(`[ListenTogether] 撤回消息失败，消息已撤回: ${messageId}`);
    return { success: false, reason: "消息已被撤回" };
  }

  message.isRecalled = true;
  message.recalledAt = Date.now();
  message.recalledBy = memberId;

  serverLog.info(`[ListenTogether] 消息已撤回: ${messageId}`);
  return { success: true };
};
