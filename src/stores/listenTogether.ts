/**
 * 一起听 Pinia Store
 * 管理一起听的房间状态、连接、聊天和投票
 */

import { ref, computed, shallowRef, watch } from "vue";
import { defineStore } from "pinia";
import type {
  ListenTogetherRoom,
  ListenTogetherChatMessage,
  ListenTogetherActionProposal,
} from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import * as lt from "@/services/listenTogether";
import * as player from "@/core/player";
import * as playback from "@/services/playback";

export const useListenTogetherStore = defineStore("listenTogether", () => {
  /** 连接状态 */
  const connectionState = ref<lt.ListenTogetherConnectionState>("idle");
  /** 当前房间 */
  const room = shallowRef<ListenTogetherRoom | null>(null);
  /** 聊天消息列表 */
  const chatMessages = ref<ListenTogetherChatMessage[]>([]);
  /** 活跃提案 */
  const activeProposals = ref<ListenTogetherActionProposal[]>([]);
  /** 当前是否为房主 */
  const isHost = ref(false);
  /** 当前主控成员ID */
  const controllerId = ref<string | null>(null);
  /** 服务器地址 */
  const serverUrl = ref("127.0.0.1");
  /** 服务器端口 */
  const serverPort = ref(14558);
  /** 房间ID */
  const roomId = ref("");
  /** 房间密钥 */
  const roomKey = ref("");
  /** 房主token（仅房主有） */
  const hostToken = ref("");
  /** 当前成员ID */
  const memberId = ref("");
  /** 成员昵称 */
  const nickname = ref("");
  /** 是否已连接 */
  const isConnected = computed(() => connectionState.value === "connected");
  /** 成员数量 */
  const memberCount = computed(() => room.value?.members.length ?? 0);
  /** 在线音乐URL缓存（trackId -> url） */
  const onlineUrls = ref<Record<string, string>>({});
  /** 最后错误信息 */
  const lastError = ref<string | null>(null);

  /** 同步操作竞态 token */
  let syncToken = 0;
  /** 自动同步 watcher 清理函数列表 */
  let autoSyncUnsubscribers: Array<() => void> = [];
  /** 上次同步的播放位置 */
  let lastSyncPosition = 0;
  /** 上次同步位置的时间戳 */
  let lastSyncPositionTime = 0;
  /** 位置同步最小间隔（毫秒） */
  const SYNC_POSITION_INTERVAL = 5000;
  /** 小偏差忽略阈值（毫秒） */
  const SYNC_IGNORE_THRESHOLD = 1200;
  /** 强制 seek 阈值（毫秒） */
  const SYNC_SEEK_THRESHOLD = 5000;
  /** 两次 seek 之间的最小间隔（毫秒） */
  const SYNC_MIN_SEEK_INTERVAL = 5000;
  /** 网络延迟上限（毫秒） */
  const SYNC_MAX_LATENCY = 1000;

  /** 上次 seek 时间戳 */
  let lastSeekAt = 0;

  /** 创建房间（房主）
   * @param name - 用户昵称
   * @param neteaseUserId - 网易云用户ID（可选）
   * @param roomName - 房间名称（可选，覆盖默认设置）
   * @param authKey - 鉴权密钥（可选，覆盖设置中的值）
   * @returns 是否创建成功
   */
  const createRoom = async (name: string, neteaseUserId?: number, roomName?: string, authKey?: string): Promise<boolean> => {
    console.log(`[ListenTogether] 开始创建房间, name=${name}, neteaseUserId=${neteaseUserId ?? "null"}, roomName=${roomName ?? "default"}`);
    try {
      const effectiveAuthKey = authKey || (await window.api.config.get("listenTogether.authKey"));
      console.log("[ListenTogether] 已获取 authKey");
      const result = await window.api.listenTogether.createRoom(
        name,
        neteaseUserId,
        effectiveAuthKey as string,
        roomName,
      );
      if (!result.ok || !result.room) {
        console.log("[ListenTogether] 创建房间失败, result:", result);
        return false;
      }

      room.value = result.room as unknown as ListenTogetherRoom;
      roomId.value = result.room.id as string;
      roomKey.value = result.roomKey || "";
      hostToken.value = result.hostToken || "";
      isHost.value = true;
      console.log(`[ListenTogether] 房间创建成功, roomId=${roomId.value}, roomKey=${roomKey.value}`);

      // 房主也需要通过WS加入自己的房间
      const port = (await window.api.config.get("externalApi.port")) || 14558;
      const allowLan = (await window.api.config.get("externalApi.allowLan")) || false;
      const url = allowLan ? serverUrl.value : "127.0.0.1";
      serverPort.value = port as number;
      console.log(`[ListenTogether] 房主准备连接WebSocket, url=${url}, port=${port}`);

      // 使用hostToken作为roomKey加入WS
      const success = await lt.connect(url, port as number, roomId.value, hostToken.value, name, neteaseUserId);
      if (success) {
        connectionState.value = "connected";
        setupListeners();
        lt.startHeartbeat();
        startAutoSync();
        console.log("[ListenTogether] 房主WebSocket连接成功, 已启动自动同步");
      } else {
        console.log("[ListenTogether] 房主WebSocket连接失败");
      }
      return success;
    } catch (err) {
      console.error("[ListenTogether] 创建房间异常:", err);
      return false;
    }
  };

  /** 关闭房间 */
  const closeRoom = async (): Promise<void> => {
    console.log(`[ListenTogether] 关闭房间, roomId=${roomId.value}`);
    if (roomId.value) {
      await window.api.listenTogether.closeRoom(roomId.value);
      console.log("[ListenTogether] 已通知服务端关闭房间");
    }
    stopAutoSync();
    lt.stopHeartbeat();
    lt.disconnect();
    resetState();
    console.log("[ListenTogether] 房间关闭完成, 状态已重置");
  };

  /** 加入房间
   * @param url - 服务器地址
   * @param port - 服务器端口
   * @param id - 房间ID
   * @param key - 房间密钥
   * @param name - 用户昵称
   * @param neteaseUserId - 网易云用户ID（可选）
   * @returns 是否加入成功
   */
  const joinRoom = async (
    url: string,
    port: number,
    id: string,
    key: string,
    name: string,
    neteaseUserId?: number,
  ): Promise<boolean> => {
    console.log(`[ListenTogether] 加入房间, url=${url}, port=${port}, roomId=${id}, name=${name}`);
    serverUrl.value = url;
    serverPort.value = port;
    roomId.value = id;
    roomKey.value = key;
    nickname.value = name;

    const success = await lt.connect(url, port, id, key, name, neteaseUserId);
    if (success) {
      isHost.value = false;
      setupListeners();
      lt.startHeartbeat();
      console.log("[ListenTogether] 加入房间成功, 已设置监听器并启动心跳");
    } else {
      console.log("[ListenTogether] 加入房间失败");
    }
    return success;
  };

  /** 离开房间 */
  const leaveRoom = (): void => {
    console.log("[ListenTogether] 离开房间");
    stopAutoSync();
    lt.stopHeartbeat();
    lt.disconnect();
    resetState();
    console.log("[ListenTogether] 离开房间完成, 状态已重置");
  };

  /** 发送聊天消息
   * @param content - 消息内容
   */
  const sendChat = async (content: string): Promise<void> => {
    console.log(`[ListenTogether] 发送聊天消息: ${content}`);
    await lt.sendChat(content);
  };

  /** 发送操作提案
   * @param type - 提案类型
   * @param payload - 提案数据
   */
  const proposeAction = async (type: string, payload: unknown): Promise<void> => {
    console.log(`[ListenTogether] 发送提案, type=${type}, payload=`, payload);
    await lt.sendProposal(type, payload);
  };

  /** 投票
   * @param proposalId - 提案ID
   * @param agree - 是否同意
   */
  const vote = async (proposalId: string, agree: boolean): Promise<void> => {
    console.log(`[ListenTogether] 投票, proposalId=${proposalId}, agree=${agree}`);
    await lt.sendVote(proposalId, agree);
  };

  /** 发送同步状态
   * @param track - 当前播放的Track
   * @param position - 播放位置（毫秒）
   * @param isPlaying - 是否正在播放
   */
  const syncPlayback = (track: Track | null, position: number, isPlaying: boolean): void => {
    if (isHost.value) {
      console.log(`[ListenTogether] 发送播放同步, trackId=${track?.id ?? "null"}, position=${position}, isPlaying=${isPlaying}`);
      lt.sendSync(track, position, isPlaying);
    }
  };

  /** 设置监听器 */
  const setupListeners = (): void => {
    lt.onStateChange((state) => {
      console.log(`[ListenTogether] WebSocket状态变化: ${connectionState.value} -> ${state}`);
      connectionState.value = state;
      if (state === "connected") {
        memberId.value = lt.getMemberId() ?? "";
        console.log(`[ListenTogether] 连接成功, memberId=${memberId.value}`);
      }
    });

    lt.onRoomUpdate((updatedRoom) => {
      console.log(`[ListenTogether] 房间信息更新, controllerId=${updatedRoom?.controllerId ?? "null"}, memberCount=${updatedRoom?.members.length ?? 0}`);
      room.value = updatedRoom;
      if (updatedRoom) {
        controllerId.value = updatedRoom.controllerId;
      }
    });

    lt.onSync((syncState) => {
      console.log(`[ListenTogether] 收到播放同步, trackId=${syncState.track?.id ?? "null"}, position=${syncState.position}, isPlaying=${syncState.isPlaying}, senderId=${syncState.senderId}`);
      // 非房主接收同步状态时执行播放器操作
      if (!isHost.value) {
        void executeSync(syncState);
      }
    });

    lt.onChat((message) => {
      console.log(`[ListenTogether] 收到聊天消息, sender=${message.senderNickname}, content=${message.content}`);
      chatMessages.value.push(message);
    });

    lt.onChatHistory((messages) => {
      console.log(`[ListenTogether] 收到聊天历史, 共${messages.length}条消息`);
      chatMessages.value = messages;
    });

    lt.onProposal((proposal) => {
      console.log(`[ListenTogether] 收到提案, id=${proposal.id}, type=${proposal.type}, proposerId=${proposal.proposerId}`);
      activeProposals.value.push(proposal);
      // 如果是房主收到的提案且已执行，立即清理
      if (proposal.executed) {
        setTimeout(() => {
          activeProposals.value = activeProposals.value.filter((p) => p.id !== proposal.id);
        }, 3000);
      }
    });

    lt.onVoteUpdate((data) => {
      console.log(`[ListenTogether] 投票更新, proposalId=${data.proposalId}, memberId=${data.memberId}, agree=${data.agree}`);
      const p = activeProposals.value.find((ap) => ap.id === data.proposalId);
      if (p) {
        p.votes[data.memberId] = data.agree;
      }
    });

    lt.onExecuted((data) => {
      console.log(`[ListenTogether] 提案已执行, proposalId=${data.proposalId}`);
      activeProposals.value = activeProposals.value.filter((p) => p.id !== data.proposalId);
      // 非房主执行操作
      if (!isHost.value && data.payload) {
        executeProposal(data.payload as { type: string; data: unknown });
      }
    });

    lt.onMemberJoined((member) => {
      console.log(`[ListenTogether] 成员加入, id=${member.id}, name=${member.nickname}`);
      if (room.value && !room.value.members.find((m) => m.id === member.id)) {
        room.value.members.push(member);
      }
    });

    lt.onMemberLeft((memberId) => {
      console.log(`[ListenTogether] 成员离开, id=${memberId}`);
      if (room.value) {
        room.value.members = room.value.members.filter((m) => m.id !== memberId);
      }
    });

    lt.onError((error) => {
      console.error("[ListenTogether] error:", error);
      lastError.value = error;
    });

    lt.onKicked((reason) => {
      console.log(`[ListenTogether] 被踢出房间, reason=${reason}`);
      lastError.value = reason;
      lt.disconnect();
      resetState();
    });

    lt.onBlacklisted((reason) => {
      console.log(`[ListenTogether] 被拉黑, reason=${reason}`);
      lastError.value = reason;
      lt.disconnect();
      resetState();
    });

    lt.onOnlineUrl((data) => {
      console.log(`[ListenTogether] 收到在线URL, trackId=${data.trackId}, url=${data.url}`);
      onlineUrls.value[data.trackId] = data.url;
    });
  };

  /** 房主自动同步播放状态到房间 */
  const startAutoSync = (): void => {
    console.log("[ListenTogether] 启动自动同步");
    stopAutoSync();
    if (!isHost.value) {
      console.log("[ListenTogether] 非房主, 跳过自动同步");
      return;
    }

    const media = useMediaStore();
    const status = useStatusStore();

    // 监听切歌
    const unwatchTrack = watch(
      () => media.track?.id,
      (newId, oldId) => {
        if (newId && newId !== oldId) {
          console.log(`[ListenTogether] 自动同步: 切歌 trackId=${newId}`);
          syncPlayback(media.track, status.position, status.isPlaying);
        }
      },
    );

    // 监听播放/暂停状态
    const unwatchPlaying = watch(
      () => status.isPlaying,
      (isPlaying) => {
        console.log(`[ListenTogether] 自动同步: 播放状态变化 isPlaying=${isPlaying}`);
        syncPlayback(media.track, status.position, isPlaying);
      },
    );

    // 监听播放位置变化（节流）
    const unwatchPosition = watch(
      () => status.position,
      (position) => {
        const now = Date.now();
        const delta = Math.abs(position - lastSyncPosition);
        const timeSinceLast = now - lastSyncPositionTime;
        if (delta > SYNC_SEEK_THRESHOLD || timeSinceLast > SYNC_POSITION_INTERVAL) {
          console.log(`[ListenTogether] 自动同步: 位置变化 position=${position}, delta=${delta}, timeSinceLast=${timeSinceLast}`);
          lastSyncPosition = position;
          lastSyncPositionTime = now;
          syncPlayback(media.track, position, status.isPlaying);
        }
      },
    );

    autoSyncUnsubscribers = [unwatchTrack, unwatchPlaying, unwatchPosition];
  };

  /** 停止自动同步 */
  const stopAutoSync = (): void => {
    console.log("[ListenTogether] 停止自动同步");
    for (const off of autoSyncUnsubscribers) off();
    autoSyncUnsubscribers = [];
    lastSyncPosition = 0;
    lastSyncPositionTime = 0;
  };

  /** 执行同步状态（非房主） */
  const executeSync = async (syncState: {
    track: Track | null;
    position: number;
    isPlaying: boolean;
    sendTimestamp: number;
    senderId: string;
  }): Promise<void> => {
    const myToken = ++syncToken;
    const media = useMediaStore();

    // 如果 track 存在且与当前播放不同，加载新歌曲
    if (syncState.track && syncState.track.id !== media.track?.id) {
      console.log(`[ListenTogether] 同步加载新歌曲 trackId=${syncState.track.id}`);
      await player.loadTrack(syncState.track);
    }

    // 若被更新的同步接管则放弃
    if (myToken !== syncToken) return;

    // 确保当前播放的是目标歌曲（加载失败时可能不同）
    if (syncState.track && media.track?.id !== syncState.track.id) return;

    // 调整播放状态
    if (syncState.isPlaying) {
      await player.play();
    } else {
      await player.pause();
    }

    // 若被更新的同步接管则放弃
    if (myToken !== syncToken) return;

    // 计算目标播放位置，补偿网络延迟和时钟偏移
    // 使用加入房间时一次性同步得到的时间偏移，不再周期更新
    const offset = lt.getServerTimeOffset();
    const serverSendAtClientTime = syncState.sendTimestamp - offset;
    const oneWayLatency = Date.now() - serverSendAtClientTime;
    const compensatedLatency = Math.min(Math.max(oneWayLatency, 0), SYNC_MAX_LATENCY);
    const targetPos = syncState.position + compensatedLatency;
    const currentPos = playback.getCurrentTime();
    const diff = currentPos - targetPos;

    console.log(`[ListenTogether] 位置同步检查: currentPos=${currentPos.toFixed(0)}, targetPos=${targetPos.toFixed(0)}, diff=${diff.toFixed(0)}ms, latency=${compensatedLatency.toFixed(0)}ms, offset=${offset.toFixed(0)}ms`);

    // 偏差在忽略阈值内，不做任何调整，避免频繁 seek 造成跳动
    if (Math.abs(diff) <= SYNC_IGNORE_THRESHOLD) {
      console.log(`[ListenTogether] 位置偏差在可忽略范围内，跳过 seek`);
      return;
    }

    // 偏差超过强制 seek 阈值，或上次 seek 已经超过最小间隔，才执行 seek
    const canSeek = Math.abs(diff) > SYNC_SEEK_THRESHOLD || (Date.now() - lastSeekAt > SYNC_MIN_SEEK_INTERVAL);
    if (!canSeek) {
      console.log(`[ListenTogether] 位置偏差未达强制阈值，且距离上次 seek 过近，跳过 seek (diff=${diff.toFixed(0)}ms)`);
      return;
    }

    // 执行 seek 并记录时间
    await player.seek(targetPos);
    lastSeekAt = Date.now();
    console.log(`[ListenTogether] 同步执行 seek(${targetPos}), 偏差=${diff.toFixed(0)}ms`);
  };


  /** 执行提案操作（非房主） */
  const executeProposal = (payload: { type: string; data: unknown }): void => {
    console.log(`[ListenTogether] 执行提案操作, type=${payload.type}, data=`, payload.data);
    switch (payload.type) {
      case "play":
        void player.play();
        break;
      case "pause":
        void player.pause();
        break;
      case "togglePlay":
        player.togglePlay();
        break;
      case "seek": {
        const pos = (payload.data as { position?: number })?.position ?? 0;
        console.log(`[ListenTogether] 提案执行seek, position=${pos}`);
        void player.seek(pos);
        break;
      }
      case "skip":
      case "next":
        void player.nextTrack();
        break;
      case "prev":
        void player.prevTrack();
        break;
      case "loadTrack": {
        const track = payload.data as Track | null;
        if (track) void player.loadTrack(track);
        break;
      }
      default:
        console.log("[ListenTogether] 未处理的提案类型:", payload.type, payload.data);
    }
  };

  /** 重置状态 */
  const resetState = (): void => {
    console.log("[ListenTogether] 重置状态");
    stopAutoSync();
    connectionState.value = "idle";
    room.value = null;
    chatMessages.value = [];
    activeProposals.value = [];
    isHost.value = false;
    controllerId.value = null;
    roomId.value = "";
    roomKey.value = "";
    hostToken.value = "";
    memberId.value = "";
    onlineUrls.value = {};
    lastError.value = null;
    lastSeekAt = 0;
    console.log("[ListenTogether] 状态重置完成");
  };

  /** 获取分享链接
   * @returns 分享链接或null
   */
  const getShareLink = async (): Promise<string | null> => {
    if (!roomId.value) {
      console.log("[ListenTogether] 获取分享链接失败, 房间ID为空");
      return null;
    }
    const link = await window.api.listenTogether.getShareLink(roomId.value);
    console.log(`[ListenTogether] 获取分享链接: ${link}`);
    return link;
  };

  /** 踢出成员（仅房主）
   * @param memberId - 成员ID
   * @returns 是否成功
   */
  const kickMember = async (memberId: string): Promise<boolean> => {
    console.log(`[ListenTogether] 踢出成员, memberId=${memberId}, isHost=${isHost.value}`);
    if (!isHost.value || !roomId.value) return false;
    const result = await window.api.listenTogether.kickMember(roomId.value, memberId);
    console.log(`[ListenTogether] 踢出成员结果: ok=${result.ok}`);
    return result.ok;
  };

  /** 拉黑成员（仅房主）
   * @param memberId - 成员ID
   * @returns 是否成功
   */
  const blacklistMember = async (memberId: string): Promise<boolean> => {
    console.log(`[ListenTogether] 拉黑成员, memberId=${memberId}, isHost=${isHost.value}`);
    if (!isHost.value || !roomId.value) return false;
    const result = await window.api.listenTogether.blacklistMember(roomId.value, memberId);
    console.log(`[ListenTogether] 拉黑成员结果: ok=${result.ok}`);
    return result.ok;
  };

  return {
    connectionState,
    room,
    chatMessages,
    activeProposals,
    isHost,
    isConnected,
    memberCount,
    serverUrl,
    serverPort,
    roomId,
    roomKey,
    hostToken,
    nickname,
    controllerId,
    onlineUrls,
    lastError,
    memberId,
    createRoom,
    closeRoom,
    joinRoom,
    leaveRoom,
    sendChat,
    proposeAction,
    vote,
    syncPlayback,
    kickMember,
    blacklistMember,
    getShareLink,
    resetState,
  };
});
