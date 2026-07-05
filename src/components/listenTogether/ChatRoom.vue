<script setup lang="ts">
import { ref, computed, nextTick, watch } from "vue";
import type { ListenTogetherChatMessage, ListenTogetherMember } from "@shared/types/listenTogether";
import { toast } from "@/composables/useToast";
import IconLucideTextQuote from "~icons/lucide/text-quote";
import IconLucideRotateCcw from "~icons/lucide/rotate-ccw";
import IconLucideX from "~icons/lucide/x";

const props = defineProps<{
  messages: ListenTogetherChatMessage[];
  currentMemberId: string;
  members: ListenTogetherMember[];
  avatarWhitelist?: string[];
}>();

const emit = defineEmits<{
  send: [content: string, replyTo?: ListenTogetherChatMessage["replyTo"], mentions?: string[]];
  recall: [messageId: string];
}>();

const { t } = useI18n();

/** 聊天输入 */
const chatInput = ref("");
const chatContainerRef = ref<HTMLDivElement | null>(null);

/** 引用中的消息 */
const replyingTo = ref<ListenTogetherChatMessage["replyTo"] | null>(null);

/** @ 提及下拉 */
const showMentionDropdown = ref(false);
const mentionQuery = ref("");
const mentionIndex = ref(0);
const mentionAnchor = ref<{ top: number; left: number }>({ top: 0, left: 0 });

/** 消息内容最大长度 */
const MAX_MESSAGE_LENGTH = 10000;

/** 头像最大尺寸 */
const MAX_AVATAR_SIZE = 64;

/** 信任的头像域名白名单 */
const DEFAULT_AVATAR_WHITELIST = [
  "avatars.githubusercontent.com",
  "gravatar.com",
  "cdn.discordapp.com",
  "secure.gravatar.com",
  "lh3.googleusercontent.com",
  "graph.facebook.com",
  "p.qpic.cn",
  "thirdqq.qlogo.cn",
];

const avatarWhitelist = computed(() => [
  ...DEFAULT_AVATAR_WHITELIST,
  ...(props.avatarWhitelist ?? []),
]);

/** 验证头像 URL 是否可信 */
const isTrustedAvatarUrl = (url?: string): boolean => {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return avatarWhitelist.value.some((w) => hostname === w || hostname.endsWith(`.${w}`));
  } catch {
    return false;
  }
};

/** 获取发送者首字母 */
const getAvatarText = (nickname: string): string => nickname?.[0]?.toUpperCase() ?? "?";

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
  const prev = props.messages[index - 1];
  const curr = props.messages[index];
  const prevDate = new Date(prev.timestamp).toDateString();
  const currDate = new Date(curr.timestamp).toDateString();
  return prevDate !== currDate;
};

/** 判断消息是否可撤回（5分钟内且是自己发的） */
const canRecall = (msg: ListenTogetherChatMessage): boolean => {
  if (msg.senderId !== props.currentMemberId) return false;
  if (msg.isRecalled) return false;
  return Date.now() - msg.timestamp < 5 * 60 * 1000;
};

/**
 * 检查消息是否 @ 或引用了当前用户
 * @param msg - 聊天消息
 * @returns 是否被 @ 或引用
 */
const isAtMe = (msg: ListenTogetherChatMessage): boolean => {
  if (msg.senderId === props.currentMemberId) return false;
  if (msg.mentions?.includes(props.currentMemberId)) return true;
  if (msg.replyTo) {
    const repliedMsg = props.messages.find((m) => m.id === msg.replyTo?.messageId);
    if (repliedMsg?.senderId === props.currentMemberId) return true;
  }
  return false;
};

/** 监听新消息，检查 @ 和引用提醒 */
watch(
  () => props.messages.length,
  (newLen, oldLen) => {
    if (newLen <= (oldLen ?? 0)) return;
    const newMsg = props.messages[newLen - 1];
    if (isAtMe(newMsg)) {
      toast.info(
        `${newMsg.senderNickname} ${t("listenTogether.page.chat.mentionedYou") ?? "提到了你"}`,
      );
    }
  },
);

/** 截断过长的消息内容（超过1w字显示省略） */
const truncateContent = (content: string): string => {
  if (content.length <= MAX_MESSAGE_LENGTH) return content;
  return (
    content.slice(0, MAX_MESSAGE_LENGTH) +
    `\n[${t("listenTogether.page.chat.truncated") ?? "消息过长，已截断"}]`
  );
};

/** 解析消息中的 @ 提及 */
const parseMentions = (content: string): string[] => {
  const mentions: string[] = [];
  const regex = /@([^\s]+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const member = props.members.find((m) => m.nickname === name);
    if (member) mentions.push(member.id);
  }
  return mentions;
};

/** 发送消息 */
const handleSend = (): void => {
  const content = chatInput.value.trim();
  if (!content) return;
  if (content.length > MAX_MESSAGE_LENGTH) {
    chatInput.value = content.slice(0, MAX_MESSAGE_LENGTH);
    return;
  }
  const mentions = parseMentions(content);
  emit("send", content, replyingTo.value ?? undefined, mentions.length > 0 ? mentions : undefined);
  chatInput.value = "";
  replyingTo.value = null;
  scrollToBottom();
};

/** 撤回消息 */
const handleRecall = (messageId: string): void => {
  emit("recall", messageId);
};

/** 设置引用 */
const handleReply = (msg: ListenTogetherChatMessage): void => {
  replyingTo.value = {
    messageId: msg.id,
    senderNickname: msg.senderNickname,
    content: msg.content.slice(0, 100),
  };
};

/** 取消引用 */
const cancelReply = (): void => {
  replyingTo.value = null;
};

/** @ 提及候选 */
const mentionCandidates = computed(() => {
  if (!mentionQuery.value) return props.members;
  const q = mentionQuery.value.toLowerCase();
  return props.members.filter((m) => m.nickname.toLowerCase().includes(q));
});

/** 输入框处理 */
const handleInput = (e: Event): void => {
  const target = e.target as HTMLInputElement;
  const val = target.value;
  const cursorPos = target.selectionStart ?? val.length;

  // 检查是否在输入 @
  const beforeCursor = val.slice(0, cursorPos);
  const atMatch = beforeCursor.match(/@([^\s]*)$/);
  if (atMatch) {
    mentionQuery.value = atMatch[1];
    showMentionDropdown.value = true;
    mentionIndex.value = 0;
    // 计算下拉菜单位置
    const rect = target.getBoundingClientRect();
    mentionAnchor.value = { top: rect.top - 200, left: rect.left };
  } else {
    showMentionDropdown.value = false;
  }
};

/** 选择 @ 提及成员 */
const selectMention = (member: ListenTogetherMember): void => {
  const val = chatInput.value;
  const cursorPos = (document.activeElement as HTMLInputElement)?.selectionStart ?? val.length;
  const beforeCursor = val.slice(0, cursorPos);
  const afterCursor = val.slice(cursorPos);
  const atMatch = beforeCursor.match(/@([^\s]*)$/);
  if (atMatch) {
    const prefix = beforeCursor.slice(0, -atMatch[0].length);
    chatInput.value = `${prefix}@${member.nickname} ${afterCursor}`;
  }
  showMentionDropdown.value = false;
  nextTick(() => {
    const input = document.querySelector(".chat-input-field") as HTMLInputElement;
    if (input) input.focus();
  });
};

/** 键盘导航 @ 下拉 */
const handleKeydown = (e: KeyboardEvent): void => {
  if (!showMentionDropdown.value) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    mentionIndex.value = (mentionIndex.value + 1) % mentionCandidates.value.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    mentionIndex.value =
      (mentionIndex.value - 1 + mentionCandidates.value.length) % mentionCandidates.value.length;
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    const candidate = mentionCandidates.value[mentionIndex.value];
    if (candidate) selectMention(candidate);
  } else if (e.key === "Escape") {
    showMentionDropdown.value = false;
  }
};

/** 头像加载失败处理 */
const handleImgError = (e: Event): void => {
  const target = e.target as HTMLElement;
  if (target) target.style.display = "none";
};

/** 滚动到底部 */
const scrollToBottom = (): void => {
  nextTick(() => {
    if (chatContainerRef.value) {
      chatContainerRef.value.scrollTo({
        top: chatContainerRef.value.scrollHeight,
        behavior: "smooth",
      });
    }
  });
};

/** 消息变化时自动滚动 */
watch(() => props.messages.length, scrollToBottom);
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 聊天消息列表 -->
    <div ref="chatContainerRef" class="flex-1 overflow-y-auto p-4">
      <div
        v-if="messages.length === 0"
        class="flex flex-col items-center justify-center h-full text-on-surface-variant/40 text-sm gap-2"
      >
        <span class="text-4xl opacity-30">💬</span>
        <span>{{ t("listenTogether.page.noMessages") }}</span>
      </div>

      <div class="flex flex-col gap-2">
        <template v-for="(msg, index) in messages" :key="msg.id || index">
          <!-- 日期分隔线 -->
          <div v-if="showDateDivider(index)" class="flex items-center justify-center my-4">
            <div class="flex-1 h-px bg-outline-variant/20" />
            <span class="px-3 text-xs text-on-surface-variant/50">
              {{ formatDateDivider(msg.timestamp) }}
            </span>
            <div class="flex-1 h-px bg-outline-variant/20" />
          </div>

          <!-- 撤回消息：替换为系统提示，不显示原内容 -->
          <div v-if="msg.isRecalled" class="flex justify-center my-2">
            <span
              class="text-xs text-on-surface-variant/50 italic px-3 py-1 rounded-full bg-surface-bright/30"
            >
              {{ msg.senderNickname }}
              {{ t("listenTogether.page.chat.recalled") ?? "撤回了一条消息" }}
            </span>
          </div>

          <SContextMenu
            v-else
            :items="[
              {
                key: 'reply',
                label: t('listenTogether.page.chat.reply') ?? '引用',
                icon: IconLucideTextQuote,
                show: true,
              },
              {
                key: 'recall',
                label: t('listenTogether.page.chat.recall') ?? '撤回',
                icon: IconLucideRotateCcw,
                show: canRecall(msg),
              },
            ]"
            @select="
              (key) =>
                key === 'reply' ? handleReply(msg) : key === 'recall' ? handleRecall(msg.id) : null
            "
          >
            <!-- 消息行：自己=头像在右 别人=头像在左 -->
            <div
              class="flex gap-2 px-1 py-0.5 rounded-xl hover:bg-surface-bright/30 transition-colors chat-message"
              :class="[
                msg.senderId === currentMemberId ? 'flex-row-reverse' : 'flex-row',
                isAtMe(msg) ? 'ring-1 ring-primary/30 bg-primary/5' : '',
              ]"
            >
              <!-- 头像 -->
              <div class="shrink-0 mt-0.5">
                <img
                  v-if="msg.avatarUrl && isTrustedAvatarUrl(msg.avatarUrl)"
                  :src="msg.avatarUrl"
                  :alt="msg.senderNickname"
                  class="rounded-full object-cover"
                  :width="MAX_AVATAR_SIZE"
                  :height="MAX_AVATAR_SIZE"
                  style="width: 32px; height: 32px"
                  loading="lazy"
                  decoding="async"
                  @error="handleImgError"
                />
                <div
                  v-else
                  class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium"
                  :style="{
                    backgroundColor: getAvatarColor(msg.senderId) + '20',
                    color: getAvatarColor(msg.senderId),
                    border: `1px solid ${getAvatarColor(msg.senderId)}40`,
                  }"
                >
                  {{ getAvatarText(msg.senderNickname) }}
                </div>
              </div>

              <!-- 消息体 -->
              <div
                class="flex flex-col max-w-[70%] min-w-0"
                :class="msg.senderId === currentMemberId ? 'items-end' : 'items-start'"
              >
                <!-- 发送者信息 -->
                <div
                  class="flex items-center gap-1.5 mb-0.5 px-1"
                  :class="msg.senderId === currentMemberId ? 'flex-row-reverse' : 'flex-row'"
                >
                  <span class="text-xs font-medium text-on-surface-variant/70">
                    {{ msg.senderNickname }}
                  </span>
                  <span class="text-xs text-on-surface-variant/40">
                    {{ formatChatTime(msg.timestamp) }}
                  </span>
                </div>

                <!-- @ 提及提示标签（当消息 @ 了当前用户时显示） -->
                <div
                  v-if="msg.mentions?.includes(currentMemberId)"
                  class="mb-0.5 px-1.5 py-px text-[10px] rounded-full bg-primary/15 text-primary font-medium flex items-center gap-1"
                >
                  <span class="w-1 h-1 rounded-full bg-primary" />
                  {{ t("listenTogether.page.chat.mentionedYou") ?? "@了你" }}
                </div>

                <!-- 消息内容气泡（引用条在气泡内部顶部） -->
                <div
                  class="text-sm leading-snug whitespace-pre-wrap break-words overflow-hidden"
                  :class="
                    msg.senderId === currentMemberId
                      ? 'bg-primary text-white rounded-xl rounded-tr-sm shadow-sm shadow-primary/20'
                      : 'bg-surface-bright text-on-surface rounded-xl rounded-tl-sm border border-outline-variant/10 shadow-sm'
                  "
                >
                  <!-- 引用内容（微信风格：气泡内顶部灰色引用条 + 左侧竖线） -->
                  <div
                    v-if="msg.replyTo"
                    class="px-3 pt-1.5 pb-0 text-xs border-l-2"
                    :class="
                      msg.senderId === currentMemberId
                        ? 'border-white/30 text-white/70'
                        : 'border-primary/30 text-on-surface-variant/70'
                    "
                  >
                    <div class="flex items-center gap-1 pl-1">
                      <IconLucideTextQuote class="size-3 shrink-0 opacity-60" />
                      <span class="font-semibold truncate">{{ msg.replyTo.senderNickname }}</span>
                      <span class="opacity-50">:</span>
                      <span class="truncate opacity-60">
                        {{
                          messages.find((m) => m.id === msg.replyTo?.messageId)?.isRecalled
                            ? (t("listenTogether.page.chat.recalled") ?? "消息已撤回")
                            : msg.replyTo.content
                        }}
                      </span>
                    </div>
                  </div>

                  <!-- 消息正文 -->
                  <div class="px-3 py-1.5">
                    <!-- @ 提及高亮 -->
                    <template v-if="msg.mentions && msg.mentions.length > 0">
                      <span
                        v-for="(part, i) in msg.content.split(/(@[^\s]+)/g)"
                        :key="i"
                        :class="
                          part.startsWith('@') &&
                          msg.mentions.some(
                            (mid) => members.find((m) => m.id === mid)?.nickname === part.slice(1),
                          )
                            ? 'font-semibold underline decoration-2 underline-offset-2'
                            : ''
                        "
                        :style="
                          part.startsWith('@')
                            ? {
                                textDecorationColor:
                                  msg.senderId === currentMemberId
                                    ? 'rgba(255,255,255,0.5)'
                                    : 'var(--color-primary)',
                              }
                            : {}
                        "
                      >
                        {{ part }}
                      </span>
                    </template>
                    <template v-else>
                      {{ truncateContent(msg.content) }}
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </SContextMenu>
        </template>
      </div>
    </div>

    <!-- 引用栏 -->
    <div
      v-if="replyingTo"
      class="px-4 py-2 border-t border-outline-variant/10 bg-surface-bright/30 flex items-center gap-2"
    >
      <IconLucideTextQuote class="size-4 text-primary shrink-0" />
      <span class="text-xs text-on-surface-variant/70 flex-1 truncate">
        {{ t("listenTogether.page.chat.replyingTo") ?? "引用" }} {{ replyingTo.senderNickname }}:
        {{
          messages.find((m) => m.id === replyingTo?.messageId)?.isRecalled
            ? (t("listenTogether.page.chat.recalled") ?? "消息已撤回")
            : replyingTo.content
        }}
      </span>
      <button class="text-on-surface-variant/50 hover:text-on-surface" @click="cancelReply">
        <IconLucideX class="size-4" />
      </button>
    </div>

    <!-- 聊天输入 -->
    <div class="p-4 border-t border-outline-variant/10 relative">
      <!-- @ 提及下拉 -->
      <div
        v-if="showMentionDropdown && mentionCandidates.length > 0"
        class="absolute bottom-full left-4 mb-2 bg-surface-bright rounded-xl shadow-lg border border-outline-variant/10 py-1 z-50 max-h-48 overflow-y-auto min-w-40"
        :style="{ maxWidth: '200px' }"
      >
        <div
          v-for="(member, idx) in mentionCandidates"
          :key="member.id"
          class="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-on-surface/8"
          :class="idx === mentionIndex ? 'bg-on-surface/10' : ''"
          @click="selectMention(member)"
        >
          <div
            class="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium"
            :style="{
              backgroundColor: getAvatarColor(member.id) + '20',
              color: getAvatarColor(member.id),
            }"
          >
            {{ getAvatarText(member.nickname) }}
          </div>
          <span class="text-sm">{{ member.nickname }}</span>
        </div>
      </div>

      <div
        class="flex items-end gap-2 bg-surface-bright/60 rounded-2xl p-1.5 border border-outline-variant/10 focus-within:border-primary/40 focus-within:bg-surface-bright focus-within:shadow-sm transition-all duration-200"
      >
        <SInput
          v-model="chatInput"
          :placeholder="t('listenTogether.page.chatPlaceholder')"
          class="chat-input-field flex-1 bg-transparent border-0 focus-visible:ring-0 focus-visible:ring-offset-0 px-3 py-2"
          @keydown.enter="handleSend"
          @input="handleInput"
          @keydown="handleKeydown"
        />
        <span
          v-if="chatInput.length > 0"
          class="text-xs text-on-surface-variant/40 shrink-0 self-center px-1"
          :class="chatInput.length > MAX_MESSAGE_LENGTH ? 'text-red-400' : ''"
        >
          {{ chatInput.length }}/{{ MAX_MESSAGE_LENGTH }}
        </span>
        <SButton type="primary" class="rounded-xl px-4 shadow-sm" @click="handleSend">
          {{ t("listenTogether.page.send") }}
        </SButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
