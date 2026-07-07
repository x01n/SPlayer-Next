<script setup lang="ts">
import { renderSVG } from "uqr";
import { useUserStore } from "@/stores/user";
import { toast } from "@/composables/useToast";
import IconLucideLogIn from "~icons/lucide/log-in";
import IconLucideLogOut from "~icons/lucide/log-out";
import { qrKey, qrCheck, type BiliQrStatusCode } from "@/apis/login/bilibili";

defineOptions({ inheritAttrs: false });

const { t } = useI18n();
const userStore = useUserStore();
const confirmOpen = ref(false);
const cookieDialogOpen = ref(false);
const cookieInput = ref("");
const loading = ref(false);

/** 登录方式：qr / pwd / cookie */
const loginMode = ref<"qr" | "pwd" | "cookie">("qr");

/** 二维码相关 */
const qrUrl = ref("");
const qrKeyVal = ref("");
const qrStatus = ref<BiliQrStatusCode>(86101);
const qrLoading = ref(false);

/** 密码相关 */
const pwdUsername = ref("");
const pwdPassword = ref("");
const pwdLoading = ref(false);

/** 刷新登录状态 */
const refresh = async (): Promise<void> => {
  await userStore.bilibiliFetchStatus();
};

onMounted(refresh);

/** Bilibili 二维码状态提示 */
const qrTip = computed(() => {
  switch (qrStatus.value) {
    case 86038:
      return t("login.bilibili.qrTipExpired");
    case 86090:
      return t("login.bilibili.qrTipScanned");
    case 86101:
      return t("login.bilibili.qrTipWaiting");
    case 0:
      return t("login.bilibili.qrTipDone");
    default:
      return t("login.bilibili.qrTipUnknown");
  }
});

/** 获取新二维码 */
const refreshQr = async (): Promise<void> => {
  qrStatus.value = 86101;
  qrLoading.value = true;
  try {
    const result = await qrKey();
    qrKeyVal.value = result.key;
    const svg = renderSVG(result.url, {
      ecc: "H",
      border: 0,
      pixelSize: 8,
      whiteColor: "#ffffff",
      blackColor: "#000000",
    });
    qrUrl.value = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  } catch (err) {
    console.warn("[bilibili-login] qr key failed:", err);
    qrKeyVal.value = "";
    qrUrl.value = "";
  } finally {
    qrLoading.value = false;
  }
};

/** 轮询二维码状态 */
const pollOnce = async (): Promise<void> => {
  if (!qrKeyVal.value) return;
  let result: Awaited<ReturnType<typeof qrCheck>>;
  try {
    result = await qrCheck(qrKeyVal.value);
  } catch {
    return;
  }
  qrStatus.value = result.code;
  if (result.code === 86038) {
    void refreshQr();
    return;
  }
  if (result.code === 0 && result.cookie) {
    pause();
    loading.value = true;
    try {
      const ok = await userStore.bilibiliLogin(result.cookie);
      if (ok) {
        toast.success(t("login.success"));
        await refresh();
      } else {
        toast.error(t("login.failed"));
        void refreshQr();
      }
    } finally {
      loading.value = false;
    }
  }
};

const { pause, resume } = useIntervalFn(pollOnce, 1500, { immediate: false });

/** 启动二维码流程 */
const startQrFlow = async (): Promise<void> => {
  pause();
  await refreshQr();
  if (qrKeyVal.value) resume();
};

/** 停止二维码流程 */
const stopQrFlow = (): void => {
  pause();
  qrKeyVal.value = "";
  qrUrl.value = "";
};

watch(loginMode, (mode) => {
  if (mode === "qr") {
    void startQrFlow();
  } else {
    stopQrFlow();
  }
});

onBeforeUnmount(() => {
  pause();
});

/** Cookie 登录 */
const handleCookieLogin = async (): Promise<void> => {
  if (!cookieInput.value.trim()) {
    toast.error(t("login.cookieEmpty"));
    return;
  }
  loading.value = true;
  try {
    const ok = await userStore.bilibiliLogin(cookieInput.value.trim());
    if (ok) {
      cookieDialogOpen.value = false;
      cookieInput.value = "";
      await refresh();
      toast.success(t("login.success"));
      return;
    }
    toast.error(t("login.failed"));
  } finally {
    loading.value = false;
  }
};

/** 密码登录 */
const handlePasswordLogin = async (): Promise<void> => {
  if (!pwdUsername.value.trim() || !pwdPassword.value.trim()) {
    toast.error(t("login.bilibili.pwdEmpty"));
    return;
  }
  pwdLoading.value = true;
  try {
    const ok = await userStore.bilibiliPasswordLogin(pwdUsername.value.trim(), pwdPassword.value.trim());
    if (ok) {
      pwdUsername.value = "";
      pwdPassword.value = "";
      await refresh();
      toast.success(t("login.success"));
      return;
    }
    toast.error(t("login.failed"));
  } finally {
    pwdLoading.value = false;
  }
};

/** 浏览器登录 */
const handleBrowserLogin = async (): Promise<void> => {
  loading.value = true;
  try {
    const ok = await userStore.bilibiliLogin();
    if (ok) {
      await refresh();
      toast.success(t("login.success"));
      return;
    }
    toast.error(t("login.failed"));
  } finally {
    loading.value = false;
  }
};

/** 登出 */
const handleLogout = async (): Promise<void> => {
  confirmOpen.value = false;
  await userStore.bilibiliLogout();
  toast.success(t("login.logoutDone"));
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      class="flex items-center justify-between gap-4 rounded-xl bg-surface-panel border border-solid border-outline-variant/15 px-4 py-3.5"
    >
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <div
          class="size-10 rounded-xl bg-on-surface/6 flex items-center justify-center text-on-surface-variant shrink-0"
        >
          <IconLucideLogIn class="size-5" />
        </div>
        <div class="min-w-0">
          <div class="text-sm font-medium text-on-surface truncate">
            {{
              userStore.isBilibiliLoggedIn
                ? t("settings.bilibili.connectedAs", { name: userStore.bilibiliProfile?.nickname || userStore.bilibiliProfile?.userId })
                : t("settings.bilibili.notConnected")
            }}
          </div>
          <div class="text-xs text-on-surface-variant/60 mt-0.5">
            {{ t("settings.bilibili.connectHint") }}
          </div>
        </div>
      </div>

      <div class="shrink-0 flex items-center gap-2">
        <SButton
          v-if="userStore.isBilibiliLoggedIn"
          variant="secondary"
          size="small"
          type="error"
          @click="confirmOpen = true"
        >
          <template #icon>
            <IconLucideLogOut class="size-4" />
          </template>
          {{ t("login.logout") }}
        </SButton>
      </div>
    </div>

    <!-- 未登录时显示登录选项 -->
    <template v-if="!userStore.isBilibiliLoggedIn">
      <!-- 登录方式切换 -->
      <div class="flex items-center gap-1 rounded-lg bg-on-surface/5 p-1">
        <button
          v-for="mode in (['qr', 'pwd', 'cookie'] as const)"
          :key="mode"
          :class="[
            'flex-1 py-1.5 text-xs rounded-md transition-colors',
            loginMode === mode ? 'bg-surface text-on-surface font-medium' : 'text-on-surface-variant hover:text-on-surface',
          ]"
          @click="loginMode = mode"
        >
          {{ t(`login.bilibili.mode.${mode}`) }}
        </button>
      </div>

      <!-- 二维码登录 -->
      <div v-if="loginMode === 'qr'" class="flex flex-col items-center gap-3 py-2">
        <div
          class="relative size-36 rounded-2xl bg-white p-2.5 border border-solid border-on-surface/12 shadow-sm overflow-hidden"
        >
          <img
            v-if="qrUrl"
            :src="qrUrl"
            alt="QR"
            :class="[
              'size-full',
              qrStatus === 86090 && 'opacity-30 blur-4',
              qrStatus === 86038 && 'opacity-40',
            ]"
          />
          <div v-else class="size-full flex items-center justify-center text-gray-400">
            <SLoading class="size-6" />
          </div>
          <!-- logo 遮罩 -->
          <div
            v-if="qrUrl && qrStatus !== 86090 && qrStatus !== 86038"
            class="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            <div class="size-7 rounded-md bg-white overflow-hidden">
              <img src="/icons/logo-icon.png" alt="logo" class="size-full object-contain" />
            </div>
          </div>
          <!-- 过期遮罩 -->
          <div
            v-if="qrStatus === 86038"
            class="absolute inset-0 flex items-center justify-center text-xs font-medium text-gray-700 bg-white/70 cursor-pointer select-none"
            @click="refreshQr"
          >
            {{ t("login.qrRefresh") }}
          </div>
        </div>
        <div class="text-xs text-on-surface-variant">{{ qrTip }}</div>
        <SButton variant="ghost" size="small" :loading="qrLoading" @click="refreshQr">
          {{ t("login.qrRefresh") }}
        </SButton>
      </div>

      <!-- 密码登录 -->
      <div v-else-if="loginMode === 'pwd'" class="flex flex-col gap-3 py-1">
        <SInput
          v-model="pwdUsername"
          :placeholder="t('login.bilibili.usernamePlaceholder')"
          clearable
        />
        <SInput
          v-model="pwdPassword"
          type="password"
          :placeholder="t('login.bilibili.passwordPlaceholder')"
          clearable
          @keydown.enter="handlePasswordLogin"
        />
        <SButton type="primary" :loading="pwdLoading" @click="handlePasswordLogin">
          {{ t("login.bilibili.pwdLogin") }}
        </SButton>
      </div>

      <!-- Cookie 登录 -->
      <div v-else-if="loginMode === 'cookie'" class="flex flex-col gap-3 py-1">
        <STextarea
          v-model="cookieInput"
          :placeholder="t('login.cookiePlaceholder')"
          rows="3"
        />
        <div class="flex items-center gap-2">
          <SButton variant="secondary" class="flex-1" @click="handleBrowserLogin">
            {{ t("login.autoFetch") }}
          </SButton>
          <SButton type="primary" class="flex-1" :loading="loading" @click="handleCookieLogin">
            {{ t("login.cookieConfirm") }}
          </SButton>
        </div>
      </div>
    </template>

    <SDialog v-model:open="confirmOpen" :title="t('login.logout')" width="400px">
      <p class="text-sm text-on-surface-variant">
        {{ t("login.logoutConfirmDesc") }}
      </p>
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">{{ t("common.cancel") }}</SButton>
        <SButton variant="secondary" type="error" @click="handleLogout">
          {{ t("common.confirm") }}
        </SButton>
      </template>
    </SDialog>
  </div>
</template>
