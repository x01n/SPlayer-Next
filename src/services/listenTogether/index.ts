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
  ListenTogetherQueueItem,
  ListenTogetherSearchShare,
  ListenTogetherReaction,
  ListenTogetherAudioSource,
} from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

export type ListenTogetherConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

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
  voteUpdate: new Set<
    (data: { proposalId: string; memberId: string; agree: boolean; passed: boolean }) => void
  >(),
  executed: new Set<(data: { proposalId: string; result: boolean; payload?: unknown }) => void>(),
  error: new Set<(error: string) => void>(),
  kicked: new Set<(reason: string) => void>(),
  blacklisted: new Set<(reason: string) => void>(),
  onlineUrl: new Set<(data: { trackId: string; url: string }) => void>(),
  queueUpdate: new Set<(queue: ListenTogetherQueueItem[]) => void>(),
  searchShared: new Set<(share: ListenTogetherSearchShare) => void>(),
  reaction: new Set<(reaction: ListenTogetherReaction) => void>(),
  bestAudioSource: new Set<(source: ListenTogetherAudioSource) => void>(),
  audioSourceUpdate: new Set<(sources: ListenTogetherAudioSource[]) => void>(),
  messageRecalled: new Set<(data: { messageId: string; recalledBy: string }) => void>(),
  chatAck: new Set<(data: { msgId: string; seqId: number }) => void>(),
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

/** 安全遍历监听器，单个回调异常不影响其他回调 */
const safeForEach = <T>(set: Set<(value: T) => void>, value: T): void => {
  set.forEach((cb) => {
    try {
      cb(value);
    } catch (err) {
      console.error("[ListenTogether] 监听器回调异常:", err);
    }
  });
};

/** 设置连接状态 */
const setState = (state: ListenTogetherConnectionState): void => {
  console.log(`[ListenTogether] 连接状态变化: ${connectionState} -> ${state}`);
  connectionState = state;
  safeForEach(listeners.stateChange, state);
};

// ====== 连接管理 ======

/** 连接参数缓存，用于重连 */
let connectionParams: {
  serverUrl: string;
  port: number;
  roomId: string;
  roomKey: string;
  nickname: string;
  neteaseUserId?: number;
} | null = null;

/** 是否手动断开（手动断开时不自动重连） */
let isManualDisconnect = false;

/** 当前连接操作的 Promise（防止并发连接） */
let connectionPromise: Promise<boolean> | null = null;

/** 当前连接操作的 resolve 函数 */
let resolveConnection: ((value: boolean) => void) | null = null;

/** 当前连接是否已被取消 */
let connectionCancelled = false;

/** 重连定时器 */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** 重连次数 */
let reconnectAttempts = 0;

/** 最大重连次数 */
const MAX_RECONNECT_ATTEMPTS = 10;

/** 基础重连延迟（毫秒） */
const BASE_RECONNECT_DELAY = 1000;

/** 最大重连延迟（毫秒） */
const MAX_RECONNECT_DELAY = 30000;

/** 心跳超时检测定时器 */
let heartbeatTimeoutTimer: ReturnType<typeof setInterval> | null = null;

/** 上次收到消息的时间戳 */
let lastMessageTime = 0;

/**
 * 推断 WebSocket 协议
 * 支持 serverUrl 中显式指定 ws:// / wss:// / http:// / https://
 * 未指定时按端口推断：443/8443 优先 wss，其他优先 ws
 * @returns 清理后的地址和协议优先级列表
 */
function inferProtocols(
  serverUrl: string,
  port: number,
): { cleanUrl: string; protocols: string[] } {
  let clean = serverUrl.trim().replace(/\/+$/, "");

  // 已显式指定 ws:// 或 wss://
  const wsMatch = clean.match(/^wss?:\/\/(.+)$/);
  if (wsMatch) {
    clean = wsMatch[1].replace(/\/.*$/, "").replace(/:\d+$/, "");
    return { cleanUrl: clean, protocols: [serverUrl.startsWith("wss") ? "wss" : "ws"] };
  }

  // 已显式指定 http:// 或 https://（映射到 ws/wss）
  const httpMatch = clean.match(/^https?:\/\/(.+)$/);
  if (httpMatch) {
    clean = httpMatch[1].replace(/\/.*$/, "").replace(/:\d+$/, "");
    return { cleanUrl: clean, protocols: [serverUrl.startsWith("https") ? "wss" : "ws"] };
  }

  // 处理 splayer-listentogether:// 或其他自定义协议前缀
  const customProtocolMatch = clean.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/i);
  if (customProtocolMatch) {
    clean = customProtocolMatch[1].replace(/\/.*$/, "").replace(/:\d+$/, "");
    // 自定义协议前缀不指定 ws/wss，由端口推断
    const isSecure = port === 443 || port === 8443;
    return { cleanUrl: clean, protocols: isSecure ? ["wss", "ws"] : ["ws", "wss"] };
  }

  // 未指定协议，移除可能的路径和端口
  clean = clean.replace(/\/.*$/, "").replace(/:\d+$/, "");

  // 未指定协议，按端口推断
  const isSecure = port === 443 || port === 8443;
  return { cleanUrl: clean, protocols: isSecure ? ["wss", "ws"] : ["ws", "wss"] };
}

/**
 * 计算重连延迟（指数退避 + 抖动）
 */
function getReconnectDelay(): number {
  const delay = Math.min(
    BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY,
  );
  return delay + Math.random() * 1000;
}

/** 清除重连定时器 */
function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/** 安排重连 */
function scheduleReconnect(): void {
  if (isManualDisconnect || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log("[ListenTogether] 重连次数已达上限，停止重试");
      safeForEach(listeners.error, "重连次数已达上限，停止重试");
    }
    return;
  }

  clearReconnect();

  const delay = getReconnectDelay();
  console.log(`[ListenTogether] ${delay.toFixed(0)}ms 后尝试第 ${reconnectAttempts + 1} 次重连`);

  reconnectTimer = setTimeout(() => {
    reconnectAttempts++;
    if (connectionParams) {
      const { serverUrl, port, roomId, roomKey, nickname, neteaseUserId } = connectionParams;
      void connect(serverUrl, port, roomId, roomKey, nickname, neteaseUserId);
    }
  }, delay);
}

/** 启动心跳超时检测 */
function startHeartbeatTimeout(): void {
  stopHeartbeatTimeout();
  lastMessageTime = Date.now();

  heartbeatTimeoutTimer = setInterval(() => {
    if (connectionState !== "connected") return;

    const elapsed = Date.now() - lastMessageTime;
    if (elapsed > 60000) {
      // 60s 内未收到任何消息，认为连接假死
      console.log(`[ListenTogether] 心跳超时，${elapsed}ms 未收到消息，强制关闭连接`);
      ws?.close();
    }
  }, 15000); // 每 15s 检查一次
}

/** 停止心跳超时检测 */
function stopHeartbeatTimeout(): void {
  if (heartbeatTimeoutTimer) {
    clearInterval(heartbeatTimeoutTimer);
    heartbeatTimeoutTimer = null;
  }
}

/** 连接断开处理（仅用于意外断开） */
function handleDisconnect(): void {
  console.log(`[ListenTogether] 连接意外断开`);
  stopHeartbeatTimeout();
  stopHeartbeat();

  ws = null;
  memberToken = null;
  cryptoKey = null;
  currentMemberId = null;
  currentServerUrl = "";
  currentPort = 14558;
  serverTimeOffset = 0;
  if (isManualDisconnect) {
    currentRoom = null;
    setState("idle");
    return;
  }

  safeForEach(listeners.error, "连接已断开");
  setState("disconnected");
  scheduleReconnect();
}

/** 连接已建立后的错误处理 */
function handleError(err: Event): void {
  console.log("[ListenTogether] 连接发生错误", err);
  // 错误通常会触发 onclose，由 handleDisconnect 处理
}

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
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
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
  if (connectionPromise) {
    console.log("[ListenTogether] 已有连接操作正在进行，强制取消旧连接");
    connectionCancelled = true;
    if (ws) {
      const oldWs = ws;
      ws = null;
      oldWs.onopen = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      oldWs.onclose = null;
      oldWs.close();
    }
    if (resolveConnection) {
      resolveConnection(false);
      resolveConnection = null;
    }
    connectionPromise = null;
  }

  console.log(
    `[ListenTogether] 连接入口: serverUrl=${serverUrl}, port=${port}, roomId=${roomId}, nickname=${nickname}`,
  );

  if (ws !== null) {
    console.log("[ListenTogether] 已有连接实例，先执行断开");
    disconnect(true);
  }

  connectionCancelled = false;
  connectionParams = { serverUrl, port, roomId, roomKey, nickname, neteaseUserId };
  isManualDisconnect = false;
  clearReconnect();
  currentRoom = null;

  setState("connecting");

  connectionPromise = establishConnection(
    serverUrl,
    port,
    roomId,
    roomKey,
    nickname,
    neteaseUserId,
  );
  const success = await connectionPromise;
  connectionPromise = null;
  resolveConnection = null;
  connectionCancelled = false;

  if (success) {
    console.log("[ListenTogether] 连接成功，重置重连计数");
    reconnectAttempts = 0;
  } else if (!isManualDisconnect) {
    setState("error");
    safeForEach(listeners.error, "连接失败");
    scheduleReconnect();
  }

  return success;
};

/** 断开连接 */
export const disconnect = (preserveListeners = false): void => {
  console.log(`[ListenTogether] 手动断开连接，当前房间=${currentRoom?.id ?? "无"}`);

  isManualDisconnect = true;
  connectionCancelled = true;
  clearReconnect();
  stopHeartbeatTimeout();
  stopHeartbeat(); // 停止心跳发送定时器，避免泄漏

  // 通知正在进行的连接操作立即结束，避免 Promise 永远挂起
  if (resolveConnection) {
    resolveConnection(false);
    resolveConnection = null;
  }

  // 移除所有处理器，避免触发重连逻辑
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onopen = null;
  }

  if (ws?.readyState === WebSocket.OPEN) {
    console.log("[ListenTogether] 发送离开房间消息");
    const leaveMsg: ListenTogetherClientMessage = { op: "leave" };
    try {
      ws.send(JSON.stringify(leaveMsg));
    } catch {
      // 忽略发送失败
    }
  }
  ws?.close();
  ws = null;

  currentRoom = null;
  memberToken = null;
  cryptoKey = null;
  currentServerUrl = "";
  currentPort = 14558;
  serverTimeOffset = 0;
  currentMemberId = null; // 重置当前成员ID

  // 先通知状态变化，再清空监听器，避免 UI 收不到断开通知
  setState("idle");
  connectionParams = null;

  // 仅在真正手动断开时重置重连计数，connect() 清理旧连接时保留指数退避
  if (!preserveListeners) {
    reconnectAttempts = 0;
  }

  // 断开时一并清理监听器（除非调用方要求保留）
  if (!preserveListeners) {
    for (const key of Object.keys(listeners)) {
      (listeners[key as keyof typeof listeners] as Set<unknown>).clear();
    }
  }

  console.log("[ListenTogether] 断开连接完成，状态已重置为 idle");
};

/**
 * 建立 WebSocket 连接（内部函数，尝试多种协议）
 */
function establishConnection(
  serverUrl: string,
  port: number,
  roomId: string,
  roomKey: string,
  nickname: string,
  neteaseUserId?: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    resolveConnection = resolve;

    const { cleanUrl, protocols } = inferProtocols(serverUrl, port);
    currentServerUrl = cleanUrl;
    currentPort = port;

    let protocolIndex = 0;
    let resolved = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const resolveOnce = (value: boolean): void => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(value);
      }
    };

    const tryProtocol = (): void => {
      if (connectionCancelled || resolved) {
        resolveOnce(false);
        return;
      }

      if (protocolIndex >= protocols.length) {
        console.log("[ListenTogether] 所有协议尝试失败");
        resolveOnce(false);
        return;
      }

      const protocol = protocols[protocolIndex];
      const wsUrl = `${protocol}://${cleanUrl}:${port}/ws`;
      console.log(`[ListenTogether] 创建WebSocket: ${wsUrl}`);

      // 关闭旧 WebSocket 并解绑回调，避免协议降级时旧连接竞态
      if (ws) {
        const oldWs = ws;
        ws = null;
        oldWs.onopen = null;
        oldWs.onmessage = null;
        oldWs.onerror = null;
        oldWs.onclose = null;
        oldWs.close();
      }

      ws = new WebSocket(wsUrl);

      timeout = setTimeout(() => {
        console.log(`[ListenTogether] ${protocol.toUpperCase()} 连接超时`);
        ws?.close();
      }, 10000);

      ws.onopen = () => {
        if (connectionCancelled || resolved) {
          ws?.close();
          return;
        }
        cleanup(); // 连接已打开，清除超时定时器
        console.log(`[ListenTogether] WebSocket已打开，发送加入房间请求`);
        const joinMsg: ListenTogetherClientMessage = {
          op: "join",
          payload: { roomId, roomKey, nickname, neteaseUserId, clientTimestamp: Date.now() },
        };
        ws?.send(JSON.stringify(joinMsg));
      };

      ws.onmessage = (event) => {
        if (connectionCancelled || resolved) return;

        // 更新最后消息时间，用于心跳超时检测
        lastMessageTime = Date.now();

        try {
          const msg = JSON.parse(event.data as string) as ListenTogetherServerMessage;
          console.log(`[ListenTogether] 收到服务端消息: kind=${msg.kind}`);
          handleServerMessage(msg);

          if (msg.kind === "error") {
            ws?.close();
            resolveOnce(false);
            return;
          }

          if (msg.kind === "joined") {
            const data = msg.data as
              | { token?: string; room?: ListenTogetherRoom; memberId?: string }
              | undefined;
            if (data?.token && data?.room?.id && data?.memberId) {
              // 连接建立成功，切换到长期处理器
              cleanup();
              ws!.onclose = handleDisconnect;
              ws!.onerror = handleError;
              ws!.onmessage = (event) => {
                if (connectionCancelled) return;
                lastMessageTime = Date.now();
                try {
                  const serverMsg = JSON.parse(event.data as string) as ListenTogetherServerMessage;
                  handleServerMessage(serverMsg);
                } catch (err) {
                  console.log("[ListenTogether] 消息解析失败", err);
                  safeForEach(listeners.error, "消息解析失败");
                }
              };
              startHeartbeat();
              startHeartbeatTimeout();
              resolveOnce(true);
            } else {
              // joined 消息数据不完整，连接失败
              console.log("[ListenTogether] joined 消息数据不完整，连接失败");
              resolved = true;
              ws?.close();
              resolveOnce(false);
            }
          }
        } catch (err) {
          console.log("[ListenTogether] 消息解析失败", err);
          safeForEach(listeners.error, "消息解析失败");
        }
      };

      ws.onerror = (err) => {
        console.log(`[ListenTogether] ${protocol.toUpperCase()} 连接发生错误`, err);
      };

      ws.onclose = () => {
        cleanup();
        if (connectionCancelled || isManualDisconnect) {
          console.log("[ListenTogether] 连接被取消或手动断开，停止尝试后续协议");
          resolveOnce(false);
          return;
        }
        if (!resolved) {
          // 该协议连接失败，尝试下一个协议
          protocolIndex++;
          tryProtocol();
        }
      };
    };

    tryProtocol();
  });
}

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
      if (data && data.token && data.room && data.room.id && data.memberId) {
        console.log(
          `[ListenTogether] 加入房间成功: roomId=${data.room.id}, memberCount=${data.room.members.length}, token=${data.token.slice(0, 8)}..., memberId=${data.memberId.slice(0, 8)}...`,
        );
        memberToken = data.token;
        // 深拷贝房间数据，避免与服务端共享引用导致状态不同步
        currentRoom = {
          ...data.room,
          members: data.room.members.map((m) => ({ ...m })),
          currentTrack: data.room.currentTrack ? { ...data.room.currentTrack } : null,
          queue: data.room.queue ? data.room.queue.map((q) => ({ ...q })) : [],
        };
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
          console.log(
            `[ListenTogether] 时间同步完成: offset=${serverTimeOffset.toFixed(1)}ms, rtt=${rtt}ms`,
          );
        }
        if (data.chatHistory && data.chatHistory.length > 0) {
          console.log(`[ListenTogether] 收到聊天历史: ${data.chatHistory.length}条`);
          safeForEach(listeners.chatHistory, data.chatHistory);
        }
        setState("connected");
        safeForEach(listeners.roomUpdate, currentRoom);
      } else {
        console.log("[ListenTogether] joined消息数据不完整，加入失败");
        safeForEach(listeners.error, "加入房间失败：服务端返回数据不完整");
      }
      break;
    }
    case "memberJoined": {
      const data = msg.data as { member: ListenTogetherMember; memberCount: number } | undefined;
      if (data?.member) {
        console.log(
          `[ListenTogether] 成员加入: memberId=${data.member.id}, nickname=${data.member.nickname}, memberCount=${data.memberCount}`,
        );
        if (currentRoom && !currentRoom.members.find((m) => m.id === data.member.id)) {
          currentRoom.members.push(data.member);
        }
        safeForEach(listeners.memberJoined, data.member);
        safeForEach(listeners.roomUpdate, currentRoom);
      }
      break;
    }
    case "memberLeft": {
      const data = msg.data as { memberId: string; memberCount: number } | undefined;
      if (data?.memberId && currentRoom) {
        console.log(
          `[ListenTogether] 成员离开: memberId=${data.memberId}, memberCount=${data.memberCount}`,
        );
        currentRoom.members = currentRoom.members.filter((m) => m.id !== data.memberId);
        safeForEach(listeners.memberLeft, data.memberId);
        safeForEach(listeners.roomUpdate, currentRoom);
      }
      break;
    }
    case "roomUpdate": {
      const updatedRoom = msg.data as ListenTogetherRoom | undefined;
      if (updatedRoom?.id) {
        currentRoom = {
          ...updatedRoom,
          members: updatedRoom.members.map((m) => ({ ...m })),
          currentTrack: updatedRoom.currentTrack ? { ...updatedRoom.currentTrack } : null,
          queue: updatedRoom.queue ? updatedRoom.queue.map((q) => ({ ...q })) : [],
        };
        safeForEach(listeners.roomUpdate, currentRoom);
      }
      break;
    }
    case "sync": {
      const syncState = msg.data as ListenTogetherSyncState | undefined;
      if (syncState) {
        console.log(
          `[ListenTogether] 收到播放同步: trackId=${syncState.track?.id ?? "null"}, position=${syncState.position}, isPlaying=${syncState.isPlaying}`,
        );
        if (currentRoom) {
          currentRoom.currentTrack = syncState.track;
          currentRoom.position = syncState.position;
          currentRoom.state = syncState.isPlaying ? "playing" : "paused";
        }
        safeForEach(listeners.sync, syncState);
      }
      break;
    }
    case "proposal": {
      const proposal = msg.data as ListenTogetherActionProposal | undefined;
      if (proposal) {
        console.log(
          `[ListenTogether] 收到提案: proposalId=${proposal.id}, type=${proposal.type}, proposer=${proposal.proposerId}`,
        );
        safeForEach(listeners.proposal, proposal);
      }
      break;
    }
    case "voteUpdate": {
      const data = msg.data as
        | { proposalId: string; memberId: string; agree: boolean; passed: boolean }
        | undefined;
      if (data) {
        console.log(
          `[ListenTogether] 投票更新: proposalId=${data.proposalId}, memberId=${data.memberId}, agree=${data.agree}, passed=${data.passed}`,
        );
        safeForEach(listeners.voteUpdate, data);
      }
      break;
    }
    case "executed": {
      const data = msg.data as
        | { proposalId: string; result: boolean; payload?: unknown }
        | undefined;
      if (data) {
        console.log(
          `[ListenTogether] 提案执行: proposalId=${data.proposalId}, result=${data.result}`,
        );
        safeForEach(listeners.executed, data);
      }
      break;
    }
    case "chat": {
      const message = msg.data as ListenTogetherChatMessage | undefined;
      if (message) {
        console.log(
          `[ListenTogether] 收到聊天消息: sender=${message.senderId}, content=${message.content.slice(0, 50)}`,
        );
        safeForEach(listeners.chat, message);
      }
      break;
    }
    case "error": {
      const data = msg.data as { error: string } | undefined;
      console.log(`[ListenTogether] 服务端错误详情原始data:`, JSON.stringify(msg.data));
      if (data?.error) {
        console.log(`[ListenTogether] 服务端错误: ${data.error}`);
        safeForEach(listeners.error, data.error);
      } else {
        console.log(
          `[ListenTogether] 服务端错误但data为空或error为空, data=`,
          JSON.stringify(data),
        );
        safeForEach(listeners.error, "服务端返回错误");
      }
      break;
    }
    case "roomClosed": {
      console.log("[ListenTogether] 房间已关闭，通知UI后执行断开连接");
      safeForEach(listeners.error, "房间已关闭");
      safeForEach(listeners.roomUpdate, null);
      disconnect();
      break;
    }
    case "kicked": {
      const data = msg.data as { memberId: string; reason?: string } | undefined;
      const targetMemberId = data?.memberId;
      console.log(
        `[ListenTogether] 收到踢出通知: memberId=${targetMemberId}, reason=${data?.reason ?? "无"}`,
      );
      if (!targetMemberId || targetMemberId === currentMemberId) {
        safeForEach(listeners.kicked, data?.reason ?? "被踢出房间");
        disconnect();
      }
      break;
    }
    case "blacklisted": {
      const data = msg.data as { memberId: string; reason?: string } | undefined;
      const targetMemberId = data?.memberId;
      console.log(
        `[ListenTogether] 收到拉黑通知: memberId=${targetMemberId}, reason=${data?.reason ?? "无"}`,
      );
      if (!targetMemberId || targetMemberId === currentMemberId) {
        safeForEach(listeners.blacklisted, data?.reason ?? "已被拉黑");
        disconnect();
      }
      break;
    }
    case "onlineUrl": {
      const data = msg.data as { trackId: string; url: string } | undefined;
      if (data) {
        console.log(
          `[ListenTogether] 收到在线URL: trackId=${data.trackId}, url长度=${data.url.length}`,
        );
        safeForEach(listeners.onlineUrl, data);
      }
      break;
    }
    case "queueUpdate": {
      const queue = msg.data as ListenTogetherQueueItem[] | undefined;
      if (queue && currentRoom) {
        currentRoom.queue = queue;
        safeForEach(listeners.queueUpdate, queue);
        safeForEach(listeners.roomUpdate, currentRoom);
      }
      break;
    }
    case "searchShared": {
      const share = msg.data as ListenTogetherSearchShare | undefined;
      if (share) {
        safeForEach(listeners.searchShared, share);
      }
      break;
    }
    case "reaction": {
      const reaction = msg.data as ListenTogetherReaction | undefined;
      if (reaction) {
        safeForEach(listeners.reaction, reaction);
      }
      break;
    }
    case "bestAudioSource": {
      const source = msg.data as ListenTogetherAudioSource | undefined;
      if (source) {
        console.log(
          `[ListenTogether] 收到最优音源: memberId=${source.memberId}, quality=${source.quality}, type=${source.sourceType}`,
        );
        safeForEach(listeners.bestAudioSource, source);
      }
      break;
    }
    case "audioSourceUpdate": {
      const sources = msg.data as ListenTogetherAudioSource[] | undefined;
      if (sources) {
        console.log(`[ListenTogether] 收到音源更新: 共${sources.length}个音源`);
        safeForEach(listeners.audioSourceUpdate, sources);
      }
      break;
    }
    case "messageRecalled": {
      const data = msg.data as { messageId: string; recalledBy: string } | undefined;
      if (data) {
        safeForEach(listeners.messageRecalled, data);
      }
      break;
    }
    case "chatAck": {
      const data = msg.data as { msgId: string; seqId: number } | undefined;
      if (data) {
        console.log(`[ListenTogether] 收到聊天确认: msgId=${data.msgId}, seqId=${data.seqId}`);
        safeForEach(listeners.chatAck, data);
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
export const sendSync = async (
  track: Track | null,
  position: number,
  isPlaying: boolean,
): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送同步失败: WebSocket未打开");
    return;
  }
  console.log(
    `[ListenTogether] 发送播放同步: trackId=${track?.id ?? "null"}, position=${position}, isPlaying=${isPlaying}`,
  );
  const payload = { track, position, isPlaying };
  console.log(
    "[ListenTogether] 发送同步payload结构:",
    JSON.stringify({ hasTrack: !!track, trackId: track?.id, position, isPlaying }),
  );
  const msg: ListenTogetherClientMessage = {
    op: "sync",
    payload,
    signature: await signPayload(payload),
  };
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 播放同步已发送");
  } catch (err) {
    console.log("[ListenTogether] 发送播放同步异常:", err);
  }
};

/** 发送操作提案 */
export const sendProposal = async (type: string, payload: unknown): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送提案失败: WebSocket未打开");
    return;
  }
  console.log(
    `[ListenTogether] 发送提案: type=${type}, payload=${JSON.stringify(payload).slice(0, 100)}`,
  );
  const data = { type, data: payload };
  const msg: ListenTogetherClientMessage = {
    op: "propose",
    payload: data,
    signature: await signPayload(data),
  };
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 提案已发送");
  } catch (err) {
    console.log("[ListenTogether] 发送提案异常:", err);
  }
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
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 投票已发送");
  } catch (err) {
    console.log("[ListenTogether] 发送投票异常:", err);
  }
};

/** 发送聊天消息
 * @param content - 消息内容
 * @param replyTo - 引用的消息（可选）
 * @param mentions - @的成员ID列表（可选）
 */
export const sendChat = async (
  content: string,
  replyTo?: { messageId: string; senderNickname: string; content: string },
  mentions?: string[],
): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送聊天失败: WebSocket未打开");
    return;
  }
  console.log(`[ListenTogether] 发送聊天消息: content=${content.slice(0, 50)}`);
  const payload = { content, replyTo, mentions };
  const msg: ListenTogetherClientMessage = {
    op: "chat",
    payload,
    signature: await signPayload(payload),
  };
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 聊天消息已发送");
  } catch (err) {
    console.log("[ListenTogether] 发送聊天消息异常:", err);
  }
};

/** 发送撤回消息 */
export const sendRecall = async (messageId: string): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送撤回失败: WebSocket未打开");
    return;
  }
  console.log(`[ListenTogether] 发送撤回请求: messageId=${messageId}`);
  const payload = { messageId };
  const msg: ListenTogetherClientMessage = {
    op: "recall",
    payload,
    signature: await signPayload(payload),
  };
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 撤回请求已发送");
  } catch (err) {
    console.log("[ListenTogether] 发送撤回异常:", err);
  }
};

/** 发送心跳 */
export const sendHeartbeat = async (): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送心跳失败: WebSocket未打开");
    return;
  }
  console.log("[ListenTogether] 发送心跳");
  const payload = { timestamp: Date.now() };
  const msg: ListenTogetherClientMessage = {
    op: "heartbeat",
    payload,
    signature: await signPayload(payload),
  };
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    console.log("[ListenTogether] 发送心跳异常:", err);
  }
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
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 踢出请求已发送");
  } catch (err) {
    console.log("[ListenTogether] 发送踢出请求异常:", err);
  }
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
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 拉黑请求已发送");
  } catch (err) {
    console.log("[ListenTogether] 发送拉黑请求异常:", err);
  }
};

/** 发送队列操作
 * @returns 是否发送成功
 */
export const sendQueue = async (action: string, payload: unknown): Promise<boolean> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送队列操作失败: WebSocket未打开");
    return false;
  }
  console.log(`[ListenTogether] 发送队列操作: action=${action}`);
  const data = { action, data: payload };
  const msg: ListenTogetherClientMessage = {
    op: "queue",
    payload: data,
    signature: await signPayload(data),
  };
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 队列操作已发送");
    return true;
  } catch (err) {
    console.log("[ListenTogether] 发送队列操作异常:", err);
    return false;
  }
};

/** 发送搜索共享 */
export const sendSearchShare = async (
  platform: string,
  keyword: string,
  results: unknown,
): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送搜索共享失败: WebSocket未打开");
    return;
  }
  console.log(`[ListenTogether] 发送搜索共享: platform=${platform}, keyword=${keyword}`);
  const payload = { platform, keyword, results };
  const msg: ListenTogetherClientMessage = {
    op: "searchShare",
    payload,
    signature: await signPayload(payload),
  };
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 搜索共享已发送");
  } catch (err) {
    console.log("[ListenTogether] 发送搜索共享异常:", err);
  }
};

/** 发送表情反应 */
export const sendReaction = async (emoji: string): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送表情反应失败: WebSocket未打开");
    return;
  }
  console.log(`[ListenTogether] 发送表情反应: emoji=${emoji}`);
  const payload = { emoji };
  const msg: ListenTogetherClientMessage = {
    op: "reaction",
    payload,
    signature: await signPayload(payload),
  };
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 表情反应已发送");
  } catch (err) {
    console.log("[ListenTogether] 发送表情反应异常:", err);
  }
};

/** 发送音源品质报告 */
export const sendAudioSource = async (source: ListenTogetherAudioSource): Promise<void> => {
  if (ws?.readyState !== WebSocket.OPEN) {
    console.log("[ListenTogether] 发送音源报告失败: WebSocket未打开");
    return;
  }
  console.log(
    `[ListenTogether] 发送音源报告: trackId=${source.trackId}, quality=${source.quality}, type=${source.sourceType}`,
  );
  const msg: ListenTogetherClientMessage = {
    op: "audioSource",
    payload: source,
    signature: await signPayload(source),
  };
  try {
    ws.send(JSON.stringify(msg));
    console.log("[ListenTogether] 音源报告已发送");
  } catch (err) {
    console.log("[ListenTogether] 发送音源报告异常:", err);
  }
};

/** 清除所有监听器 */
export const clearAllListeners = (): void => {
  for (const key of Object.keys(listeners)) {
    (listeners[key as keyof typeof listeners] as Set<unknown>).clear();
  }
  console.log("[ListenTogether] 所有监听器已清除");
};

/** 订阅连接状态变化 */
export const onStateChange = (
  callback: (state: ListenTogetherConnectionState) => void,
): (() => void) => {
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
export const onChatHistory = (
  callback: (messages: ListenTogetherChatMessage[]) => void,
): (() => void) => {
  listeners.chatHistory.add(callback);
  return () => listeners.chatHistory.delete(callback);
};

/** 订阅提案 */
export const onProposal = (
  callback: (proposal: ListenTogetherActionProposal) => void,
): (() => void) => {
  listeners.proposal.add(callback);
  return () => listeners.proposal.delete(callback);
};

/** 订阅投票更新 */
export const onVoteUpdate = (
  callback: (data: {
    proposalId: string;
    memberId: string;
    agree: boolean;
    passed: boolean;
  }) => void,
): (() => void) => {
  listeners.voteUpdate.add(callback);
  return () => listeners.voteUpdate.delete(callback);
};

/** 订阅执行结果 */
export const onExecuted = (
  callback: (data: { proposalId: string; result: boolean; payload?: unknown }) => void,
): (() => void) => {
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
export const onOnlineUrl = (
  callback: (data: { trackId: string; url: string }) => void,
): (() => void) => {
  listeners.onlineUrl.add(callback);
  return () => listeners.onlineUrl.delete(callback);
};

/** 订阅队列更新 */
export const onQueueUpdate = (
  callback: (queue: ListenTogetherQueueItem[]) => void,
): (() => void) => {
  listeners.queueUpdate.add(callback);
  return () => listeners.queueUpdate.delete(callback);
};

/** 订阅搜索共享 */
export const onSearchShared = (
  callback: (share: ListenTogetherSearchShare) => void,
): (() => void) => {
  listeners.searchShared.add(callback);
  return () => listeners.searchShared.delete(callback);
};

/** 订阅表情反应 */
export const onReaction = (callback: (reaction: ListenTogetherReaction) => void): (() => void) => {
  listeners.reaction.add(callback);
  return () => listeners.reaction.delete(callback);
};

/** 订阅最优音源 */
export const onBestAudioSource = (
  callback: (source: ListenTogetherAudioSource) => void,
): (() => void) => {
  listeners.bestAudioSource.add(callback);
  return () => listeners.bestAudioSource.delete(callback);
};

/** 订阅音源更新 */
export const onAudioSourceUpdate = (
  callback: (sources: ListenTogetherAudioSource[]) => void,
): (() => void) => {
  listeners.audioSourceUpdate.add(callback);
  return () => listeners.audioSourceUpdate.delete(callback);
};

/** 订阅消息撤回 */
export const onMessageRecalled = (
  callback: (data: { messageId: string; recalledBy: string }) => void,
): (() => void) => {
  listeners.messageRecalled.add(callback);
  return () => listeners.messageRecalled.delete(callback);
};

/** 订阅聊天确认 */
export const onChatAck = (
  callback: (data: { msgId: string; seqId: number }) => void,
): (() => void) => {
  listeners.chatAck.add(callback);
  return () => listeners.chatAck.delete(callback);
};

/** 启动心跳定时器 */

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
