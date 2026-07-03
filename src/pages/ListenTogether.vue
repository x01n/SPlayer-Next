<script setup lang="ts">
import { ref, computed } from "vue";
import { useListenTogetherStore } from "@/stores/listenTogether";
import { useUserStore } from "@/stores/user";
import { useSettingsStore } from "@/stores/settings";
import { toast } from "@/composables/useToast";

const store = useListenTogetherStore();
const userStore = useUserStore();
const settings = useSettingsStore();
const { t } = useI18n();

/** 聊天输入 */
const chatInput = ref("");
const chatContainerRef = ref<HTMLDivElement | null>(null);

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

/** 发送聊天消息 */
const sendChat = (): void => {
  if (!chatInput.value.trim()) return;
  store.sendChat(chatInput.value.trim());
  chatInput.value = "";
  scrollToBottom();
};

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
const parseJoinLink = async (): Promise<{ serverUrl: string; port: number; roomId: string; roomKey: string } | null> => {
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

/** 格式化聊天时间 */
const formatChatTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${dateStr} ${time}`;
};

/** 格式化日期分隔线 */
const formatDateDivider = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return t("listenTogether.page.today") ?? "今天";
  if (diffDays === 1) return t("listenTogether.page.yesterday") ?? "昨天";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
};

/** 判断是否需要显示日期分隔线 */
const showDateDivider = (index: number): boolean => {
  if (index === 0) return true;
  const prev = store.chatMessages[index - 1];
  const curr = store.chatMessages[index];
  const prevDate = new Date(prev.timestamp).toDateString();
  const currDate = new Date(curr.timestamp).toDateString();
  return prevDate !== currDate;
};

/** 获取发送者首字母/头像文本 */
const getAvatarText = (nickname: string): string => nickname?.[0]?.toUpperCase() ?? "?";

/** 获取发送者头像颜色 */
const getAvatarColor = (senderId: string): string => {
  const colors = ["#f55e55", "#5b8ff9", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca", "#ff9d4d"];
  let hash = 0;
  for (let i = 0; i < senderId.length; i++) {
    hash = senderId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

/** 滚动到底部 */
const scrollToBottom = (): void => {
  setTimeout(() => {
    if (chatContainerRef.value) {
      chatContainerRef.value.scrollTo({
        top: chatContainerRef.value.scrollHeight,
        behavior: "smooth",
      });
    }
  }, 50);
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
          :class="store.connectionState === 'connected' ? 'bg-green-500/15 text-green-400 border border-green-500/20' : 'bg-red-500/15 text-red-400 border border-red-500/20'"
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
              {{ showManualJoin ? t("listenTogether.panel.useLink") : t("listenTogether.panel.manualInput") }}
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
      <!-- 左侧：房间信息 + 成员列表 -->
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
              :class="store.connectionState === 'connected' ? 'bg-green-500/15 text-green-400 border border-green-500/20' : 'bg-red-500/15 text-red-400 border border-red-500/20'"
            >
              {{ connectionStatusText }}
            </span>
          </div>

          <div
            v-if="store.room?.currentTrack"
            class="mb-4 p-3 bg-surface-bright/60 rounded-xl border border-outline-variant/10"
          >
            <p class="text-xs text-on-surface-variant/60 mb-1">{{ t("listenTogether.panel.nowPlaying") }}</p>
            <p class="text-sm font-medium truncate">{{ store.room.currentTrack.title }}</p>
            <p class="text-xs text-on-surface-variant/60 truncate">
              {{ store.room.currentTrack.artists?.[0]?.name ?? t("listenTogether.panel.unknownArtist") }}
            </p>
          </div>

          <div class="flex gap-2">
            <SButton v-if="store.isHost" type="primary" size="small" @click="handleCopyLink">
              {{ t("listenTogether.panel.copyLink") }}
            </SButton>
            <SButton
              v-if="store.isHost"
              type="error"
              size="small"
              @click="handleCloseRoom"
            >
              {{ t("listenTogether.panel.closeRoom") }}
            </SButton>
            <SButton v-else size="small" @click="handleLeaveRoom">
              {{ t("listenTogether.panel.leave") }}
            </SButton>
          </div>
        </div>

        <!-- 成员列表 -->
        <div class="bg-surface-panel rounded-2xl p-4 flex-1 min-h-0 overflow-y-auto border border-outline-variant/10 shadow-sm">
          <h3 class="text-sm font-medium mb-3 text-on-surface-variant/80">{{ t("listenTogether.page.members") }}</h3>
          <div class="flex flex-col gap-1">
            <div
              v-for="member in store.room?.members"
              :key="member.id"
              class="flex items-center justify-between p-2 rounded-xl hover:bg-surface-bright/60 transition-colors"
            >
              <div class="flex items-center gap-2.5 min-w-0">
                <div
                  class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium shrink-0"
                  :class="member.id === store.room?.hostId ? 'bg-primary text-white' : 'bg-surface-bright text-on-surface border border-outline-variant/20'"
                  :style="member.id !== store.room?.hostId ? { backgroundColor: getAvatarColor(member.id) + '20', color: getAvatarColor(member.id), borderColor: getAvatarColor(member.id) + '40' } : {}"
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
              <div v-if="store.isHost && member.id !== store.room?.hostId" class="flex gap-1 shrink-0">
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
      <div class="flex-1 bg-surface-panel rounded-2xl flex flex-col min-h-0 border border-outline-variant/10 shadow-sm overflow-hidden">
        <div class="p-4 border-b border-outline-variant/10 flex items-center justify-between">
          <h3 class="text-sm font-medium text-on-surface-variant/80">{{ t("listenTogether.page.chat") }}</h3>
          <span v-if="store.chatMessages.length > 0" class="text-xs text-on-surface-variant/50">
            {{ store.chatMessages.length }} {{ t("listenTogether.page.messages") }}
          </span>
        </div>

        <!-- 聊天消息列表 -->
        <div ref="chatContainerRef" class="flex-1 overflow-y-auto p-4">
          <div v-if="store.chatMessages.length === 0" class="flex flex-col items-center justify-center h-full text-on-surface-variant/40 text-sm gap-2">
            <span class="text-4xl opacity-30">💬</span>
            <span>{{ t("listenTogether.page.noMessages") }}</span>
          </div>

          <div class="flex flex-col gap-1">
            <template v-for="(msg, index) in store.chatMessages" :key="msg.id || index">
              <!-- 日期分隔线 -->
              <div v-if="showDateDivider(index)" class="flex items-center justify-center my-4">
                <div class="flex-1 h-px bg-outline-variant/20" />
                <span class="px-3 text-xs text-on-surface-variant/50">{{ formatDateDivider(msg.timestamp) }}</span>
                <div class="flex-1 h-px bg-outline-variant/20" />
              </div>

              <div
                class="flex gap-3 chat-message"
                :class="msg.senderId === store.memberId ? 'flex-row-reverse' : 'flex-row'"
              >
                <div
                  class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium shrink-0 mt-1"
                  :class="msg.senderId === store.memberId ? 'bg-primary text-white' : 'border'"
                  :style="msg.senderId !== store.memberId ? { backgroundColor: getAvatarColor(msg.senderId) + '15', color: getAvatarColor(msg.senderId), borderColor: getAvatarColor(msg.senderId) + '30' } : {}"
                >
                  {{ getAvatarText(msg.senderNickname) }}
                </div>
                <div
                  class="flex flex-col max-w-[70%] min-w-0"
                  :class="msg.senderId === store.memberId ? 'items-end' : 'items-start'"
                >
                  <div class="flex items-center gap-2 mb-1 px-1">
                    <span class="text-xs font-medium text-on-surface-variant/70">{{ msg.senderNickname }}</span>
                    <span class="text-xs text-on-surface-variant/40">{{ formatChatTime(msg.timestamp) }}</span>
                  </div>
                  <div
                    class="px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap"
                    :class="msg.senderId === store.memberId
                      ? 'bg-primary text-white rounded-2xl rounded-tr-sm shadow-md shadow-primary/20'
                      : 'bg-surface-bright text-on-surface rounded-2xl rounded-tl-sm border border-outline-variant/10 shadow-sm'"
                  >
                    {{ msg.content }}
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- 聊天输入 -->
        <div class="p-4 border-t border-outline-variant/10">
          <div class="flex items-end gap-2 bg-surface-bright/60 rounded-2xl p-1.5 border border-outline-variant/10 focus-within:border-primary/40 focus-within:bg-surface-bright focus-within:shadow-sm transition-all duration-200">
            <SInput
              v-model="chatInput"
              :placeholder="t('listenTogether.page.chatPlaceholder')"
              class="flex-1 bg-transparent border-0 focus-visible:ring-0 focus-visible:ring-offset-0 px-3 py-2"
              @keydown.enter="sendChat"
            />
            <SButton type="primary" class="rounded-xl px-4 shadow-sm" @click="sendChat">
              {{ t("listenTogether.page.send") }}
            </SButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 聊天消息进入动画 */
.chat-message {
  animation: chatMessageIn 0.25s ease-out;
  animation-fill-mode: both;
}

@keyframes chatMessageIn {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* 日期分隔线动画 */
.chat-message:first-child .date-divider,
.chat-message + .chat-message .date-divider {
  animation: fadeIn 0.3s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

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
