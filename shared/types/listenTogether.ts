import type { Track } from "./player";

/** 一起听成员角色 */
export type ListenTogetherRole = "host" | "guest";

/** 一起听成员 */
export interface ListenTogetherMember {
  /** 成员唯一标识 */
  id: string;
  /** 显示昵称 */
  nickname: string;
  /** 角色 */
  role: ListenTogetherRole;
  /** 网易云用户ID（聊天验证用） */
  neteaseUserId?: number;
  /** 加入时间戳 */
  joinedAt: number;
  /** 最后活跃时间戳 */
  lastActiveAt: number;
  /** 是否在线 */
  online: boolean;
  /** 断线时间戳 */
  disconnectedAt?: number;
}

/** 一起听队列项 */
export interface ListenTogetherQueueItem {
  /** 歌曲信息 */
  track: Track;
  /** 添加者ID */
  addedBy: string;
  /** 添加时间戳 */
  addedAt: number;
}

/** 一起听房间状态 */
export type ListenTogetherRoomState = "waiting" | "playing" | "paused" | "closed";

/** 一起听房间 */
export interface ListenTogetherRoom {
  /** 房间ID */
  id: string;
  /** 房间名称 */
  name: string;
  /** 房主ID */
  hostId: string;
  /** 成员列表 */
  members: ListenTogetherMember[];
  /** 黑名单（被拉黑的用户ID列表） */
  blacklist: string[];
  /** 房间状态 */
  state: ListenTogetherRoomState;
  /** 当前播放曲目 */
  currentTrack: Track | null;
  /** 当前播放位置（毫秒） */
  position: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 当前主控成员ID（切歌方） */
  controllerId: string | null;
  /** 加密密钥（用于签名操作） */
  cryptoKey: string;
  /** 房间队列 */
  queue: ListenTogetherQueueItem[];
}

/** 一起听聊天消息 */
export interface ListenTogetherChatMessage {
  /** 消息ID */
  id: string;
  /** 发送者ID */
  senderId: string;
  /** 发送者昵称 */
  senderNickname: string;
  /** 网易云用户ID */
  neteaseUserId?: number;
  /** 头像URL */
  avatarUrl?: string;
  /** 消息内容 */
  content: string;
  /** 发送时间戳 */
  timestamp: number;
  /** 是否已撤回 */
  isRecalled?: boolean;
  /** 撤回时间戳 */
  recalledAt?: number;
  /** 撤回者ID */
  recalledBy?: string;
  /** 引用的消息 */
  replyTo?: {
    /** 被引用消息ID */
    messageId: string;
    /** 被引用发送者昵称 */
    senderNickname: string;
    /** 被引用内容 */
    content: string;
  };
  /** 消息序列号（房间级别递增） */
  seqId?: number;
  /** @的成员ID列表 */
  mentions?: string[];
}

/** 一起听播放同步状态 */
export interface ListenTogetherSyncState {
  /** 曲目 */
  track: Track | null;
  /** 播放位置（毫秒） */
  position: number;
  /** 播放状态 */
  isPlaying: boolean;
  /** 发送时间戳 */
  sendTimestamp: number;
  /** 发送者ID */
  senderId: string;
}

/** 一起听队列操作类型 */
export type ListenTogetherQueueAction = "add" | "remove" | "clear" | "reorder" | "move" | "set";

/** 一起听搜索共享 */
export interface ListenTogetherSearchShare {
  /** 共享ID */
  id: string;
  /** 搜索平台 */
  platform: string;
  /** 搜索关键词 */
  keyword: string;
  /** 搜索结果 */
  results: unknown;
  /** 共享者ID */
  sharedBy: string;
  /** 共享者昵称 */
  sharedByNickname: string;
  /** 共享时间戳 */
  sharedAt: number;
}

/** 一起听表情反应 */
export interface ListenTogetherReaction {
  /** 表情符号 */
  emoji: string;
  /** 发送者ID */
  senderId: string;
  /** 发送者昵称 */
  senderNickname: string;
  /** 发送时间戳 */
  timestamp: number;
}

/** 一起听音源信息 */
export interface ListenTogetherAudioSource {
  /** 成员ID */
  memberId: string;
  /** 成员昵称 */
  memberNickname: string;
  /** 曲目ID */
  trackId: string;
  /** 音源类型：local / online / streaming */
  sourceType: "local" | "online" | "streaming";
  /** 所属平台（在线平台时） */
  platform?: string;
  /** 音质等级：hi-res / lossless / hq / sq / lq */
  quality: string;
  /** 是否有可直接播放的URL（本地文件为false） */
  hasUrl: boolean;
  /** 报告时间戳 */
  reportedAt: number;
}

/** 一起听操作类型 */
export type ListenTogetherActionType =
  | "seek"
  | "play"
  | "pause"
  | "skip"
  | "prev"
  | "volume"
  | "loadTrack"
  | "kick"
  | "blacklist";

/** 一起听操作提案 */
export interface ListenTogetherActionProposal {
  /** 提案ID */
  id: string;
  /** 操作类型 */
  type: ListenTogetherActionType;
  /** 提议者ID */
  proposerId: string;
  /** 操作参数 */
  payload: unknown;
  /** 提议时间戳 */
  proposedAt: number;
  /** 投票结果：成员ID -> 是否同意 */
  votes: Record<string, boolean>;
  /** 投票截止时间戳 */
  voteDeadline: number;
  /** 是否已执行 */
  executed: boolean;
}

/** 一起听配置 */
export interface ListenTogetherSettings {
  /** 总开关 */
  enabled: boolean;
  /** 鉴权密钥（房主设置） */
  authKey: string;
  /** 默认房间名称 */
  defaultRoomName: string;
  /** 同步间隔（毫秒） */
  syncInterval: number;
  /** 投票超时时间（毫秒） */
  voteTimeout: number;
  /** 音乐分片大小（字节） */
  chunkSize: number;
  /** 允许未登录用户聊天 */
  allowAnonymousChat: boolean;
}

/** 一起听服务器配置（加入房间用） */
export interface ListenTogetherServerConfig {
  /** 服务器地址 */
  serverUrl: string;
  /** 鉴权密钥 */
  authKey: string;
  /** 房间ID */
  roomId: string;
  /** 房间密钥 */
  roomKey: string;
}

/** 一起听 WS 消息（客户端 -> 服务端） */
export interface ListenTogetherClientMessage {
  /** 消息类型 */
  op:
    | "join"
    | "leave"
    | "sync"
    | "propose"
    | "vote"
    | "chat"
    | "chunkAck"
    | "heartbeat"
    | "kick"
    | "blacklist"
    | "queue"
    | "searchShare"
    | "reaction"
    | "audioSource"
    | "recall";
  /** 鉴权令牌 */
  token?: string;
  /** 房间ID */
  roomId?: string;
  /** 负载数据 */
  payload?: unknown;
  /** 操作签名（cryptoKey + payload 的 HMAC） */
  signature?: string;
}

/** 一起听 WS 消息（服务端 -> 客户端） */
export interface ListenTogetherServerMessage {
  /** 消息类型 */
  kind:
    | "joined"
    | "memberJoined"
    | "memberLeft"
    | "roomUpdate"
    | "sync"
    | "proposal"
    | "voteUpdate"
    | "executed"
    | "chat"
    | "chunk"
    | "error"
    | "roomClosed"
    | "kicked"
    | "blacklisted"
    | "onlineUrl"
    | "event"
    | "queueUpdate"
    | "searchShared"
    | "reaction"
    | "bestAudioSource"
    | "audioSourceUpdate"
    | "messageRecalled"
    | "chatAck";
  /** 负载数据 */
  data?: unknown;
}

/** 一起听加入请求 */
export interface ListenTogetherJoinRequest {
  /** 昵称 */
  nickname: string;
  /** 网易云用户ID（可选，用于聊天验证） */
  neteaseUserId?: number;
  /** 房间密钥 */
  roomKey: string;
  /** 客户端发送时间戳（用于一次性时间同步） */
  clientTimestamp?: number;
}

/** 一起听加入响应 */
export interface ListenTogetherJoinResponse {
  /** 是否成功 */
  ok: boolean;
  /** 成员令牌 */
  token?: string;
  /** 房间信息 */
  room?: ListenTogetherRoom;
  /** 加密密钥（用于签名操作） */
  cryptoKey?: string;
  /** 错误信息 */
  error?: string;
}
