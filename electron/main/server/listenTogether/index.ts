/**
 * 一起听 WebSocket 处理入口
 * 扩展原有WS协议，支持一起听相关消息
 */

import type { WSContext } from "hono/ws";
import type {
  ListenTogetherClientMessage,
  ListenTogetherRoom,
  ListenTogetherServerMessage,
} from "@shared/types/listenTogether";
import { store } from "@main/store";
import { serverLog } from "@main/utils/logger";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  isListenTogetherEnabled,
  verifyAuthKey,
  getMemberByToken,
  updateMemberActive,
  registerWs,
  unregisterWs,
  getTokenByWs,
  broadcastToRoom,
  startSyncTimer,
  kickMember,
  blacklistMember,
  addChatMessage,
  getChatHistory,
  setRoomPlayback,
  getRoomSyncState,
  createProposal,
  voteOnProposal,
  getProposal,
  leaveRoom,
  closeRoom,
  getLastBroadcastSnapshot,
  setLastBroadcastSnapshot,
  stopSyncTimer,
  wsTokenMap,
  applyQueueAction,
  updateMemberAudioSource,
  electBestAudioSource,
  getRoomAudioSources,
  recallChatMessage,
} from "./room";

/** 处理一起听WS消息 */
const isMessageRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const validateMessagePayload = (op: string, payload: unknown): boolean => {
  if (op === "leave" || op === "chunkAck") return payload === undefined;
  if (!isMessageRecord(payload)) return false;

  switch (op) {
    case "join":
      return (
        isNonEmptyString(payload.roomId) &&
        isNonEmptyString(payload.roomKey) &&
        isNonEmptyString(payload.authKey) &&
        isNonEmptyString(payload.nickname) &&
        (payload.neteaseUserId === undefined ||
          (typeof payload.neteaseUserId === "number" && Number.isFinite(payload.neteaseUserId))) &&
        (payload.clientTimestamp === undefined ||
          (typeof payload.clientTimestamp === "number" && Number.isFinite(payload.clientTimestamp)))
      );
    case "sync":
      return (
        (payload.track === undefined || payload.track === null || isMessageRecord(payload.track)) &&
        (payload.position === undefined ||
          (typeof payload.position === "number" && Number.isFinite(payload.position))) &&
        (payload.isPlaying === undefined || typeof payload.isPlaying === "boolean")
      );
    case "propose":
      return (
        typeof payload.type === "string" &&
        ["seek", "play", "pause", "skip", "prev", "volume", "loadTrack"].includes(
          payload.type,
        )
      );
    case "vote":
      return isNonEmptyString(payload.proposalId) && typeof payload.agree === "boolean";
    case "chat": {
      const replyTo = payload.replyTo;
      return (
        typeof payload.content === "string" &&
        (replyTo === undefined ||
          (isMessageRecord(replyTo) &&
            isNonEmptyString(replyTo.messageId) &&
            typeof replyTo.senderNickname === "string" &&
            typeof replyTo.content === "string")) &&
        (payload.mentions === undefined ||
          (Array.isArray(payload.mentions) && payload.mentions.every(isNonEmptyString)))
      );
    }
    case "heartbeat":
      return typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp);
    case "kick":
    case "blacklist":
      return isNonEmptyString(payload.memberId);
    case "recall":
      return isNonEmptyString(payload.messageId);
    case "queue": {
      if (typeof payload.action !== "string") return false;
      const data = payload.data;
      switch (payload.action) {
        case "add":
          return isMessageRecord(data) && isMessageRecord(data.track);
        case "remove":
          return isMessageRecord(data) && Number.isInteger(data.index);
        case "clear":
          return data === undefined;
        case "reorder":
        case "move":
          return isMessageRecord(data) && Number.isInteger(data.from) && Number.isInteger(data.to);
        case "set":
          return isMessageRecord(data) && Array.isArray(data.queue);
        default:
          return false;
      }
    }
    case "searchShare":
      return isNonEmptyString(payload.platform) && isNonEmptyString(payload.keyword);
    case "reaction":
      return isNonEmptyString(payload.emoji);
    case "audioSource":
      return (
        isNonEmptyString(payload.trackId) &&
        typeof payload.sourceType === "string" &&
        ["local", "online", "streaming"].includes(payload.sourceType) &&
        isNonEmptyString(payload.quality) &&
        (payload.platform === undefined || typeof payload.platform === "string") &&
        typeof payload.hasUrl === "boolean"
      );
    default:
      return false;
  }
};

const validateListenTogetherMessage = (
  value: unknown,
): value is ListenTogetherClientMessage => {
  if (!isMessageRecord(value) || typeof value.op !== "string") return false;
  if (value.signature !== undefined && typeof value.signature !== "string") return false;
  return validateMessagePayload(value.op, value.payload);
};

const verifyMessageSignature = (ws: WSContext, msg: ListenTogetherClientMessage): boolean => {
  const token = getTokenByWs(ws);
  if (!token) return false;
  const info = getMemberByToken(token);
  if (!info || !msg.signature || !/^[0-9a-f]{16}$/i.test(msg.signature)) return false;

  const expected = createHash("sha256")
    .update(JSON.stringify(msg.payload) + info.room.cryptoKey)
    .digest("hex")
    .slice(0, 16);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(msg.signature, "hex"));
};

export const handleListenTogetherMessage = async (
  ws: WSContext,
  msg: ListenTogetherClientMessage,
): Promise<void> => {
  if (!validateListenTogetherMessage(msg)) {
    serverLog.warn("[ListenTogether] 收到格式无效的消息");
    sendError(ws, "消息格式错误");
    return;
  }

  console.log(`[ListenTogether] 收到WS消息: op=${msg.op}`);
  serverLog.info(`[ListenTogether] 收到WS消息: op=${msg.op}`);

  if (!isListenTogetherEnabled()) {
    console.log("[ListenTogether] 一起听功能未启用，拒绝处理消息");
    serverLog.info("[ListenTogether] 一起听功能未启用，拒绝处理消息");
    sendError(ws, "一起听功能未启用");
    return;
  }

  if (msg.op !== "join" && msg.op !== "leave" && msg.op !== "chunkAck") {
    if (!verifyMessageSignature(ws, msg)) {
      serverLog.warn(`[ListenTogether] 消息签名无效: op=${msg.op}`);
      sendError(ws, "消息签名无效");
      return;
    }
  }

  switch (msg.op) {
    case "join":
      console.log("[ListenTogether] 分发到加入房间处理器");
      serverLog.info("[ListenTogether] 分发到加入房间处理器");
      await handleJoin(ws, msg);
      break;
    case "leave":
      console.log("[ListenTogether] 分发到离开房间处理器");
      serverLog.info("[ListenTogether] 分发到离开房间处理器");
      handleLeave(ws);
      break;
    case "sync":
      console.log("[ListenTogether] 分发到播放同步处理器");
      serverLog.info("[ListenTogether] 分发到播放同步处理器");
      handleSync(ws, msg);
      break;
    case "propose":
      console.log("[ListenTogether] 分发到操作提案处理器");
      serverLog.info("[ListenTogether] 分发到操作提案处理器");
      handlePropose(ws, msg);
      break;
    case "vote":
      console.log("[ListenTogether] 分发到投票处理器");
      serverLog.info("[ListenTogether] 分发到投票处理器");
      handleVote(ws, msg);
      break;
    case "chat":
      console.log("[ListenTogether] 分发到聊天消息处理器");
      serverLog.info("[ListenTogether] 分发到聊天消息处理器");
      handleChat(ws, msg);
      break;
    case "kick":
      console.log("[ListenTogether] 分发到踢出成员处理器");
      serverLog.info("[ListenTogether] 分发到踢出成员处理器");
      handleKick(ws, msg);
      break;
    case "blacklist":
      console.log("[ListenTogether] 分发到拉黑成员处理器");
      serverLog.info("[ListenTogether] 分发到拉黑成员处理器");
      handleBlacklist(ws, msg);
      break;
    case "queue":
      console.log("[ListenTogether] 分发到队列操作处理器");
      serverLog.info("[ListenTogether] 分发到队列操作处理器");
      handleQueue(ws, msg);
      break;
    case "searchShare":
      console.log("[ListenTogether] 分发到搜索共享处理器");
      serverLog.info("[ListenTogether] 分发到搜索共享处理器");
      handleSearchShare(ws, msg);
      break;
    case "reaction":
      console.log("[ListenTogether] 分发到表情反应处理器");
      serverLog.info("[ListenTogether] 分发到表情反应处理器");
      handleReaction(ws, msg);
      break;
    case "audioSource":
      console.log("[ListenTogether] 分发到音源品质处理器");
      serverLog.info("[ListenTogether] 分发到音源品质处理器");
      handleAudioSource(ws, msg);
      break;
    case "recall":
      console.log("[ListenTogether] 分发到撤回消息处理器");
      serverLog.info("[ListenTogether] 分发到撤回消息处理器");
      handleRecall(ws, msg);
      break;
    case "chunkAck":
      // 客户端分片确认，当前服务端无需处理，静默忽略
      break;
    case "heartbeat":
      handleHeartbeat(ws);
      break;
    default:
      console.log(`[ListenTogether] 收到未知操作类型: ${msg.op}`);
      serverLog.info(`[ListenTogether] 收到未知操作类型: ${msg.op}`);
      sendError(ws, `未知操作: ${msg.op}`);
  }
};

/** 处理加入房间 */
const handleJoin = async (ws: WSContext, msg: ListenTogetherClientMessage): Promise<void> => {
  const payload = msg.payload as {
    roomId: string;
    roomKey: string;
    authKey: string;
    nickname: string;
    neteaseUserId?: number;
    clientTimestamp?: number;
  } | null;

  console.log(
    `[ListenTogether] 处理加入房间请求: roomId=${payload?.roomId}, nickname=${payload?.nickname}`,
  );
  serverLog.info(
    `[ListenTogether] 处理加入房间请求: roomId=${payload?.roomId}, nickname=${payload?.nickname}`,
  );

  if (!payload?.roomId || !payload.roomKey || !payload.authKey || !payload.nickname) {
    serverLog.info("[ListenTogether] 加入房间失败: 缺少必要参数");
    sendError(ws, "缺少必要参数: roomId, roomKey, authKey, nickname");
    return;
  }

  if (!verifyAuthKey(payload.authKey)) {
    serverLog.warn(`[ListenTogether] 加入房间失败: 服务器鉴权失败, roomId=${payload.roomId}`);
    sendError(ws, "服务器鉴权失败");
    return;
  }

  // 动态导入避免循环依赖
  const { joinRoom } = await import("./room");
  const result = joinRoom(payload.roomId, payload.roomKey, payload.nickname, payload.neteaseUserId);

  if (!result.ok || !result.token || !result.room) {
    console.log(`[ListenTogether] 加入房间失败: ${result.error || "未知错误"}`);
    serverLog.info(`[ListenTogether] 加入房间失败: ${result.error || "未知错误"}`);
    sendError(ws, result.error || "加入房间失败");
    return;
  }

  serverLog.info(
    `[ListenTogether] 加入房间成功: roomId=${result.room.id}, 当前成员数=${result.room.members.length}`,
  );

  registerWs(ws, result.token);
  serverLog.info(`[ListenTogether] WebSocket注册完成: roomId=${result.room.id}`);

  // 发送加入成功响应（包含加密密钥、聊天历史、成员ID和时间同步戳）
  const joinedMsg: ListenTogetherServerMessage = {
    kind: "joined",
    data: {
      token: result.token,
      room: result.room,
      chatHistory: getChatHistory(result.room.id),
      cryptoKey: result.cryptoKey,
      memberId: result.memberId,
      serverTimestamp: Date.now(),
      clientTimestamp: payload.clientTimestamp,
    },
  };
  ws.send(JSON.stringify(joinedMsg));
  serverLog.info(`[ListenTogether] 已发送加入成功响应: roomId=${result.room.id}`);

  const memberInfo = getMemberByToken(result.token);
  const isHostRejoin = memberInfo?.member.id === result.room.hostId;
  if (isHostRejoin) {
    broadcastRoomUpdate(result.room, ws);
  }

  // 广播新成员加入（房主rejoin时不广播，避免重复通知）
  if (!isHostRejoin) {
    const memberJoinedMsg: ListenTogetherServerMessage = {
      kind: "memberJoined",
      data: {
        member: memberInfo?.member ?? result.room.members[result.room.members.length - 1],
        memberCount: result.room.members.length,
      },
    };
    broadcastToRoom(result.room.id, memberJoinedMsg, ws);
    console.log(
      `[ListenTogether] 广播新成员加入: roomId=${result.room.id}, 成员数=${result.room.members.length}`,
    );
    serverLog.info(
      `[ListenTogether] 广播新成员加入: roomId=${result.room.id}, 成员数=${result.room.members.length}`,
    );
  } else {
    console.log(`[ListenTogether] 房主重新加入，跳过广播: roomId=${result.room.id}`);
    serverLog.info(`[ListenTogether] 房主重新加入，跳过广播: roomId=${result.room.id}`);
  }

  // 如果是房主，启动同步定时器（带变化检测，避免无脑广播）
  if (memberInfo && memberInfo.member.role === "host") {
    console.log(`[ListenTogether] 房主加入，启动播放同步定时器: roomId=${result.room.id}`);
    serverLog.info(`[ListenTogether] 房主加入，启动播放同步定时器: roomId=${result.room.id}`);
    startSyncTimer(result.room.id, () => {
      const syncState = getRoomSyncState(result.room!.id);
      if (!syncState) return;

      // 与上次广播的快照比较，只有状态真正变化才广播
      const snapshotKey = `${syncState.track?.id ?? "null"}|${syncState.isPlaying}|${Math.floor(syncState.position / 5000)}`;
      const lastKey = getLastBroadcastSnapshot(result.room!.id);
      if (snapshotKey === lastKey) return;

      setLastBroadcastSnapshot(result.room!.id, snapshotKey);
      const syncMsg: ListenTogetherServerMessage = {
        kind: "sync",
        data: syncState,
      };
      broadcastToRoom(result.room!.id, syncMsg);
      console.log(`[ListenTogether] 定时广播播放同步状态: roomId=${result.room!.id}`);
      serverLog.info(`[ListenTogether] 定时广播播放同步状态: roomId=${result.room!.id}`);
    });
  } else if (memberInfo) {
    // 非房主加入时，由房主下发当前播放状态
    const syncState = getRoomSyncState(result.room.id);
    if (syncState) {
      const syncMsg: ListenTogetherServerMessage = {
        kind: "sync",
        data: syncState,
      };
      ws.send(JSON.stringify(syncMsg));
      console.log(
        `[ListenTogether] 向新成员发送当前播放状态: roomId=${result.room.id}, memberId=${memberInfo.member.id}`,
      );
      serverLog.info(
        `[ListenTogether] 向新成员发送当前播放状态: roomId=${result.room.id}, memberId=${memberInfo.member.id}`,
      );
    }
  }
};

/** 处理离开房间 */
const handleLeave = (ws: WSContext): void => {
  console.log("[ListenTogether] 处理离开房间请求");
  serverLog.info("[ListenTogether] 处理离开房间请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 离开房间失败: 未找到对应token");
    serverLog.info("[ListenTogether] 离开房间失败: 未找到对应token");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 成员信息不存在，直接注销WS: `);
    serverLog.info(`[ListenTogether] 成员信息不存在，直接注销WS: `);
    unregisterWs(ws);
    return;
  }

  const { room, member } = info;
  console.log(
    `[ListenTogether] 成员准备离开: roomId=${room.id}, memberId=${member.id}, nickname=${member.nickname}, role=${member.role}`,
  );
  serverLog.info(
    `[ListenTogether] 成员准备离开: roomId=${room.id}, memberId=${member.id}, nickname=${member.nickname}, role=${member.role}`,
  );

  // 先注销WS，避免广播时包含自己
  const wasHost = room.hostId === member.id;
  wsTokenMap.delete(ws);
  leaveRoom(token);
  console.log(
    `[ListenTogether] 成员已离开房间: , wasHost=${wasHost}, 剩余成员数=${room.members.length}`,
  );
  serverLog.info(
    `[ListenTogether] 成员已离开房间: , wasHost=${wasHost}, 剩余成员数=${room.members.length}`,
  );

  if (wasHost) {
    closeRoom(room.id);
    console.log(`[ListenTogether] 房主主动离开，关闭房间: roomId=${room.id}`);
    serverLog.info(`[ListenTogether] 房主主动离开，关闭房间: roomId=${room.id}`);
  }
};

/** 处理播放同步 */
const handleSync = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理播放同步请求");
  serverLog.info("[ListenTogether] 处理播放同步请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 播放同步失败: 未加入房间");
    serverLog.info("[ListenTogether] 播放同步失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 播放同步失败: 成员信息不存在`);
    serverLog.info(`[ListenTogether] 播放同步失败: 成员信息不存在`);
    sendError(ws, "成员信息不存在");
    return;
  }

  updateMemberActive(token);

  const { room, member } = info;
  const payload = msg.payload as {
    track?: Record<string, unknown> | null;
    position?: number;
    isPlaying?: boolean;
  } | null;

  console.log(
    `[ListenTogether] 收到sync payload: hasTrack=${!!payload?.track}, trackId=${(payload?.track as { id?: string })?.id ?? "null"}, position=${payload?.position ?? "null"}, isPlaying=${payload?.isPlaying ?? "null"}`,
  );
  serverLog.info(
    `[ListenTogether] 收到sync payload: hasTrack=${!!payload?.track}, trackId=${(payload?.track as { id?: string })?.id ?? "null"}`,
  );

  // 只有主控成员（房主或切歌方）可以更新播放状态
  if (room.controllerId !== member.id && member.role !== "host") {
    console.log(
      `[ListenTogether] 播放同步被拒绝: 无权更新播放状态, memberId=${member.id}, role=${member.role}, controllerId=${room.controllerId}`,
    );
    serverLog.info(
      `[ListenTogether] 播放同步被拒绝: 无权更新播放状态, memberId=${member.id}, role=${member.role}, controllerId=${room.controllerId}`,
    );
    sendError(ws, "无权更新播放状态");
    return;
  }

  // 防御性检查：如果 payload 不存在或不是对象，拒绝处理
  if (!payload || typeof payload !== "object") {
    console.log("[ListenTogether] 播放同步失败: payload 结构无效");
    serverLog.info("[ListenTogether] 播放同步失败: payload 结构无效");
    sendError(ws, "同步数据格式错误");
    return;
  }

  const track = Object.hasOwn(payload, "track")
    ? (payload.track as unknown as Parameters<typeof setRoomPlayback>[1])
    : room.currentTrack;

  console.log(
    `[ListenTogether] 更新房间播放状态: roomId=${room.id}, position=${payload.position ?? room.position}, isPlaying=${payload.isPlaying ?? room.state === "playing"}, controllerId=${member.id}, trackId=${(track as { id?: string })?.id ?? "null"}`,
  );
  serverLog.info(
    `[ListenTogether] 更新房间播放状态: roomId=${room.id}, trackId=${(track as { id?: string })?.id ?? "null"}`,
  );

  // 更新房间播放状态
  setRoomPlayback(
    room.id,
    track,
    payload.position ?? room.position,
    payload.isPlaying ?? room.state === "playing",
    member.id,
  );

  // 广播同步状态给房间内所有人（排除发送者，避免主控收到自己发回的消息）
  const syncState = getRoomSyncState(room.id);
  if (syncState) {
    const syncMsg: ListenTogetherServerMessage = {
      kind: "sync",
      data: syncState,
    };
    broadcastToRoom(room.id, syncMsg, ws);
    console.log(
      `[ListenTogether] 广播播放同步状态到房间: roomId=${room.id}, trackId=${syncState.track?.id ?? "null"}`,
    );
    serverLog.info(
      `[ListenTogether] 广播播放同步状态到房间: roomId=${room.id}, trackId=${syncState.track?.id ?? "null"}`,
    );
  }
};

/** 处理操作提案 */
const handlePropose = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理操作提案请求");
  serverLog.info("[ListenTogether] 处理操作提案请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 提案失败: 未加入房间");
    serverLog.info("[ListenTogether] 提案失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 提案失败: 成员信息不存在`);
    serverLog.info(`[ListenTogether] 提案失败: 成员信息不存在`);
    sendError(ws, "成员信息不存在");
    return;
  }

  updateMemberActive(token);

  const { room, member } = info;
  const payload = msg.payload as {
    type: string;
    data: unknown;
  } | null;

  if (!payload?.type) {
    console.log("[ListenTogether] 提案失败: 缺少操作类型");
    serverLog.info("[ListenTogether] 提案失败: 缺少操作类型");
    sendError(ws, "缺少操作类型");
    return;
  }

  const validTypes = ["seek", "play", "pause", "skip", "prev", "volume", "loadTrack"] as const;
  if (!validTypes.includes(payload.type as (typeof validTypes)[number])) {
    console.log(`[ListenTogether] 提案失败: 不支持的操作类型: ${payload.type}`);
    serverLog.info(`[ListenTogether] 提案失败: 不支持的操作类型: ${payload.type}`);
    sendError(ws, `不支持的操作类型: ${payload.type}`);
    return;
  }

  try {
    console.log(
      `[ListenTogether] 创建提案: roomId=${room.id}, type=${payload.type}, proposerId=${member.id}`,
    );
    serverLog.info(
      `[ListenTogether] 创建提案: roomId=${room.id}, type=${payload.type}, proposerId=${member.id}`,
    );

    const proposal = createProposal(
      room.id,
      payload.type as (typeof validTypes)[number],
      member.id,
      payload.data,
    );

    console.log(
      `[ListenTogether] 提案创建成功: proposalId=${proposal.id}, type=${proposal.type}, executed=${proposal.executed}`,
    );
    serverLog.info(
      `[ListenTogether] 提案创建成功: proposalId=${proposal.id}, type=${proposal.type}, executed=${proposal.executed}`,
    );

    // 广播提案给所有成员
    const proposalMsg: ListenTogetherServerMessage = {
      kind: "proposal",
      data: proposal,
    };
    broadcastToRoom(room.id, proposalMsg);
    console.log(`[ListenTogether] 广播提案到房间: roomId=${room.id}, proposalId=${proposal.id}`);
    serverLog.info(`[ListenTogether] 广播提案到房间: roomId=${room.id}, proposalId=${proposal.id}`);

    // 房主提案直接通过（已在 createProposal 中标记 executed）
    if (proposal.executed) {
      console.log(`[ListenTogether] 房主提案直接通过: proposalId=${proposal.id}`);
      serverLog.info(`[ListenTogether] 房主提案直接通过: proposalId=${proposal.id}`);

      const executedMsg: ListenTogetherServerMessage = {
        kind: "executed",
        data: {
          proposalId: proposal.id,
          result: true,
          payload: { type: proposal.type, data: proposal.payload },
        },
      };
      broadcastToRoom(room.id, executedMsg);
      console.log(`[ListenTogether] 广播提案执行结果: proposalId=${proposal.id}, result=true`);
      serverLog.info(`[ListenTogether] 广播提案执行结果: proposalId=${proposal.id}, result=true`);

      // 切歌操作：更新主控为提议者
      if (proposal.type === "skip" || proposal.type === "prev" || proposal.type === "loadTrack") {
        room.controllerId = proposal.proposerId;
        console.log(`[ListenTogether] 切歌操作更新主控: controllerId=${proposal.proposerId}`);
        serverLog.info(`[ListenTogether] 切歌操作更新主控: controllerId=${proposal.proposerId}`);
      }
    }

    // 如果只有一个成员（房主），自动通过
    if (room.members.length === 1 && !proposal.executed) {
      proposal.votes[member.id] = true;
      proposal.executed = true;
      console.log(`[ListenTogether] 单成员房间自动通过提案: proposalId=${proposal.id}`);
      serverLog.info(`[ListenTogether] 单成员房间自动通过提案: proposalId=${proposal.id}`);

      const executedMsg: ListenTogetherServerMessage = {
        kind: "executed",
        data: {
          proposalId: proposal.id,
          result: true,
          payload: { type: proposal.type, data: proposal.payload },
        },
      };
      broadcastToRoom(room.id, executedMsg);
      console.log(
        `[ListenTogether] 广播单成员提案执行结果: proposalId=${proposal.id}, result=true`,
      );
      serverLog.info(
        `[ListenTogether] 广播单成员提案执行结果: proposalId=${proposal.id}, result=true`,
      );
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ListenTogether] 提案处理异常: ${errorMsg}`);
    serverLog.info(`[ListenTogether] 提案处理异常: ${errorMsg}`);
    sendError(ws, errorMsg);
  }
};

/** 处理投票 */
const handleVote = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理投票请求");
  serverLog.info("[ListenTogether] 处理投票请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 投票失败: 未加入房间");
    serverLog.info("[ListenTogether] 投票失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 投票失败: 成员信息不存在`);
    serverLog.info(`[ListenTogether] 投票失败: 成员信息不存在`);
    sendError(ws, "成员信息不存在");
    return;
  }

  updateMemberActive(token);

  const payload = msg.payload as { proposalId: string; agree: boolean } | null;
  if (!payload?.proposalId) {
    console.log("[ListenTogether] 投票失败: 缺少提案ID");
    serverLog.info("[ListenTogether] 投票失败: 缺少提案ID");
    sendError(ws, "缺少提案ID");
    return;
  }

  console.log(
    `[ListenTogether] 成员投票: proposalId=${payload.proposalId}, memberId=${info.member.id}, agree=${payload.agree}`,
  );
  serverLog.info(
    `[ListenTogether] 成员投票: proposalId=${payload.proposalId}, memberId=${info.member.id}, agree=${payload.agree}`,
  );

  const passed = voteOnProposal(
    info.room.id,
    payload.proposalId,
    info.member.id,
    payload.agree,
  );
  console.log(`[ListenTogether] 投票处理完成: proposalId=${payload.proposalId}, passed=${passed}`);
  serverLog.info(
    `[ListenTogether] 投票处理完成: proposalId=${payload.proposalId}, passed=${passed}`,
  );

  // 广播投票更新
  const voteUpdateMsg: ListenTogetherServerMessage = {
    kind: "voteUpdate",
    data: {
      proposalId: payload.proposalId,
      memberId: info.member.id,
      agree: payload.agree,
      passed,
    },
  };
  broadcastToRoom(info.room.id, voteUpdateMsg);
  console.log(
    `[ListenTogether] 广播投票更新: roomId=${info.room.id}, proposalId=${payload.proposalId}, passed=${passed}`,
  );
  serverLog.info(
    `[ListenTogether] 广播投票更新: roomId=${info.room.id}, proposalId=${payload.proposalId}, passed=${passed}`,
  );

  // 如果投票通过，广播执行结果
  if (passed) {
    const proposal = getProposal(payload.proposalId);
    if (proposal) {
      console.log(
        `[ListenTogether] 投票通过，广播执行结果: proposalId=${proposal.id}, type=${proposal.type}`,
      );
      serverLog.info(
        `[ListenTogether] 投票通过，广播执行结果: proposalId=${proposal.id}, type=${proposal.type}`,
      );

      const executedMsg: ListenTogetherServerMessage = {
        kind: "executed",
        data: {
          proposalId: proposal.id,
          result: true,
          payload: { type: proposal.type, data: proposal.payload },
        },
      };
      broadcastToRoom(info.room.id, executedMsg);
      console.log(
        `[ListenTogether] 广播执行结果到房间: roomId=${info.room.id}, proposalId=${proposal.id}`,
      );
      serverLog.info(
        `[ListenTogether] 广播执行结果到房间: roomId=${info.room.id}, proposalId=${proposal.id}`,
      );

      // 切歌操作：更新主控为提议者
      if (proposal.type === "skip" || proposal.type === "prev" || proposal.type === "loadTrack") {
        info.room.controllerId = proposal.proposerId;
        console.log(`[ListenTogether] 切歌投票通过更新主控: controllerId=${proposal.proposerId}`);
        serverLog.info(
          `[ListenTogether] 切歌投票通过更新主控: controllerId=${proposal.proposerId}`,
        );
      }
    }
  }
};

/** 处理聊天消息 */
const handleChat = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理聊天消息请求");
  serverLog.info("[ListenTogether] 处理聊天消息请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 聊天消息失败: 未加入房间");
    serverLog.info("[ListenTogether] 聊天消息失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 聊天消息失败: 成员信息不存在`);
    serverLog.info(`[ListenTogether] 聊天消息失败: 成员信息不存在`);
    sendError(ws, "成员信息不存在");
    return;
  }

  updateMemberActive(token);

  const { room, member } = info;
  const payload = msg.payload as {
    content: string;
    replyTo?: { messageId: string; senderNickname: string; content: string };
    mentions?: string[];
  } | null;

  if (
    member.neteaseUserId === undefined &&
    !store.get("listenTogether.allowAnonymousChat")
  ) {
    serverLog.warn(
      `[ListenTogether] 匿名成员聊天被拒绝: roomId=${room.id}, memberId=${member.id}`,
    );
    sendError(ws, "当前房间不允许匿名成员聊天");
    return;
  }

  if (!payload?.content || payload.content.trim().length === 0) {
    console.log("[ListenTogether] 聊天消息失败: 消息内容为空");
    serverLog.info("[ListenTogether] 聊天消息失败: 消息内容为空");
    sendError(ws, "消息内容不能为空");
    return;
  }

  // 限制消息长度（与客户端保持一致：1万字）
  const content = payload.content.trim().slice(0, 10000);
  console.log(
    `[ListenTogether] 发送聊天消息: roomId=${room.id}, sender=${member.nickname}, contentLength=${content.length}`,
  );
  serverLog.info(
    `[ListenTogether] 发送聊天消息: roomId=${room.id}, sender=${member.nickname}, contentLength=${content.length}`,
  );

  const message = {
    id: randomUUID(),
    senderId: member.id,
    senderNickname: member.nickname,
    neteaseUserId: member.neteaseUserId,
    content,
    timestamp: Date.now(),
    replyTo: payload.replyTo ?? undefined,
    mentions: payload.mentions ?? undefined,
  };

  const seqId = addChatMessage(room.id, message);
  console.log(`[ListenTogether] 聊天消息已保存: messageId=${message.id}, seqId=${seqId}`);
  serverLog.info(`[ListenTogether] 聊天消息已保存: messageId=${message.id}, seqId=${seqId}`);

  // 给发送者返回确认（包含 msgId 和 seqId）
  const ackMsg: ListenTogetherServerMessage = {
    kind: "chatAck",
    data: { msgId: message.id, seqId },
  };
  try {
    ws.send(JSON.stringify(ackMsg));
    console.log(`[ListenTogether] 已发送 chatAck 给发送者: msgId=${message.id}, seqId=${seqId}`);
    serverLog.info(`[ListenTogether] 已发送 chatAck 给发送者: msgId=${message.id}, seqId=${seqId}`);
  } catch {
    // 忽略发送失败
  }

  // 广播消息
  const chatMsg: ListenTogetherServerMessage = {
    kind: "chat",
    data: message,
  };
  broadcastToRoom(room.id, chatMsg);
  console.log(
    `[ListenTogether] 广播聊天消息到房间: roomId=${room.id}, messageId=${message.id}, seqId=${seqId}`,
  );
  serverLog.info(
    `[ListenTogether] 广播聊天消息到房间: roomId=${room.id}, messageId=${message.id}, seqId=${seqId}`,
  );
};

/** 处理踢出成员 */
const handleKick = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理踢出成员请求");
  serverLog.info("[ListenTogether] 处理踢出成员请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 踢出成员失败: 未加入房间");
    serverLog.info("[ListenTogether] 踢出成员失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 踢出成员失败: 成员信息不存在`);
    serverLog.info(`[ListenTogether] 踢出成员失败: 成员信息不存在`);
    sendError(ws, "成员信息不存在");
    return;
  }

  const { room, member } = info;
  if (member.role !== "host") {
    console.log(
      `[ListenTogether] 踢出成员失败: 只有房主可以踢人, memberId=${member.id}, role=${member.role}`,
    );
    serverLog.info(
      `[ListenTogether] 踢出成员失败: 只有房主可以踢人, memberId=${member.id}, role=${member.role}`,
    );
    sendError(ws, "只有房主可以踢出成员");
    return;
  }

  const payload = msg.payload as { memberId: string } | null;
  if (!payload?.memberId) {
    console.log("[ListenTogether] 踢出成员失败: 缺少成员ID");
    serverLog.info("[ListenTogether] 踢出成员失败: 缺少成员ID");
    sendError(ws, "缺少成员ID");
    return;
  }

  console.log(
    `[ListenTogether] 房主踢出成员: roomId=${room.id}, targetMemberId=${payload.memberId}`,
  );
  serverLog.info(
    `[ListenTogether] 房主踢出成员: roomId=${room.id}, targetMemberId=${payload.memberId}`,
  );

  if (kickMember(room.id, member.id, payload.memberId)) {
    console.log(`[ListenTogether] 踢出成员成功: roomId=${room.id}, memberId=${payload.memberId}`);
    serverLog.info(
      `[ListenTogether] 踢出成员成功: roomId=${room.id}, memberId=${payload.memberId}`,
    );
  } else {
    console.log(`[ListenTogether] 踢出成员失败: roomId=${room.id}, memberId=${payload.memberId}`);
    serverLog.info(
      `[ListenTogether] 踢出成员失败: roomId=${room.id}, memberId=${payload.memberId}`,
    );
    sendError(ws, "踢出成员失败");
  }
};

/** 处理拉黑成员 */
const handleBlacklist = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理拉黑成员请求");
  serverLog.info("[ListenTogether] 处理拉黑成员请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 拉黑成员失败: 未加入房间");
    serverLog.info("[ListenTogether] 拉黑成员失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 拉黑成员失败: 成员信息不存在`);
    serverLog.info(`[ListenTogether] 拉黑成员失败: 成员信息不存在`);
    sendError(ws, "成员信息不存在");
    return;
  }

  const { room, member } = info;
  if (member.role !== "host") {
    console.log(
      `[ListenTogether] 拉黑成员失败: 只有房主可以拉黑, memberId=${member.id}, role=${member.role}`,
    );
    serverLog.info(
      `[ListenTogether] 拉黑成员失败: 只有房主可以拉黑, memberId=${member.id}, role=${member.role}`,
    );
    sendError(ws, "只有房主可以拉黑成员");
    return;
  }

  const payload = msg.payload as { memberId: string } | null;
  if (!payload?.memberId) {
    console.log("[ListenTogether] 拉黑成员失败: 缺少成员ID");
    serverLog.info("[ListenTogether] 拉黑成员失败: 缺少成员ID");
    sendError(ws, "缺少成员ID");
    return;
  }

  console.log(
    `[ListenTogether] 房主拉黑成员: roomId=${room.id}, targetMemberId=${payload.memberId}`,
  );
  serverLog.info(
    `[ListenTogether] 房主拉黑成员: roomId=${room.id}, targetMemberId=${payload.memberId}`,
  );

  if (blacklistMember(room.id, member.id, payload.memberId)) {
    console.log(`[ListenTogether] 拉黑成员成功: roomId=${room.id}, memberId=${payload.memberId}`);
    serverLog.info(
      `[ListenTogether] 拉黑成员成功: roomId=${room.id}, memberId=${payload.memberId}`,
    );
  } else {
    console.log(`[ListenTogether] 拉黑成员失败: roomId=${room.id}, memberId=${payload.memberId}`);
    serverLog.info(
      `[ListenTogether] 拉黑成员失败: roomId=${room.id}, memberId=${payload.memberId}`,
    );
    sendError(ws, "拉黑成员失败");
  }
};

/** 处理撤回消息 */
const handleRecall = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理撤回消息请求");
  serverLog.info("[ListenTogether] 处理撤回消息请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 撤回消息失败: 未加入房间");
    serverLog.info("[ListenTogether] 撤回消息失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 撤回消息失败: 成员信息不存在`);
    serverLog.info("[ListenTogether] 撤回消息失败: 成员信息不存在");
    sendError(ws, "成员信息不存在");
    return;
  }

  updateMemberActive(token);

  const { room, member } = info;
  const payload = msg.payload as { messageId?: string } | null;

  if (!payload?.messageId) {
    console.log("[ListenTogether] 撤回消息失败: 缺少消息ID");
    serverLog.info("[ListenTogether] 撤回消息失败: 缺少消息ID");
    sendError(ws, "缺少消息ID");
    return;
  }

  console.log(
    `[ListenTogether] 撤回消息: roomId=${room.id}, messageId=${payload.messageId}, memberId=${member.id}`,
  );
  serverLog.info(`[ListenTogether] 撤回消息: roomId=${room.id}, messageId=${payload.messageId}`);

  const result = recallChatMessage(room.id, payload.messageId, member.id);
  if (result.success) {
    // 广播消息撤回
    const recalledMsg: ListenTogetherServerMessage = {
      kind: "messageRecalled",
      data: { messageId: payload.messageId, recalledBy: member.id },
    };
    broadcastToRoom(room.id, recalledMsg);
    console.log(
      `[ListenTogether] 撤回消息成功并已广播: roomId=${room.id}, messageId=${payload.messageId}`,
    );
    serverLog.info(
      `[ListenTogether] 撤回消息成功并已广播: roomId=${room.id}, messageId=${payload.messageId}`,
    );
  } else {
    console.log(
      `[ListenTogether] 撤回消息失败: roomId=${room.id}, messageId=${payload.messageId}, reason=${result.reason}`,
    );
    serverLog.info(
      `[ListenTogether] 撤回消息失败: roomId=${room.id}, messageId=${payload.messageId}, reason=${result.reason}`,
    );
    sendError(ws, result.reason || "撤回消息失败");
  }
};

/** 处理心跳 */
const handleHeartbeat = (ws: WSContext): void => {
  const token = getTokenByWs(ws);
  if (token) {
    updateMemberActive(token);
  }
};

/** 发送错误 */
const sendError = (ws: WSContext, error: string): void => {
  console.log(`[ListenTogether] 发送错误: ${error}`);
  serverLog.info(`[ListenTogether] 发送错误: ${error}`);

  const msg: ListenTogetherServerMessage = {
    kind: "error",
    data: { error },
  };
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 错误消息已发送");
    serverLog.info("[ListenTogether] 错误消息已发送");
  } catch {
    console.log("[ListenTogether] 发送错误消息失败");
    serverLog.info("[ListenTogether] 发送错误消息失败");
  }
};

const broadcastRoomUpdate = (room: ListenTogetherRoom, excludeWs?: WSContext): void => {
  const msg: ListenTogetherServerMessage = {
    kind: "roomUpdate",
    data: room,
  };
  broadcastToRoom(room.id, msg, excludeWs);
};

/** 一起听 WS 连接关闭处理 */
export const handleListenTogetherClose = (ws: WSContext): void => {
  console.log("[ListenTogether] WebSocket连接关闭");
  serverLog.info("[ListenTogether] WebSocket连接关闭");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] WS关闭处理: 未找到对应token，无需处理");
    serverLog.info("[ListenTogether] WS关闭处理: 未找到对应token，无需处理");
    return;
  }

  const info = getMemberByToken(token);
  if (info) {
    const { room, member } = info;
    const wasHost = room.hostId === member.id;

    console.log(
      `[ListenTogether] WS关闭处理成员离开: roomId=${room.id}, memberId=${member.id}, nickname=${member.nickname}, wasHost=${wasHost}`,
    );
    serverLog.info(
      `[ListenTogether] WS关闭处理成员离开: roomId=${room.id}, memberId=${member.id}, nickname=${member.nickname}, wasHost=${wasHost}`,
    );

    // 先注销WS
    wsTokenMap.delete(ws);
    const leaveResult = leaveRoom(token);
    console.log(
      `[ListenTogether] WS关闭后成员已离开，剩余成员数=${room.members.length}`,
    );
    serverLog.info(
      `[ListenTogether] WS关闭后成员已离开，剩余成员数=${room.members.length}`,
    );

    // 房主离开，停止同步定时器（房间保留但房主不再同步播放状态）
    if (leaveResult?.wasHost) {
      stopSyncTimer(room.id);
      broadcastRoomUpdate(room);
      console.log(`[ListenTogether] 房主WS断开，等待房主重连: roomId=${room.id}`);
      serverLog.info(`[ListenTogether] 房主WS断开，等待房主重连: roomId=${room.id}`);
    }
  } else {
    console.log(`[ListenTogether] WS关闭处理: 成员信息不存在，直接注销WS: `);
    serverLog.info(`[ListenTogether] WS关闭处理: 成员信息不存在，直接注销WS: `);
    unregisterWs(ws);
  }
};

/** 处理队列操作 */
const handleQueue = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理队列操作请求");
  serverLog.info("[ListenTogether] 处理队列操作请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 队列操作失败: 未加入房间");
    serverLog.info("[ListenTogether] 队列操作失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 队列操作失败: 成员信息不存在`);
    serverLog.info("[ListenTogether] 队列操作失败: 成员信息不存在");
    sendError(ws, "成员信息不存在");
    return;
  }

  updateMemberActive(token);

  const { room, member } = info;
  const payload = msg.payload as { action?: string; data?: unknown } | null;

  if (!payload?.action) {
    console.log("[ListenTogether] 队列操作失败: 缺少操作类型");
    serverLog.info("[ListenTogether] 队列操作失败: 缺少操作类型");
    sendError(ws, "缺少操作类型");
    return;
  }

  if (payload.action !== "add" && member.id !== room.hostId) {
    serverLog.warn(
      `[ListenTogether] 队列操作被拒绝: roomId=${room.id}, memberId=${member.id}, action=${payload.action}`,
    );
    sendError(ws, "仅房主可以执行此队列操作");
    return;
  }

  try {
    const result = applyQueueAction(room.id, member.id, payload.action, payload.data);
    if (result === null) {
      sendError(ws, "队列操作失败");
      return;
    }

    console.log(`[ListenTogether] 队列操作成功: roomId=${room.id}, action=${payload.action}`);
    serverLog.info(`[ListenTogether] 队列操作成功: roomId=${room.id}, action=${payload.action}`);

    // 广播队列更新
    const queueMsg: ListenTogetherServerMessage = {
      kind: "queueUpdate",
      data: result,
    };
    broadcastToRoom(room.id, queueMsg);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[ListenTogether] 队列操作异常: ${errorMsg}`);
    serverLog.info(`[ListenTogether] 队列操作异常: ${errorMsg}`);
    sendError(ws, errorMsg);
  }
};

/** 处理搜索共享 */
const handleSearchShare = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理搜索共享请求");
  serverLog.info("[ListenTogether] 处理搜索共享请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 搜索共享失败: 未加入房间");
    serverLog.info("[ListenTogether] 搜索共享失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 搜索共享失败: 成员信息不存在`);
    serverLog.info("[ListenTogether] 搜索共享失败: 成员信息不存在");
    sendError(ws, "成员信息不存在");
    return;
  }

  updateMemberActive(token);

  const { room, member } = info;
  const payload = msg.payload as { platform?: string; keyword?: string; results?: unknown } | null;

  if (!payload?.platform || !payload?.keyword) {
    console.log("[ListenTogether] 搜索共享失败: 缺少平台或关键词");
    serverLog.info("[ListenTogether] 搜索共享失败: 缺少平台或关键词");
    sendError(ws, "缺少平台或关键词");
    return;
  }

  const share = {
    id: randomUUID(),
    platform: payload.platform,
    keyword: payload.keyword,
    results: payload.results,
    sharedBy: member.id,
    sharedByNickname: member.nickname,
    sharedAt: Date.now(),
  };

  console.log(
    `[ListenTogether] 搜索共享: roomId=${room.id}, platform=${payload.platform}, keyword=${payload.keyword}`,
  );
  serverLog.info(`[ListenTogether] 搜索共享: roomId=${room.id}, platform=${payload.platform}`);

  // 广播搜索共享
  const shareMsg: ListenTogetherServerMessage = {
    kind: "searchShared",
    data: share,
  };
  broadcastToRoom(room.id, shareMsg);
};

/** 处理表情反应 */
const handleReaction = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理表情反应请求");
  serverLog.info("[ListenTogether] 处理表情反应请求");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 表情反应失败: 未加入房间");
    serverLog.info("[ListenTogether] 表情反应失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 表情反应失败: 成员信息不存在`);
    serverLog.info("[ListenTogether] 表情反应失败: 成员信息不存在");
    sendError(ws, "成员信息不存在");
    return;
  }

  updateMemberActive(token);

  const { room, member } = info;
  const payload = msg.payload as { emoji?: string } | null;

  if (!payload?.emoji) {
    console.log("[ListenTogether] 表情反应失败: 缺少表情");
    serverLog.info("[ListenTogether] 表情反应失败: 缺少表情");
    sendError(ws, "缺少表情");
    return;
  }

  const reaction = {
    emoji: payload.emoji,
    senderId: member.id,
    senderNickname: member.nickname,
    timestamp: Date.now(),
  };

  console.log(
    `[ListenTogether] 表情反应: roomId=${room.id}, emoji=${payload.emoji}, sender=${member.nickname}`,
  );
  serverLog.info(`[ListenTogether] 表情反应: roomId=${room.id}, emoji=${payload.emoji}`);

  // 广播表情反应
  const reactionMsg: ListenTogetherServerMessage = {
    kind: "reaction",
    data: reaction,
  };
  broadcastToRoom(room.id, reactionMsg);
};

/** 处理音源品质报告 */
const handleAudioSource = (ws: WSContext, msg: ListenTogetherClientMessage): void => {
  console.log("[ListenTogether] 处理音源品质报告");
  serverLog.info("[ListenTogether] 处理音源品质报告");

  const token = getTokenByWs(ws);
  if (!token) {
    console.log("[ListenTogether] 音源报告失败: 未加入房间");
    serverLog.info("[ListenTogether] 音源报告失败: 未加入房间");
    sendError(ws, "未加入房间");
    return;
  }

  const info = getMemberByToken(token);
  if (!info) {
    console.log(`[ListenTogether] 音源报告失败: 成员信息不存在`);
    serverLog.info("[ListenTogether] 音源报告失败: 成员信息不存在");
    sendError(ws, "成员信息不存在");
    return;
  }

  updateMemberActive(token);

  const { room, member } = info;
  const payload = msg.payload as {
    trackId?: string;
    sourceType?: string;
    quality?: string;
    platform?: string;
    hasUrl?: boolean;
  } | null;

  if (!payload?.trackId || !payload.sourceType || !payload.quality) {
    console.log("[ListenTogether] 音源报告失败: 缺少必要字段");
    serverLog.info("[ListenTogether] 音源报告失败: 缺少必要字段");
    sendError(ws, "音源信息不完整");
    return;
  }

  const source = {
    memberId: member.id,
    memberNickname: member.nickname,
    trackId: payload.trackId,
    sourceType: payload.sourceType as "local" | "online" | "streaming",
    platform: payload.platform,
    quality: payload.quality,
    hasUrl: payload.hasUrl ?? false,
    reportedAt: Date.now(),
  };

  console.log(
    `[ListenTogether] 成员报告音源: roomId=${room.id}, memberId=${member.id}, trackId=${source.trackId}, quality=${source.quality}, type=${source.sourceType}`,
  );
  serverLog.info(
    `[ListenTogether] 成员报告音源: roomId=${room.id}, memberId=${member.id}, quality=${source.quality}, type=${source.sourceType}`,
  );

  // 更新成员音源
  updateMemberAudioSource(room.id, member.id, source);

  // 选举最优音源
  const best = electBestAudioSource(room.id);

  // 广播所有成员音源更新
  const allSources = getRoomAudioSources(room.id);
  const audioSourceUpdateMsg: ListenTogetherServerMessage = {
    kind: "audioSourceUpdate",
    data: allSources,
  };
  broadcastToRoom(room.id, audioSourceUpdateMsg);
  console.log(`[ListenTogether] 广播音源更新: roomId=${room.id}, 共${allSources.length}个音源`);
  serverLog.info(`[ListenTogether] 广播音源更新: roomId=${room.id}, 共${allSources.length}个音源`);

  // 广播最优音源
  if (best) {
    const bestAudioSourceMsg: ListenTogetherServerMessage = {
      kind: "bestAudioSource",
      data: best,
    };
    broadcastToRoom(room.id, bestAudioSourceMsg);
    console.log(
      `[ListenTogether] 广播最优音源: roomId=${room.id}, memberId=${best.memberId}, quality=${best.quality}`,
    );
    serverLog.info(
      `[ListenTogether] 广播最优音源: roomId=${room.id}, memberId=${best.memberId}, quality=${best.quality}`,
    );
  }
};
