/**
 * 一起听客户端服务
 * 负责WebSocket连接、消息处理、播放同步和聊天
 */

import type {
  ListenTogetherRoom,
  ListenTogetherMember,
  ListenTogetherChatMessage,
  ListenTogetherSyncState,
  ListenTogetherActionProposal,
  ListenTogetherServerMessage,
  ListenTogetherClientMessage,
} from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

export type ListenTogetherConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error";

/** WebSocket实例 */
let ws: WebSocket | null = null;
/** 当前连接状态 */
let connectionState: ListenTogetherConnectionState = "idle";
/** 当前房间信息 */
let currentRoom: ListenTogetherRoom | null = null;
/** 成员令牌 */
let memberToken: string | null = null;
/** 加密密钥（用于签名操作） */
let cryptoKey: string | null = null;
/** 当前服务器地址 */
let currentServerUrl = "";
/** 当前服务器端口 */
let currentPort = 14558;
/** 服务端与客户端的时间偏移（毫秒，serverTime - clientTime） */
let serverTimeOffset = 0;

/** 获取服务端与客户端的时间偏移 */
export const getServerTimeOffset = (): number => serverTimeOffset;

/** 事件监听器 */
const listeners = {
  stateChange: new Set<(state: ListenTogetherConnectionState) => void>(),
  roomUpdate: new Set<(room: ListenTogetherRoom | null) => void>(),
  sync: new Set<(state: ListenTogetherSyncState) => void>(),
  memberJoined: new Set<(member: ListenTogetherMember) => void>(),
  memberLeft: new Set<(memberId: string) => void>(),
  chat: new Set<(message: ListenTogetherChatMessage) => void>(),
  chatHistory: new Set<(messages: ListenTogetherChatMessage[]) => void>(),
  proposal: new Set<(proposal: ListenTogetherActionProposal) => void>(),
  voteUpdate: new Set<(data: { proposalId: string; memberId: string; agree: boolean; passed: boolean }) => void>(),
  executed: new Set<(data: { proposalId: string; result: boolean; payload?: unknown }) => void>(),
  error: new Set<(error: string) => void>(),
  kicked: new Set<(reason: string) => void>(),
  blacklisted: new Set<(reason: string) => void>(),
  onlineUrl: new Set<(data: { trackId: string; url: string }) => void>(),
};

/** 获取当前连接状态 */
export const getConnectionState = (): ListenTogetherConnectionState => connectionState;

/** 获取当前房间 */
export const getCurrentRoom = (): ListenTogetherRoom | null => currentRoom;

/** 获取成员令牌 */
export const getMemberToken = (): string | null => memberToken;

/** 当前成员ID */
let currentMemberId: string | null = null;

/** 获取当前服务器地址 */
export const getCurrentServerUrl = (): string => currentServerUrl;
/** 获取当前成员ID */
export const getMemberId = (): string | null => currentMemberId;

/** 获取当前服务器端口 */
export const getCurrentPort = (): number => currentPort;

/** 设置连接状态 */
const setState = (state: ListenTogetherConnectionState): void => {
  console.log(`[ListenTogether] 连接状态变化: ${connectionState} -> ${state}`);
  connectionState = state;
  listeners.stateChange.forEach((cb) => cb(state));
};

/**
 * 使用 cryptoKey 对消息内容进行简单签名
 * @param payload - 消息负载
 * @returns 签名字符串
 */
const signPayload = async (payload: unknown): Promise<string> => {
  if (!cryptoKey) return "";
  const text = JSON.stringify(payload) + cryptoKey;
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
};

/** 连接WebSocket */
export const connect = async (
  serverUrl: string,
  port: number,
  roomId: string,
  roomKey: string,
  nickname: string,
  neteaseUserId?: number,
): Promise<boolean> => {
  console.log(`[ListenTogether] 连接入口: serverUrl=${serverUrl}, port=${port}, roomId=${roomId}, nickname=${nickname}`);
  if (ws?.readyState === WebSocket.OPEN) {
    console.log("[ListenTogether] 已有活跃连接，先执行断开");
    disconnect();
  }
  // 清理所有旧监听器，避免多次连接导致同一消息被重复处理（如日志中的 3 条重复 sync）
  for (const key of Object.keys(listeners)) {
    (listeners[key as keyof typeof listeners] as Set<unknown>).clear();
  }
  console.log("[ListenTogether] 旧监听器已清理");

  setState("connecting");
  currentServerUrl = serverUrl;
  currentPort = port;

  return new Promise((resolve) => {
    const wsUrl = `ws://${serverUrl}:${port}/ws`;
    console.log(`[ListenTogether] 创建WebSocket: ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      console.log("[ListenTogether] 连接超时，关闭WebSocket");
      ws?.close();
      setState("error");
      listeners.error.forEach((cb) => cb("连接超时"));
      resolve(false);
    }, 10000);

    let resolved = false;
    const safeResolve = (value: boolean): void => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(value);
      }
    };

    ws.onopen = () => {
      console.log("[ListenTogether] WebSocket已打开，发送加入房间请求");
      // 发送加入房间请求（附带客户端时间戳，用于一次性时间同步）
      const joinMsg: ListenTogetherClientMessage = {
        op: "join",
        payload: { roomId, roomKey, nickname, neteaseUserId, clientTimestamp: Date.now() },
      };
      ws?.send(JSON.stringify(joinMsg));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ListenTogetherServerMessage;
        console.log(`[ListenTogether] 收到服务端消息: kind=${msg.kind}`);
        handleServerMessage(msg);
        if (msg.kind === "joined") {
          safeResolve(true);
        }
      } catch (err) {
        console.log("[ListenTogether] 消息解析失败", err);
        listeners.error.forEach((cb) => cb("消息解析失败"));
      }
    };

    ws.onerror = (err) => {
      console.log("[ListenTogether] WebSocket发生错误", err);
      setState("error");
      listeners.error.forEach((cb) => cb("WebSocket连接错误"));
      safeResolve(false);
    };

    ws.onclose = () => {
      console.log(`[ListenTogether] WebSocket已关闭，当前状态=${connectionState}`);
      if (connectionState !== "idle" && connectionState !== "error" && connectionState !== "connected") {
        setState("disconnected");
      }
      currentRoom = null;
      memberToken = null;
      cryptoKey = null;
      listeners.roomUpdate.forEach((cb) => cb(null));
      safeResolve(false);
    };
  });
};

/** 断开连接 */
export const disconnect = (): void => {
  console.log(`[ListenTogether] 断开连接入口，当前房间=${currentRoom?.id ?? "无"}`);
  if (ws?.readyState === WebSocket.OPEN) {
    console.log("[ListenTogether] 发送离开房间消息");
    const leaveMsg: ListenTogetherClientMessage = { op: "leave" };
    ws.send(JSON.stringify(leaveMsg));
  }
  ws?.close();
  ws = null;
  currentRoom = null;
  memberToken = null;
  cryptoKey = null;
  currentServerUrl = "";
  currentPort = 14558;
  serverTimeOffset = 0;
  // 断开时一并清理监听器，防止断开后残留回调导致消息重复处理
  for (const key of Object.keys(listeners)) {
    (listeners[key as keyof typeof listeners] as Set<unknown>).clear();
  }
  setState("idle");
  console.log("[ListenTogether] 断开连接完成，状态已重置为idle");
};

/** 处理服务端消息 */
const handleServerMessage = (msg: ListenTogetherServerMessage): void => {
  console.log(`[ListenTogether] 处理服务端消息: kind=${msg.kind}`);
  switch (msg.kind) {
    case "joined": {
      const data = msg.data as
        | {
            token: string;
            room: ListenTogetherRoom;
            cryptoKey?: string;
            chatHistory?: ListenTogetherChatMessage[];
            memberId?: string;
            serverTimestamp?: number;
            clientTimestamp?: number;
          }
        | undefined;
      if (data) {
        console.log(
          `[ListenTogether] 加入房间成功: roomId=${data.room.id}, memberCount=${data.room.members.length}, token=${data.token.slice(0, 8)}..., memberId=${data.memberId?.slice(0, 8) ?? "null"}...`,
        );
        memberToken = data.token;
        currentRoom = data.room;
        currentMemberId = data.memberId ?? null;
        if (data.cryptoKey) {
          console.log("[ListenTogether] 收到加密密钥");
          cryptoKey = data.cryptoKey;
        }
        // 一次性时间同步：根据加入握手时的时间戳估算服务端与客户端的时间偏移
        if (typeof data.serverTimestamp === "number" && typeof data.clientTimestamp === "number") {
          const receiveAt = Date.now();
          const rtt = receiveAt - data.clientTimestamp;
          const oneWayLatency = rtt / 2;
          serverTimeOffset = data.serverTimestamp - data.clientTimestamp - oneWayLatency;
          console.log(`[ListenTogether] 时间同步完成: offset=${serverTimeOffset.toFixed(1)}ms, rtt=${rtt}ms`);
        }
        if (data.chatHistory && data.chatHistory.length > 0) {
          console.log(`[ListenTogether] 收到聊天历史: ${data.chatHistory.length}条`);
          listeners.chatHistory.forEach((cb) => cb(data.chatHistory!));
        }
        setState("connected");
        listeners.roomUpdate.forEach((cb) => cb(data.room));
      } else {
        console.log("[ListenTogether] joined消息无数据");
      }
      break;
    }
    case "memberJoined": {
      const data = msg.data as { member: ListenTogetherMember; memberCount: number } | undefined;
      if (data?.member) {
        console.log(`[ListenTogether] 成员加入: memberId=${data.member.id}, nickname=${data.member.nickname}, memberCount=${data.memberCount}`);
        if (currentRoom && !currentRoom.members.find((m) => m.id === data.member.id)) {
          currentRoom.members.push(data.member);
        }
        listeners.memberJoined.forEach((cb) => cb(data.member));
        listeners.roomUpdate.forEach((cb) => cb(currentRoom));
      }
      break;
    }
    case "memberLeft": {
      const data = msg.data as { memberId: string; memberCount: number } | undefined;
      if (data?.memberId && currentRoom) {
        console.log(`[ListenTogether] 成员离开: memberId=${data.memberId}, memberCount=${data.memberCount}`);
        currentRoom.members = currentRoom.members.filter((m) => m.id !== data.memberId);
        listeners.memberLeft.forEach((cb) => cb(data.memberId));
        listeners.roomUpdate.forEach((cb) => cb(currentRoom));
      }
      break;
    }
    case "sync": {
      const syncState = msg.data as ListenTogetherSyncState | undefined;
      if (syncState) {
        console.log(`[ListenTogether] 收到播放同步: trackId=${syncState.track?.id ?? "null"}, position=${syncState.position}, isPlaying=${syncState.isPlaying}`);
        if (currentRoom) {
          currentRoom.currentTrack = syncState.track;
          currentRoom.position = syncState.position;
          currentRoom.state = syncState.isPlaying ? "playing" : "paused";
        }
        listeners.sync.forEach((cb) => cb(syncState));
      }
      break;
    }
    case "proposal": {
      const proposal = msg.data as ListenTogetherActionProposal | undefined;
      if (proposal) {
        console.log(`[ListenTogether] 收到提案: proposalId=${proposal.id}, type=${proposal.type}, proposer=${proposal.proposerId}`);
        listeners.proposal.forEach((cb) => cb(proposal));
      }
      break;
    }
    case "voteUpdate": {
      const data = msg.data as
        | { proposalId: string; memberId: string; agree: boolean; passed: boolean }
        | undefined;
      if (data) {
        console.log(`[ListenTogether] 投票更新: proposalId=${data.proposalId}, memberId=${data.memberId}, agree=${data.agree}, passed=${data.passed}`);
        listeners.voteUpdate.forEach((cb) => cb(data));
      }
      break;
    }
    case "executed": {
      const data = msg.data as
        | { proposalId: string; result: boolean; payload?: unknown }
        | undefined;
      if (data) {
        console.log(`[ListenTogether] 提案执行: proposalId=${data.proposalId}, result=${data.result}`);
        listeners.executed.forEach((cb) => cb(data));
      }
      break;
    }
    case "chat": {
      const message = msg.data as ListenTogetherChatMessage | undefined;
      if (message) {
        console.log(`[ListenTogether] 收到聊天消息: sender=${message.senderId}, content=${message.content.slice(0, 50)}`);
        listeners.chat.forEach((cb) => cb(message));
      }
      break;
    }
    case "error": {
      const data = msg.data as { error: string } | undefined;
      if (data?.error) {
        console.log(`[ListenTogether] 服务端错误: ${data.error}`);
        listeners.error.forEach((cb) => cb(data.error));
      }
      break;
    }
    case "roomClosed": {
      console.log("[ListenTogether] 房间已关闭，执行断开连接");
      disconnect();
      listeners.error.forEach((cb) => cb("房间已关闭"));
      break;
    }
    case "kicked": {
      const data = msg.data as { memberId: string; reason?: string } | undefined;
      console.log(`[ListenTogether] 被踢出房间: memberId=${data?.memberId}, reason=${data?.reason ?? "无"}`);
      disconnect();
      listeners.kicked.forEach((cb) => cb(data?.reason || "被房主踢出"));
      break;
    }
    case "blacklisted": {
      const data = msg.data as { memberId: string; reason?: string } | undefined;
      console.log(`[ListenTogether] 被拉黑: memberId=${data?.memberId}, reason=${data?.reason ?? "无"}`);
      disconnect();
      listeners.blacklisted.forEach((cb) => cb(data?.reason || "被房主拉黑"));
      break;
    }
    case "onlineUrl": {
      const data = msg.data as { trackId: string; url: string } | undefined;
      if (data) {
        console.log(`[ListenTogether] 收到在线URL: trackId=${data.trackId}, url长度=${data.url.length}`);
        listeners.onlineUrl.forEach((cb) => cb(data));
      }
      break;
    }
    case "event": {
      // 主进程广播的 player 事件，一起听渲染端不需要处理，静默忽略
      break;
    }
    default:
      console.log(`[ListenTogether] 未处理的消息类型: ${(msg as { kind?: string }).kind}`);
      break;
  }
};

/** 发送同步状态 */
export const sendSync = async (track: Track | null, position: number, isPlaying: boolean): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送同步失败: WebSocket未打开");
    return;
  }
  console.log(`[ListenTogether] 发送播放同步: trackId=${track?.id ?? "null"}, position=${position}, isPlaying=${isPlaying}`);
  const payload = { track, position, isPlaying };
  console.log("[ListenTogether] 发送同步payload结构:", JSON.stringify({ hasTrack: !!track, trackId: track?.id, position, isPlaying }));
  const msg: ListenTogetherClientMessage = {
    op: "sync",
    payload,
    signature: await signPayload(payload),
  };
  ws.send(JSON.stringify(msg));
  console.log("[ListenTogether] 播放同步已发送");
};

/** 发送操作提案 */
export const sendProposal = async (type: string, payload: unknown): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送提案失败: WebSocket未打开");
    return;
  }
  console.log(`[ListenTogether] 发送提案: type=${type}, payload=${JSON.stringify(payload).slice(0, 100)}`);
  const data = { type, data: payload };
  const msg: ListenTogetherClientMessage = {
    op: "propose",
    payload: data,
    signature: await signPayload(data),
  };
  ws.send(JSON.stringify(msg));
  console.log("[ListenTogether] 提案已发送");
};

/** 发送投票 */
export const sendVote = async (proposalId: string, agree: boolean): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送投票失败: WebSocket未打开");
    return;
  }
  console.log(`[ListenTogether] 发送投票: proposalId=${proposalId}, agree=${agree}`);
  const payload = { proposalId, agree };
  const msg: ListenTogetherClientMessage = {
    op: "vote",
    payload,
    signature: await signPayload(payload),
  };
  ws.send(JSON.stringify(msg));
  console.log("[ListenTogether] 投票已发送");
};

/** 发送聊天消息 */
export const sendChat = async (content: string): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送聊天失败: WebSocket未打开");
    return;
  }
  console.log(`[ListenTogether] 发送聊天消息: content=${content.slice(0, 50)}`);
  const payload = { content };
  const msg: ListenTogetherClientMessage = {
    op: "chat",
    payload,
    signature: await signPayload(payload),
  };
  ws.send(JSON.stringify(msg));
  console.log("[ListenTogether] 聊天消息已发送");
};

/** 发送心跳 */
export const sendHeartbeat = (): void => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送心跳失败: WebSocket未打开");
    return;
  }
  console.log("[ListenTogether] 发送心跳");
  const msg: ListenTogetherClientMessage = { op: "heartbeat" };
  ws.send(JSON.stringify(msg));
};

/** 发送踢出请求（仅房主） */
export const sendKick = async (memberId: string): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送踢出请求失败: WebSocket未打开");
    return;
  }
  console.log(`[ListenTogether] 发送踢出请求: memberId=${memberId}`);
  const payload = { memberId };
  const msg: ListenTogetherClientMessage = {
    op: "kick",
    payload,
    signature: await signPayload(payload),
  };
  ws.send(JSON.stringify(msg));
  console.log("[ListenTogether] 踢出请求已发送");
};

/** 发送拉黑请求（仅房主） */
export const sendBlacklist = async (memberId: string): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送拉黑请求失败: WebSocket未打开");
    return;
  }
  console.log(`[ListenTogether] 发送拉黑请求: memberId=${memberId}`);
  const payload = { memberId };
  const msg: ListenTogetherClientMessage = {
    op: "blacklist",
    payload,
    signature: await signPayload(payload),
  };
  ws.send(JSON.stringify(msg));
  console.log("[ListenTogether] 拉黑请求已发送");
};

/** 订阅连接状态变化 */
export const onStateChange = (callback: (state: ListenTogetherConnectionState) => void): (() => void) => {
  listeners.stateChange.add(callback);
  return () => listeners.stateChange.delete(callback);
};

/** 订阅房间更新 */
export const onRoomUpdate = (callback: (room: ListenTogetherRoom | null) => void): (() => void) => {
  listeners.roomUpdate.add(callback);
  return () => listeners.roomUpdate.delete(callback);
};

/** 订阅播放同步 */
export const onSync = (callback: (state: ListenTogetherSyncState) => void): (() => void) => {
  listeners.sync.add(callback);
  return () => listeners.sync.delete(callback);
};

/** 订阅成员加入 */
export const onMemberJoined = (callback: (member: ListenTogetherMember) => void): (() => void) => {
  listeners.memberJoined.add(callback);
  return () => listeners.memberJoined.delete(callback);
};

/** 订阅成员离开 */
export const onMemberLeft = (callback: (memberId: string) => void): (() => void) => {
  listeners.memberLeft.add(callback);
  return () => listeners.memberLeft.delete(callback);
};

/** 订阅聊天消息 */
export const onChat = (callback: (message: ListenTogetherChatMessage) => void): (() => void) => {
  listeners.chat.add(callback);
  return () => listeners.chat.delete(callback);
};

/** 订阅聊天历史（加入房间时下发） */
export const onChatHistory = (callback: (messages: ListenTogetherChatMessage[]) => void): (() => void) => {
  listeners.chatHistory.add(callback);
  return () => listeners.chatHistory.delete(callback);
};

/** 订阅提案 */
export const onProposal = (callback: (proposal: ListenTogetherActionProposal) => void): (() => void) => {
  listeners.proposal.add(callback);
  return () => listeners.proposal.delete(callback);
};

/** 订阅投票更新 */
export const onVoteUpdate = (callback: (data: { proposalId: string; memberId: string; agree: boolean; passed: boolean }) => void): (() => void) => {
  listeners.voteUpdate.add(callback);
  return () => listeners.voteUpdate.delete(callback);
};

/** 订阅执行结果 */
export const onExecuted = (callback: (data: { proposalId: string; result: boolean; payload?: unknown }) => void): (() => void) => {
  listeners.executed.add(callback);
  return () => listeners.executed.delete(callback);
};

/** 订阅错误 */
export const onError = (callback: (error: string) => void): (() => void) => {
  listeners.error.add(callback);
  return () => listeners.error.delete(callback);
};

/** 订阅被踢出事件 */
export const onKicked = (callback: (reason: string) => void): (() => void) => {
  listeners.kicked.add(callback);
  return () => listeners.kicked.delete(callback);
};

/** 订阅被拉黑事件 */
export const onBlacklisted = (callback: (reason: string) => void): (() => void) => {
  listeners.blacklisted.add(callback);
  return () => listeners.blacklisted.delete(callback);
};

/** 订阅在线音乐URL事件 */
export const onOnlineUrl = (callback: (data: { trackId: string; url: string }) => void): (() => void) => {
  listeners.onlineUrl.add(callback);
  return () => listeners.onlineUrl.delete(callback);
};

/** 启动心跳定时器 */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export const startHeartbeat = (): void => {
  console.log("[ListenTogether] 启动心跳定时器，间隔30秒");
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    sendHeartbeat();
  }, 30000);
};

export const stopHeartbeat = (): void => {
  if (heartbeatTimer) {
    console.log("[ListenTogether] 停止心跳定时器");
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  } else {
    console.log("[ListenTogether] 停止心跳定时器: 当前未运行");
  }
};
