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

/** 是否显示面板 */
const isVisible = computed(
  () => store.isConnected || store.connectionState === "connecting" || store.connectionState === "idle",
);

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

/** 创建房间表单 */
const showCreateForm = ref(false);
const createNickname = ref(userStore.profile?.nickname || "");
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

/** 展开手动输入 */
const showManualJoin = ref(false);

/** 创建房间 */
const handleCreateRoom = async (): Promise<void> => {
  if (!createNickname.value.trim()) {
    toast.error(t("listenTogether.panel.nicknameRequired"));
    return;
  }
  const authKey = settings.system.listenTogether.authKey;
  if (!authKey) {
    toast.error(t("listenTogether.panel.authKeyRequired"));
    return;
  }
  creating.value = true;
  try {
    const roomName = settings.system.listenTogether.defaultRoomName || "一起听房间";
    const success = await store.createRoom(roomName, userStore.profile?.userId);
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

/** 解析链接 */
const parseJoinLink = (): { serverUrl: string; port: number; roomId: string; roomKey: string } | null => {
  const link = joinLink.value.trim();
  if (!link) return null;
  try {
    const url = new URL(link);
    const serverUrl = url.hostname || "127.0.0.1";
    const port = parseInt(url.port || "14558", 10);
    const roomId = url.searchParams.get("roomId");
    const roomKey = url.searchParams.get("roomKey");
    if (!roomId || !roomKey) {
      // 尝试 base62 格式 splayer-listentogether://host:port/i/xxx
      const pathMatch = url.pathname.match(/\/i\/(.+)/);
      if (pathMatch) {
        // base62 解码需要服务端支持，这里先不支持直接解析
        return null;
      }
      return null;
    }
    return { serverUrl, port, roomId, roomKey };
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
    const parsed = parseJoinLink();
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
</script>

<template>
  <div v-if="isVisible" class="listen-together-panel">
    <!-- 未连接：功能入口 -->
    <template v-if="!store.isConnected">
      <div class="lt-header">
        <span class="lt-title">{{ t("listenTogether.panel.title") }}</span>
      </div>

      <div class="lt-actions">
        <button class="lt-btn lt-btn-primary" @click="showCreateForm = !showCreateForm">
          {{ t("listenTogether.panel.createRoom") }}
        </button>
        <button class="lt-btn lt-btn-secondary" @click="showJoinForm = !showJoinForm">
          {{ t("listenTogether.panel.joinRoom") }}
        </button>
      </div>

      <!-- 创建房间表单 -->
      <div v-if="showCreateForm" class="lt-form">
        <SInput
          v-model="createNickname"
          :placeholder="t('listenTogether.panel.nicknamePlaceholder')"
          class="lt-input"
        />
        <SButton
          type="primary"
          size="small"
          :loading="creating"
          class="w-full"
          @click="handleCreateRoom"
        >
          {{ t("listenTogether.panel.confirmCreate") }}
        </SButton>
      </div>

      <!-- 加入房间表单 -->
      <div v-if="showJoinForm" class="lt-form">
        <SInput
          v-model="joinNickname"
          :placeholder="t('listenTogether.panel.nicknamePlaceholder')"
          class="lt-input"
        />
        <SInput
          v-if="!showManualJoin"
          v-model="joinLink"
          :placeholder="t('listenTogether.panel.linkPlaceholder')"
          class="lt-input"
        />
        <template v-else>
          <SInput
            v-model="joinServerUrl"
            :placeholder="t('listenTogether.panel.serverUrlPlaceholder')"
            class="lt-input"
          />
          <SInput
            v-model="joinRoomId"
            :placeholder="t('listenTogether.panel.roomIdPlaceholder')"
            class="lt-input"
          />
          <SInput
            v-model="joinRoomKey"
            :placeholder="t('listenTogether.panel.roomKeyPlaceholder')"
            class="lt-input"
          />
        </template>
        <div class="lt-toggle-manual">
          <span class="lt-link" @click="showManualJoin = !showManualJoin">
            {{ showManualJoin ? t("listenTogether.panel.useLink") : t("listenTogether.panel.manualInput") }}
          </span>
        </div>
        <SButton
          type="primary"
          size="small"
          :loading="joining"
          class="w-full"
          @click="handleJoinRoom"
        >
          {{ t("listenTogether.panel.confirmJoin") }}
        </SButton>
      </div>
    </template>

    <!-- 已连接：房间信息 -->
    <template v-else>
      <div class="lt-header">
        <span class="lt-title">{{ t("listenTogether.panel.title") }}</span>
        <span class="lt-status" :class="store.connectionState">{{ connectionStatusText }}</span>
        <button class="lt-close" @click="handleLeaveRoom">{{ t("listenTogether.panel.leave") }}</button>
      </div>

      <div v-if="store.room" class="lt-body">
        <div class="lt-room-info">
          <span class="lt-room-name">{{ store.room.name }}</span>
          <span class="lt-member-count">
            {{ t("listenTogether.panel.members", { count: store.memberCount }) }}
          </span>
        </div>

        <div v-if="store.room.currentTrack" class="lt-track">
          <span class="lt-track-name">{{ store.room.currentTrack.title }}</span>
          <span class="lt-track-artist">
            {{ store.room.currentTrack.artists?.[0]?.name ?? t("listenTogether.panel.unknownArtist") }}
          </span>
        </div>

        <!-- 房主操作 -->
        <div v-if="store.isHost" class="lt-host-actions">
          <button class="lt-btn lt-btn-small" @click="handleCopyLink">
            {{ t("listenTogether.panel.copyLink") }}
          </button>
          <button class="lt-btn lt-btn-small lt-btn-danger" @click="handleCloseRoom">
            {{ t("listenTogether.panel.closeRoom") }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.listen-together-panel {
  position: fixed;
  bottom: 80px;
  right: 16px;
  width: 280px;
  background: rgba(30, 30, 30, 0.95);
  border-radius: 12px;
  padding: 12px 16px;
  color: #fff;
  font-size: 13px;
  z-index: 1000;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

.lt-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.lt-title {
  font-weight: 600;
  font-size: 14px;
}

.lt-status {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
}

.lt-status.connected {
  background: rgba(34, 197, 94, 0.2);
  color: #4ade80;
}

.lt-status.error {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.lt-close {
  margin-left: auto;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  color: #fff;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}

.lt-close:hover {
  background: rgba(255, 255, 255, 0.2);
}

.lt-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.lt-btn {
  flex: 1;
  padding: 6px 0;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: opacity 0.2s;
}

.lt-btn:hover {
  opacity: 0.85;
}

.lt-btn-primary {
  background: #3b82f6;
  color: #fff;
}

.lt-btn-secondary {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.lt-btn-small {
  padding: 4px 10px;
  font-size: 11px;
}

.lt-btn-danger {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.lt-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.lt-input {
  --tw-bg-opacity: 0.06;
}

.lt-input :deep(input) {
  color: #fff;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  width: 100%;
  outline: none;
}

.lt-input :deep(input::placeholder) {
  color: rgba(255, 255, 255, 0.35);
}

.lt-toggle-manual {
  text-align: center;
}

.lt-link {
  color: #60a5fa;
  font-size: 11px;
  cursor: pointer;
}

.lt-link:hover {
  text-decoration: underline;
}

.lt-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lt-room-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.lt-room-name {
  font-weight: 500;
}

.lt-member-count {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}

.lt-track {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
}

.lt-track-name {
  font-size: 12px;
  font-weight: 500;
}

.lt-track-artist {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}

.lt-host-actions {
  display: flex;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
</style>
