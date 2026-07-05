<script setup lang="ts">
import type { Track } from "@shared/types/player";
import type { ListenTogetherChatMessage } from "@shared/types/listenTogether";
import { ref, computed } from "vue";
import { useListenTogetherStore } from "@/stores/listenTogether";
import { useUserStore } from "@/stores/user";
import { useSettingsStore } from "@/stores/settings";
import { toast } from "@/composables/useToast";

import { useMediaStore } from "@/stores/media";
import { searchSongs } from "@/apis/search";
import type { Platform } from "@shared/types/platform";

const store = useListenTogetherStore();
const userStore = useUserStore();
const settings = useSettingsStore();
const media = useMediaStore();
const { t } = useI18n();

/** 创建房间表单 */
const showCreateForm = ref(false);
const createNickname = ref(userStore.profile?.nickname || "");
const createRoomName = ref(settings.system.listenTogether.defaultRoomName || "");
const createAuthKey = ref(settings.system.listenTogether.authKey || "");
const creating = ref(false);

/** 加入房间表单 */
const showJoinForm = ref(false);
const joinLink = ref("");
const joinNickname = ref(userStore.profile?.nickname || "");
const joining = ref(false);
const joinServerUrl = ref("127.0.0.1");
const joinPort = ref(14558);
const joinRoomId = ref("");
const joinRoomKey = ref("");
const showManualJoin = ref(false);

/** 创建房间 */
const handleCreateRoom = async (): Promise<void> => {
  if (!createNickname.value.trim()) {
    toast.error(t("listenTogether.panel.nicknameRequired"));
    return;
  }
  const authKey = createAuthKey.value.trim() || settings.system.listenTogether.authKey;
  if (!authKey) {
    toast.error(t("listenTogether.panel.authKeyRequired"));
    return;
  }
  creating.value = true;
  try {
    const success = await store.createRoom(
      createNickname.value.trim(),
      userStore.profile?.userId,
      createRoomName.value.trim() || undefined,
      authKey,
    );
    if (success) {
      toast.success(t("listenTogether.panel.createSuccess"));
      showCreateForm.value = false;
    } else {
      toast.error(t("listenTogether.panel.createFailed"));
    }
  } finally {
    creating.value = false;
  }
};

/** 解析链接（支持base62和query参数格式） */
const parseJoinLink = async (): Promise<{
  serverUrl: string;
  port: number;
  roomId: string;
  roomKey: string;
} | null> => {
  const link = joinLink.value.trim();
  if (!link) return null;
  try {
    const url = new URL(link);
    const serverUrl = url.hostname || "127.0.0.1";
    const port = parseInt(url.port || "14558", 10);

    // 优先尝试 query 参数格式
    const roomId = url.searchParams.get("roomId");
    const roomKey = url.searchParams.get("roomKey");
    if (roomId && roomKey) {
      return { serverUrl, port, roomId, roomKey };
    }

    // 尝试 base62 邀请码格式 /i/xxx
    const pathMatch = url.pathname.match(/\/i\/(.+)/);
    if (pathMatch) {
      const inviteCode = pathMatch[1];
      const decoded = await window.api.listenTogether.decodeInviteCode(inviteCode);
      if (decoded) {
        return { serverUrl, port, roomId: decoded.roomId, roomKey: decoded.roomKey };
      }
    }

    return null;
  } catch {
    return null;
  }
};

/** 加入房间 */
const handleJoinRoom = async (): Promise<void> => {
  if (!joinNickname.value.trim()) {
    toast.error(t("listenTogether.panel.nicknameRequired"));
    return;
  }

  let serverUrl: string;
  let port: number;
  let roomId: string;
  let roomKey: string;

  if (joinLink.value.trim() && !showManualJoin.value) {
    const parsed = await parseJoinLink();
    if (!parsed) {
      toast.error(t("listenTogether.protocol.invalidLink"));
      return;
    }
    serverUrl = parsed.serverUrl;
    port = parsed.port;
    roomId = parsed.roomId;
    roomKey = parsed.roomKey;
  } else {
    if (!joinServerUrl.value.trim() || !joinRoomId.value.trim() || !joinRoomKey.value.trim()) {
      toast.error(t("listenTogether.panel.joinInfoRequired"));
      return;
    }
    serverUrl = joinServerUrl.value.trim();
    port = joinPort.value;
    roomId = joinRoomId.value.trim();
    roomKey = joinRoomKey.value.trim();
  }

  joining.value = true;
  try {
    const success = await store.joinRoom(
      serverUrl,
      port,
      roomId,
      roomKey,
      joinNickname.value.trim(),
      userStore.profile?.userId,
    );
    if (success) {
      toast.success(t("listenTogether.protocol.joinSuccess"));
      showJoinForm.value = false;
      joinLink.value = "";
    } else {
      toast.error(t("listenTogether.protocol.joinFailed"));
    }
  } finally {
    joining.value = false;
  }
};

/** 离开房间 */
const handleLeaveRoom = (): void => {
  store.leaveRoom();
  toast.info(t("listenTogether.panel.left"));
};

/** 关闭房间（房主） */
const handleCloseRoom = async (): Promise<void> => {
  await store.closeRoom();
  toast.info(t("listenTogether.panel.closed"));
};

/** 复制分享链接 */
const handleCopyLink = async (): Promise<void> => {
  const link = await store.getShareLink();
  if (link) {
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t("common.copyFailed"));
    }
  }
};

/** 踢出成员 */
const handleKick = async (memberId: string): Promise<void> => {
  const success = await store.kickMember(memberId);
  if (success) {
    toast.success(t("listenTogether.room.kickSuccess"));
  } else {
    toast.error(t("listenTogether.room.kickFailed"));
  }
};

/** 拉黑成员 */
const handleBlacklist = async (memberId: string): Promise<void> => {
  const success = await store.blacklistMember(memberId);
  if (success) {
    toast.success(t("listenTogether.room.blacklistSuccess"));
  } else {
    toast.error(t("listenTogether.room.blacklistFailed"));
  }
};

/** 连接状态文本 */
const connectionStatusText = computed(() => {
  switch (store.connectionState) {
    case "connecting":
      return t("listenTogether.panel.status.connecting");
    case "connected":
      return t("listenTogether.panel.status.connected");
    case "disconnected":
      return t("listenTogether.panel.status.disconnected");
    case "error":
      return t("listenTogether.panel.status.error");
    default:
      return "";
  }
});

/** 获取发送者头像颜色 */
const getAvatarColor = (senderId: string): string => {
  const colors = [
    "#f55e55",
    "#5b8ff9",
    "#5ad8a6",
    "#f6bd16",
    "#e8684a",
    "#6dc8ec",
    "#9270ca",
    "#ff9d4d",
  ];
  let hash = 0;
  for (let i = 0; i < senderId.length; i++) {
    hash = senderId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

/** 处理聊天发送 */
const handleChatSend = (
  content: string,
  replyTo?: ListenTogetherChatMessage["replyTo"],
  mentions?: string[],
): void => {
  store.sendChat(content, replyTo, mentions);
};

/** 处理聊天撤回 */
const handleChatRecall = async (messageId: string): Promise<void> => {
  await store.recallMessage(messageId);
};

/** 点歌弹窗 */
const showAddSong = ref(false);
const addSongKeyword = ref("");
const searchResults = ref<Track[]>([]);
const searching = ref(false);

/** 添加当前播放歌曲到队列 */
const handleAddCurrentSong = async (): Promise<void> => {
  const track = media.track;
  if (!track) {
    toast.error(t("listenTogether.page.noPlayingTrack") ?? "当前没有播放歌曲");
    return;
  }
  await store.sendQueueAction("add", { track });
  toast.success(t("listenTogether.page.songAdded") ?? "已添加歌曲");
  showAddSong.value = false;
};

const searchPlatform = ref<Platform>("netease");

/** 搜索歌曲 */
const handleSearchSong = async (): Promise<void> => {
  const keyword = addSongKeyword.value.trim();
  if (!keyword) return;
  searching.value = true;
  try {
    const result = await searchSongs(searchPlatform.value, keyword, 0, 10);
    searchResults.value = result.items.slice(0, 10);
  } catch (err) {
    console.error("[ListenTogether] 搜索失败:", err);
    toast.error(t("common.searchFailed") ?? "搜索失败");
  } finally {
    searching.value = false;
  }
};

/** 添加搜索到的歌曲到队列 */
const handleAddSearchSong = async (track: Track): Promise<void> => {
  await store.sendQueueAction("add", { track });
  toast.success(t("listenTogether.page.songAdded") ?? "已添加歌曲");
  showAddSong.value = false;
  addSongKeyword.value = "";
  searchResults.value = [];
};

/** 移除队列中的歌曲 */
const handleRemoveSong = async (index: number): Promise<void> => {
  await store.sendQueueAction("remove", { index });
};
</script>

<template>
  <div class="h-full flex flex-col p-6">
    <!-- 页面标题 -->
    <div class="flex items-center justify-between mb-5">
      <h1 class="text-2xl font-semibold">{{ t("listenTogether.page.title") }}</h1>
      <div v-if="store.isConnected" class="flex items-center gap-2">
        <span
          class="px-2.5 py-1 rounded-full text-xs font-medium"
          :class="
            store.connectionState === 'connected'
              ? 'bg-green-500/15 text-green-400 border border-green-500/20'
              : 'bg-red-500/15 text-red-400 border border-red-500/20'
          "
        >
          {{ connectionStatusText }}
        </span>
      </div>
    </div>

    <!-- 未连接状态 -->
    <div v-if="!store.isConnected" class="flex-1 flex flex-col items-center justify-center gap-6">
      <div class="text-on-surface-variant/60 text-center">
        <p class="text-lg mb-2">{{ t("listenTogether.page.subtitle") }}</p>
        <p class="text-sm">{{ t("listenTogether.page.hint") }}</p>
      </div>

      <div class="flex gap-4">
        <SButton type="primary" @click="showCreateForm = true">
          {{ t("listenTogether.panel.createRoom") }}
        </SButton>
        <SButton @click="showJoinForm = true">
          {{ t("listenTogether.panel.joinRoom") }}
        </SButton>
      </div>

      <!-- 创建房间弹窗 -->
      <SDialog v-model:open="showCreateForm" :title="t('listenTogether.panel.createRoom')">
        <div class="flex flex-col gap-4 w-80">
          <SInput
            v-model="createNickname"
            :placeholder="t('listenTogether.panel.nicknamePlaceholder')"
          />
          <SInput
            v-model="createRoomName"
            :placeholder="t('listenTogether.panel.roomNamePlaceholder')"
          />
          <SInput
            v-model="createAuthKey"
            type="password"
            :placeholder="t('listenTogether.panel.authKeyPlaceholder')"
          />
          <SButton type="primary" :loading="creating" class="w-full" @click="handleCreateRoom">
            {{ t("listenTogether.panel.confirmCreate") }}
          </SButton>
        </div>
      </SDialog>

      <!-- 加入房间弹窗 -->
      <SDialog v-model:open="showJoinForm" :title="t('listenTogether.panel.joinRoom')">
        <div class="flex flex-col gap-4 w-80">
          <SInput
            v-model="joinNickname"
            :placeholder="t('listenTogether.panel.nicknamePlaceholder')"
          />
          <SInput
            v-if="!showManualJoin"
            v-model="joinLink"
            :placeholder="t('listenTogether.panel.linkPlaceholder')"
          />
          <template v-else>
            <SInput
              v-model="joinServerUrl"
              :placeholder="t('listenTogether.panel.serverUrlPlaceholder')"
            />
            <SInput
              v-model="joinRoomId"
              :placeholder="t('listenTogether.panel.roomIdPlaceholder')"
            />
            <SInput
              v-model="joinRoomKey"
              :placeholder="t('listenTogether.panel.roomKeyPlaceholder')"
            />
          </template>
          <div class="text-center">
            <span
              class="text-xs text-primary cursor-pointer hover:underline"
              @click="showManualJoin = !showManualJoin"
            >
              {{
                showManualJoin
                  ? t("listenTogether.panel.useLink")
                  : t("listenTogether.panel.manualInput")
              }}
            </span>
          </div>
          <SButton type="primary" :loading="joining" class="w-full" @click="handleJoinRoom">
            {{ t("listenTogether.panel.confirmJoin") }}
          </SButton>
        </div>
      </SDialog>
    </div>

    <!-- 已连接状态 -->
    <div v-else class="flex-1 flex gap-5 min-h-0">
      <!-- 左侧：房间信息 + 播放队列 + 成员列表 -->
      <div class="w-64 flex flex-col gap-4 shrink-0">
        <!-- 房间信息卡片 -->
        <div class="bg-surface-panel rounded-2xl p-4 border border-outline-variant/10 shadow-sm">
          <div class="flex items-start justify-between gap-2 mb-3">
            <div class="min-w-0">
              <h2 class="font-semibold text-base truncate">{{ store.room?.name }}</h2>
              <p class="text-xs text-on-surface-variant/60 mt-0.5">
                {{ t("listenTogether.panel.members", { count: store.memberCount }) }}
              </p>
            </div>
            <span
              class="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium"
              :class="
                store.connectionState === 'connected'
                  ? 'bg-green-500/15 text-green-400 border border-green-500/20'
                  : 'bg-red-500/15 text-red-400 border border-red-500/20'
              "
            >
              {{ connectionStatusText }}
            </span>
          </div>

          <div
            v-if="store.room?.currentTrack"
            class="mb-4 p-3 bg-surface-bright/60 rounded-xl border border-outline-variant/10"
          >
            <p class="text-xs text-on-surface-variant/60 mb-1">
              {{ t("listenTogether.panel.nowPlaying") }}
            </p>
            <p class="text-sm font-medium truncate">{{ store.room.currentTrack.title }}</p>
            <p class="text-xs text-on-surface-variant/60 truncate">
              {{
                store.room.currentTrack.artists?.[0]?.name ??
                t("listenTogether.panel.unknownArtist")
              }}
            </p>
          </div>

          <div class="flex gap-2">
            <SButton v-if="store.isHost" type="primary" size="small" @click="handleCopyLink">
              {{ t("listenTogether.panel.copyLink") }}
            </SButton>
            <SButton v-if="store.isHost" type="error" size="small" @click="handleCloseRoom">
              {{ t("listenTogether.panel.closeRoom") }}
            </SButton>
            <SButton v-else size="small" @click="handleLeaveRoom">
              {{ t("listenTogether.panel.leave") }}
            </SButton>
          </div>
        </div>

        <!-- 播放队列 -->
        <div
          class="bg-surface-panel rounded-2xl p-4 shrink-0 border border-outline-variant/10 shadow-sm max-h-60 flex flex-col"
        >
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-medium text-on-surface-variant/80">
              {{ t("listenTogether.page.queue") }}
            </h3>
            <SButton variant="tertiary" size="small" @click="showAddSong = true">
              {{ t("listenTogether.page.addSong") }}
            </SButton>
          </div>
          <div class="flex-1 overflow-y-auto min-h-0">
            <div
              v-if="store.queue.length === 0"
              class="text-xs text-on-surface-variant/40 text-center py-4"
            >
              {{ t("listenTogether.page.emptyQueue") }}
            </div>
            <div v-else class="flex flex-col gap-1">
              <div
                v-for="(item, index) in store.queue"
                :key="item.track.id + index"
                class="flex items-center gap-2 p-2 rounded-xl hover:bg-surface-bright/60 transition-colors group"
              >
                <span class="text-xs text-on-surface-variant/40 w-5 text-center shrink-0">
                  {{ index + 1 }}
                </span>
                <div class="min-w-0 flex-1">
                  <p class="text-sm truncate">{{ item.track.title }}</p>
                  <p class="text-xs text-on-surface-variant/50 truncate">
                    {{
                      item.track.artists?.map((a) => a.name).join(", ") ??
                      t("listenTogether.panel.unknownArtist")
                    }}
                  </p>
                </div>
                <button
                  v-if="store.isHost"
                  class="opacity-0 group-hover:opacity-100 text-on-surface-variant/40 hover:text-red-400 transition-opacity shrink-0"
                  @click="handleRemoveSong(index)"
                >
                  <IconLucideX class="size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 成员列表 -->
        <div
          class="bg-surface-panel rounded-2xl p-4 flex-1 min-h-0 overflow-y-auto border border-outline-variant/10 shadow-sm"
        >
          <h3 class="text-sm font-medium mb-3 text-on-surface-variant/80">
            {{ t("listenTogether.page.members") }}
          </h3>
          <div class="flex flex-col gap-1">
            <div
              v-for="member in store.room?.members"
              :key="member.id"
              class="flex items-center justify-between p-2 rounded-xl hover:bg-surface-bright/60 transition-colors"
            >
              <div class="flex items-center gap-2.5 min-w-0">
                <div
                  class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium shrink-0"
                  :class="
                    member.id === store.room?.hostId
                      ? 'bg-primary text-white'
                      : 'bg-surface-bright text-on-surface border border-outline-variant/20'
                  "
                  :style="
                    member.id !== store.room?.hostId
                      ? {
                          backgroundColor: getAvatarColor(member.id) + '20',
                          color: getAvatarColor(member.id),
                          borderColor: getAvatarColor(member.id) + '40',
                        }
                      : {}
                  "
                >
                  {{ member.nickname?.[0] ?? "?" }}
                </div>
                <div class="min-w-0">
                  <p class="text-sm truncate">{{ member.nickname }}</p>
                  <p v-if="member.id === store.room?.hostId" class="text-xs text-primary">
                    {{ t("listenTogether.page.host") }}
                  </p>
                </div>
              </div>
              <div
                v-if="store.isHost && member.id !== store.room?.hostId"
                class="flex gap-1 shrink-0"
              >
                <SButton variant="tertiary" size="small" @click="handleKick(member.id)">
                  {{ t("listenTogether.page.kick") }}
                </SButton>
                <SButton variant="tertiary" size="small" @click="handleBlacklist(member.id)">
                  {{ t("listenTogether.page.blacklist") }}
                </SButton>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧：聊天室 -->
      <ChatRoom
        :messages="store.chatMessages"
        :current-member-id="store.memberId"
        :members="store.room?.members ?? []"
        @send="handleChatSend"
        @recall="handleChatRecall"
      />

      <!-- 点歌弹窗 -->
      <SDialog v-model:open="showAddSong" :title="t('listenTogether.page.addSong')">
        <div class="flex flex-col gap-4 w-96">
          <SButton v-if="media.track" type="primary" class="w-full" @click="handleAddCurrentSong">
            {{ t("listenTogether.page.addCurrentSong") }}: {{ media.track.title }}
          </SButton>

          <div class="flex items-center gap-2">
            <div class="flex-1 h-px bg-outline-variant/20" />
            <span class="text-xs text-on-surface-variant/40">{{ t("common.or") ?? "或" }}</span>
            <div class="flex-1 h-px bg-outline-variant/20" />
          </div>

          <div class="flex gap-2">
            <SInput
              v-model="addSongKeyword"
              :placeholder="t('listenTogether.page.searchSongPlaceholder') ?? '搜索歌曲'"
              class="flex-1"
              @keydown.enter="handleSearchSong"
            />
            <SButton :loading="searching" @click="handleSearchSong">
              {{ t("common.search") ?? "搜索" }}
            </SButton>
          </div>

          <div v-if="searchResults.length > 0" class="flex flex-col gap-1 max-h-60 overflow-y-auto">
            <div
              v-for="track in searchResults"
              :key="track.id"
              class="flex items-center gap-2 p-2 rounded-xl hover:bg-surface-bright/60 cursor-pointer transition-colors"
              @click="handleAddSearchSong(track)"
            >
              <div class="min-w-0 flex-1">
                <p class="text-sm truncate">{{ track.title }}</p>
                <p class="text-xs text-on-surface-variant/50 truncate">
                  {{
                    track.artists?.map((a) => a.name).join(", ") ??
                    t("listenTogether.panel.unknownArtist")
                  }}
                </p>
              </div>
              <SButton type="primary" size="small">
                {{ t("common.add") ?? "添加" }}
              </SButton>
            </div>
          </div>
        </div>
      </SDialog>
    </div>
  </div>
</template>

<style scoped>
/* 滚动条样式优化 */
.overflow-y-auto::-webkit-scrollbar {
  width: 4px;
}
.overflow-y-auto::-webkit-scrollbar-track {
  background: transparent;
}
.overflow-y-auto::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
}
.overflow-y-auto::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.2);
}
</style>
