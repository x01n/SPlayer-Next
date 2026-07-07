<script setup lang="ts">
import { renderSVG } from "uqr";
import { useUserStore } from "@/stores/user";
import { toast } from "@/composables/useToast";
import { dialog } from "@/composables/useDialog";
import { REPO_NAME } from "@/utils/config";
import {
  qrKey,
  qrCheck,
  qrContent,
  loginByEmail,
  loginByPhoneCaptcha,
  loginByPhonePassword,
  sendPhoneCaptcha,
  type QrStatusCode,
} from "@/apis/login/netease";
import {
  qrKey as biliQrKey,
  qrCheck as biliQrCheck,
  type BiliQrStatusCode,
} from "@/apis/login/bilibili";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();

const { t } = useI18n();
const user = useUserStore();

const platforms = ["netease", "qqmusic", "spotify", "kugou", "bilibili"] as const;
type Platform = (typeof platforms)[number];
const activePlatform = ref<Platform>("netease");

const loading = ref(false);
const qqLoading = ref(false);
const spotifyLoading = ref(false);
const kugouLoading = ref(false);
const bilibiliLoading = ref(false);
const cookieDialogOpen = ref(false);
const cookieDialogPlatform = ref<"netease" | "kugou" | "bilibili">("netease");
const neteaseLoginLoading = ref(false);
const captchaSending = ref(false);
const captchaCountdown = ref(0);
const neteaseSwitchingAccount = ref(false);

const neteaseLoginMode = ref<"qr" | "email" | "phonePwd" | "captcha" | "cookie">("qr");
const neteaseEmail = ref("");
const neteasePhone = ref("");
const neteasePassword = ref("");
const neteaseCaptcha = ref("");

const captchaTimer = useIntervalFn(
  () => {
    captchaCountdown.value = Math.max(0, captchaCountdown.value - 1);
  },
  1000,
  { immediate: false },
);

watch(captchaCountdown, (seconds) => {
  if (seconds === 0) captchaTimer.pause();
});

/** 网易云二维码 */
const qrUrl = ref("");
const qrUnikey = ref("");
const qrStatus = ref<QrStatusCode>(801);
const scannedNickname = ref("");
const scannedAvatar = ref("");

/** Bilibili 二维码 */
const biliQrUrl = ref("");
const biliQrKeyVal = ref("");
const biliQrStatus = ref<BiliQrStatusCode>(86101);

/** Bilibili 密码 */
const biliPwdUsername = ref("");
const biliPwdPassword = ref("");
const biliPwdLoading = ref(false);

/** Bilibili 登录模式 */
const biliLoginMode = ref<"qr" | "pwd" | "cookie">("qr");

const qrTip = computed(() => {
  switch (qrStatus.value) {
    case 800:
      return t("login.qrTipExpired");
    case 801:
      return t("login.qrTipWaiting");
    case 802:
      return t("login.qrTipScanned");
    case 803:
      return t("login.qrTipDone");
    default:
      return t("login.qrTipUnknown");
  }
});

const showNeteaseLogin = computed(() => !user.isLoggedIn || neteaseSwitchingAccount.value);

const captchaButtonText = computed(() =>
  captchaCountdown.value > 0
    ? t("login.netease.captchaCountdown", { seconds: captchaCountdown.value })
    : t("login.netease.sendCaptcha"),
);

/** Bilibili 二维码状态提示 */
const biliQrTip = computed(() => {
  switch (biliQrStatus.value) {
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

/** 网易云登录完成后的通用处理 */
const finishLogin = async (): Promise<boolean> => {
  const ok = await user.fetchStatus();
  if (ok) {
    toast.success(t("login.success"));
    emit("update:open", false);
    return true;
  }
  toast.error(t("login.failed"));
  return false;
};

const resetScanned = (): void => {
  scannedNickname.value = "";
  scannedAvatar.value = "";
};

const handleNeteaseLoginResult = async (result: {
  success: boolean;
  message?: string;
}): Promise<void> => {
  if (!result.success) {
    toast.error(result.message || t("login.failed"));
    return;
  }
  await finishLogin();
};

/** 取新 unikey + 渲染二维码 SVG。错误纠错级 H：中心遮挡 logo 后仍可扫码
 *  用 data URL + <img> 渲染，避免 v-html 注入 SVG 的 XSS 风险面 */
const refreshQr = async (): Promise<void> => {
  resetScanned();
  qrStatus.value = 801;
  try {
    const key = await qrKey();
    qrUnikey.value = key;
    const svg = renderSVG(qrContent(key), {
      ecc: "H",
      border: 0,
      pixelSize: 8,
      whiteColor: "#ffffff",
      blackColor: "#000000",
    });
    qrUrl.value = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  } catch (err) {
    console.warn("[login] qr key failed:", err);
    qrUnikey.value = "";
    qrUrl.value = "";
  }
};

/** 803 时 cookie 已由主进程 SESSION_MUTATING 自动落库，这里只拉 profile */
const handleQrSuccess = async (cookie: string): Promise<void> => {
  if (!cookie || !cookie.includes("MUSIC_U")) {
    toast.error(t("login.failed"));
    void startQrFlow();
    return;
  }
  loading.value = true;
  try {
    const ok = await finishLogin();
    if (!ok) void startQrFlow();
  } finally {
    loading.value = false;
  }
};

const pollOnce = async (): Promise<void> => {
  if (!qrUnikey.value) return;
  let result: Awaited<ReturnType<typeof qrCheck>>;
  try {
    result = await qrCheck(qrUnikey.value);
  } catch {
    return;
  }
  qrStatus.value = result.code;
  if (result.code === 800) {
    void refreshQr();
    return;
  }
  if (result.code === 802) {
    if (result.nickname) scannedNickname.value = result.nickname;
    if (result.avatarUrl) scannedAvatar.value = result.avatarUrl;
    return;
  }
  if (result.code === 803 && result.cookie) {
    pause();
    await handleQrSuccess(result.cookie);
  }
};

const { pause, resume } = useIntervalFn(pollOnce, 1500, { immediate: false });

const startQrFlow = async (): Promise<void> => {
  pause();
  await refreshQr();
  if (
    qrUnikey.value &&
    props.open &&
    activePlatform.value === "netease" &&
    showNeteaseLogin.value &&
    neteaseLoginMode.value === "qr"
  ) {
    resume();
  }
};

const stopQrFlow = (): void => {
  pause();
  qrUnikey.value = "";
  qrUrl.value = "";
  resetScanned();
};

/** Bilibili 二维码 */
const refreshBiliQr = async (): Promise<void> => {
  biliQrStatus.value = 86101;
  try {
    const result = await biliQrKey();
    biliQrKeyVal.value = result.key;
    const svg = renderSVG(result.url, {
      ecc: "H",
      border: 0,
      pixelSize: 8,
      whiteColor: "#ffffff",
      blackColor: "#000000",
    });
    biliQrUrl.value = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  } catch (err) {
    console.warn("[login] bili qr key failed:", err);
    biliQrKeyVal.value = "";
    biliQrUrl.value = "";
  }
};

const biliPollOnce = async (): Promise<void> => {
  if (!biliQrKeyVal.value) return;
  let result: Awaited<ReturnType<typeof biliQrCheck>>;
  try {
    result = await biliQrCheck(biliQrKeyVal.value);
  } catch {
    return;
  }
  biliQrStatus.value = result.code;
  if (result.code === 86038) {
    void refreshBiliQr();
    return;
  }
  if (result.code === 0 && result.cookie) {
    biliPause();
    bilibiliLoading.value = true;
    try {
      const ok = await user.bilibiliLogin(result.cookie);
      if (ok) {
        toast.success(t("login.success"));
        emit("update:open", false);
      } else {
        toast.error(t("login.failed"));
        void startBiliQrFlow();
      }
    } finally {
      bilibiliLoading.value = false;
    }
  } else if (result.code === 0) {
    // 扫码成功但响应头未携带 cookie，尝试浏览器登录窗口获取
    biliPause();
    bilibiliLoading.value = true;
    try {
      toast.info(t("login.bilibili.qrTipDone"));
      const ok = await user.bilibiliLogin();
      if (ok) {
        toast.success(t("login.success"));
        emit("update:open", false);
      } else {
        toast.error(t("login.failed"));
        void startBiliQrFlow();
      }
    } finally {
      bilibiliLoading.value = false;
    }
  }
};

const { pause: biliPause, resume: biliResume } = useIntervalFn(biliPollOnce, 1500, {
  immediate: false,
});

const startBiliQrFlow = async (): Promise<void> => {
  biliPause();
  await refreshBiliQr();
  if (biliQrKeyVal.value && props.open) biliResume();
};

const stopBiliQrFlow = (): void => {
  biliPause();
  biliQrKeyVal.value = "";
  biliQrUrl.value = "";
};

watch(
  () => props.open,
  (open) => {
    if (open) {
      if (
        activePlatform.value === "netease" &&
        showNeteaseLogin.value &&
        neteaseLoginMode.value === "qr"
      )
        void startQrFlow();
      if (activePlatform.value === "bilibili" && biliLoginMode.value === "qr")
        void startBiliQrFlow();
    } else {
      stopQrFlow();
      stopBiliQrFlow();
      captchaTimer.pause();
      loading.value = false;
      neteaseLoginLoading.value = false;
      captchaSending.value = false;
      captchaCountdown.value = 0;
      neteaseSwitchingAccount.value = false;
      qqLoading.value = false;
      spotifyLoading.value = false;
      kugouLoading.value = false;
      bilibiliLoading.value = false;
      biliPwdLoading.value = false;
    }
  },
  { immediate: true },
);

watch(activePlatform, (platform) => {
  if (
    platform === "netease" &&
    showNeteaseLogin.value &&
    neteaseLoginMode.value === "qr" &&
    props.open
  ) {
    void startQrFlow();
  } else {
    stopQrFlow();
  }

  if (platform === "bilibili" && biliLoginMode.value === "qr" && props.open) {
    void startBiliQrFlow();
  } else {
    stopBiliQrFlow();
  }
});

watch(neteaseLoginMode, (mode) => {
  if (mode === "qr" && props.open && activePlatform.value === "netease" && showNeteaseLogin.value) {
    void startQrFlow();
  } else {
    stopQrFlow();
  }
});

watch(biliLoginMode, (mode) => {
  if (mode === "qr" && props.open && activePlatform.value === "bilibili") {
    void startBiliQrFlow();
  } else {
    stopBiliQrFlow();
  }
});

/** 组件卸载时停止轮询，防止内存泄漏 */
onBeforeUnmount(() => {
  pause();
  biliPause();
  captchaTimer.pause();
});

/** 自动获取：先弹安全提示，确认后才打开官方登录窗口 */
const startAutoFetch = async (): Promise<void> => {
  if (loading.value) return;
  const ok = await dialog.confirm({
    title: t("login.autoFetchTitle"),
    content: t("login.autoFetchTip"),
    confirmText: t("login.autoFetchConfirm"),
    type: "warning",
  });
  if (!ok) return;

  loading.value = true;
  pause();
  try {
    const res = await window.api.apis.openLoginWeb("netease");
    if (!res.ok) {
      if (res.error !== "canceled") toast.error(t("login.failed"));
      if (
        props.open &&
        activePlatform.value === "netease" &&
        showNeteaseLogin.value &&
        neteaseLoginMode.value === "qr"
      ) {
        resume();
      }
      return;
    }
    const ok = await finishLogin();
    if (
      !ok &&
      props.open &&
      activePlatform.value === "netease" &&
      showNeteaseLogin.value &&
      neteaseLoginMode.value === "qr"
    ) {
      void startQrFlow();
    }
  } finally {
    loading.value = false;
  }
};

const handleNeteaseEmailLogin = async (): Promise<void> => {
  const email = neteaseEmail.value.trim();
  const password = neteasePassword.value.trim();
  if (!email || !password) {
    toast.error(t("login.netease.emailEmpty"));
    return;
  }

  neteaseLoginLoading.value = true;
  try {
    await handleNeteaseLoginResult(await loginByEmail(email, password));
  } finally {
    neteaseLoginLoading.value = false;
  }
};

const handleNeteasePhonePasswordLogin = async (): Promise<void> => {
  const phone = neteasePhone.value.trim();
  const password = neteasePassword.value.trim();
  if (!phone || !password) {
    toast.error(t("login.netease.phonePasswordEmpty"));
    return;
  }

  neteaseLoginLoading.value = true;
  try {
    await handleNeteaseLoginResult(await loginByPhonePassword(phone, password));
  } finally {
    neteaseLoginLoading.value = false;
  }
};

const handleSendNeteaseCaptcha = async (): Promise<void> => {
  const phone = neteasePhone.value.trim();
  if (!phone) {
    toast.error(t("login.netease.phoneEmpty"));
    return;
  }
  if (captchaCountdown.value > 0) return;

  captchaSending.value = true;
  try {
    const result = await sendPhoneCaptcha(phone);
    if (!result.success) {
      toast.error(result.message || t("login.netease.captchaFailed"));
      return;
    }
    toast.success(t("login.netease.captchaSent"));
    captchaCountdown.value = 60;
    captchaTimer.resume();
  } finally {
    captchaSending.value = false;
  }
};

const handleNeteaseCaptchaLogin = async (): Promise<void> => {
  const phone = neteasePhone.value.trim();
  const captcha = neteaseCaptcha.value.trim();
  if (!phone || !captcha) {
    toast.error(t("login.netease.captchaEmpty"));
    return;
  }

  neteaseLoginLoading.value = true;
  try {
    await handleNeteaseLoginResult(await loginByPhoneCaptcha(phone, captcha));
  } finally {
    neteaseLoginLoading.value = false;
  }
};

const handleNeteaseSwitchAccount = (): void => {
  neteaseSwitchingAccount.value = true;
  if (props.open && activePlatform.value === "netease" && neteaseLoginMode.value === "qr") {
    void startQrFlow();
  }
};

const openManualCookie = (platform: "netease" | "kugou" | "bilibili" = "netease"): void => {
  pause();
  biliPause();
  cookieDialogPlatform.value = platform;
  cookieDialogOpen.value = true;
};

/** cookie 弹窗关闭后恢复扫码轮询 */
const onCookieDialogOpen = (open: boolean): void => {
  cookieDialogOpen.value = open;
  if (!open && props.open) {
    if (
      activePlatform.value === "netease" &&
      showNeteaseLogin.value &&
      neteaseLoginMode.value === "qr"
    ) {
      resume();
    }
    if (activePlatform.value === "bilibili" && biliLoginMode.value === "qr") biliResume();
  }
};

const onCookieSuccess = (): void => {
  emit("update:open", false);
};

const onOpenUpdate = (value: boolean): void => {
  emit("update:open", value);
};

/** QQ 音乐登录 */
const handleQQLogin = async (): Promise<void> => {
  qqLoading.value = true;
  try {
    const ok = await user.qqmusicLogin();
    if (ok) {
      toast.success(t("login.success"));
      emit("update:open", false);
      return;
    }
    toast.error(t("login.failed"));
  } finally {
    qqLoading.value = false;
  }
};

/** Spotify 登录 */
const handleSpotifyLogin = async (): Promise<void> => {
  spotifyLoading.value = true;
  try {
    const ok = await user.spotifyLogin();
    if (ok) {
      toast.success(t("login.spotify.success"));
      emit("update:open", false);
      return;
    }
    toast.error(t("login.spotify.failed"));
  } finally {
    spotifyLoading.value = false;
  }
};

/** 酷狗登录 - 打开 Cookie 输入对话框 */
const handleKugouLogin = (): void => {
  openManualCookie("kugou");
};

/** Bilibili 浏览器登录 */
const handleBilibiliLogin = async (): Promise<void> => {
  bilibiliLoading.value = true;
  try {
    const ok = await user.bilibiliLogin();
    if (ok) {
      toast.success(t("login.success"));
      emit("update:open", false);
      return;
    }
    toast.error(t("login.failed"));
  } finally {
    bilibiliLoading.value = false;
  }
};

/** Bilibili 密码登录 */
const handleBilibiliPwdLogin = async (): Promise<void> => {
  if (!biliPwdUsername.value.trim() || !biliPwdPassword.value.trim()) {
    toast.error(t("login.bilibili.pwdEmpty"));
    return;
  }
  biliPwdLoading.value = true;
  try {
    const ok = await user.bilibiliPasswordLogin(
      biliPwdUsername.value.trim(),
      biliPwdPassword.value.trim(),
    );
    if (ok) {
      toast.success(t("login.success"));
      emit("update:open", false);
      return;
    }
    toast.error(t("login.failed"));
  } finally {
    biliPwdLoading.value = false;
  }
};
</script>

<template>
  <SDialog :open="open" :closable="false" width="420px" @update:open="onOpenUpdate">
    <!-- 平台切换 -->
    <div class="flex items-center gap-1 rounded-lg bg-on-surface/5 p-1 mb-4">
      <button
        v-for="p in platforms"
        :key="p"
        :class="[
          'flex-1 py-1.5 text-sm rounded-md transition-colors',
          activePlatform === p
            ? 'bg-surface text-on-surface font-medium'
            : 'text-on-surface-variant hover:text-on-surface',
        ]"
        @click="activePlatform = p"
      >
        {{ t(`login.platform.${p}`) }}
      </button>
    </div>

    <div class="flex flex-col items-center gap-4 py-3">
      <div class="flex flex-col items-center gap-2">
        <SLogo :size="48" />
        <div class="text-xl font-semibold text-on-surface">{{ REPO_NAME }}</div>
      </div>

      <!-- 网易云 -->
      <div v-if="activePlatform === 'netease'" class="flex flex-col items-center gap-4 py-2 w-full">
        <div
          v-if="user.isLoggedIn && !neteaseSwitchingAccount"
          class="flex flex-col items-center gap-2 py-4"
        >
          <span class="text-sm text-on-surface">
            {{ t("login.alreadyLoggedIn", { name: user.profile?.nickname }) }}
          </span>
          <SButton variant="ghost" size="small" @click="handleNeteaseSwitchAccount">
            {{ t("login.switchAccount") }}
          </SButton>
        </div>
        <template v-else>
          <div class="flex items-center gap-1 rounded-lg bg-on-surface/5 p-1 w-full">
            <button
              v-for="mode in ['qr', 'email', 'phonePwd', 'captcha', 'cookie'] as const"
              :key="mode"
              :class="[
                'flex-1 py-1.5 text-xs rounded-md transition-colors',
                neteaseLoginMode === mode
                  ? 'bg-surface text-on-surface font-medium'
                  : 'text-on-surface-variant hover:text-on-surface',
              ]"
              @click="neteaseLoginMode = mode"
            >
              {{ t(`login.netease.mode.${mode}`) }}
            </button>
          </div>

          <template v-if="neteaseLoginMode === 'qr'">
            <div
              class="relative size-40 mt-2 rounded-2xl bg-white p-3 border border-solid border-on-surface/12 shadow-sm overflow-hidden"
            >
              <img
                v-if="qrUrl"
                :src="qrUrl"
                alt="QR"
                :class="[
                  'size-full',
                  qrStatus === 802 && 'opacity-30 blur-4',
                  qrStatus === 800 && 'opacity-40',
                ]"
              />
              <div v-else class="size-full flex items-center justify-center text-gray-400">
                <SLoading class="size-6" />
              </div>
              <div
                v-if="qrUrl && qrStatus !== 802 && qrStatus !== 800"
                class="absolute inset-0 flex items-center justify-center pointer-events-none"
              >
                <div class="size-8 rounded-lg bg-white overflow-hidden">
                  <img src="/icons/logo-icon.png" alt="logo" class="size-full object-contain" />
                </div>
              </div>
              <Transition name="fade">
                <div
                  v-if="qrStatus === 802 && scannedNickname"
                  class="absolute inset-0 flex flex-col items-center justify-center gap-1.5"
                >
                  <img
                    v-if="scannedAvatar"
                    :src="scannedAvatar"
                    referrerpolicy="no-referrer"
                    alt="avatar"
                    class="size-12 rounded-full object-cover"
                  />
                  <div
                    class="text-xs font-semibold text-gray-900 [text-shadow:0_0_4px_white,0_0_8px_white]"
                  >
                    {{ scannedNickname }}
                  </div>
                </div>
              </Transition>
              <div
                v-if="qrStatus === 800"
                class="absolute inset-0 flex items-center justify-center text-xs font-medium text-gray-700 bg-white/70 cursor-pointer select-none"
                @click="refreshQr"
              >
                {{ t("login.qrRefresh") }}
              </div>
            </div>
            <div class="text-xs text-on-surface-variant">{{ qrTip }}</div>
          </template>

          <div v-else-if="neteaseLoginMode === 'email'" class="flex flex-col gap-3 w-full px-4">
            <SInput
              v-model="neteaseEmail"
              :placeholder="t('login.netease.emailPlaceholder')"
              clearable
            />
            <SInput
              v-model="neteasePassword"
              type="password"
              :placeholder="t('login.netease.passwordPlaceholder')"
              clearable
              @keydown.enter="handleNeteaseEmailLogin"
            />
            <SButton type="primary" :loading="neteaseLoginLoading" @click="handleNeteaseEmailLogin">
              {{ t("login.netease.login") }}
            </SButton>
          </div>

          <div v-else-if="neteaseLoginMode === 'phonePwd'" class="flex flex-col gap-3 w-full px-4">
            <SInput
              v-model="neteasePhone"
              :placeholder="t('login.netease.phonePlaceholder')"
              clearable
            />
            <SInput
              v-model="neteasePassword"
              type="password"
              :placeholder="t('login.netease.passwordPlaceholder')"
              clearable
              @keydown.enter="handleNeteasePhonePasswordLogin"
            />
            <SButton
              type="primary"
              :loading="neteaseLoginLoading"
              @click="handleNeteasePhonePasswordLogin"
            >
              {{ t("login.netease.login") }}
            </SButton>
          </div>

          <div v-else-if="neteaseLoginMode === 'captcha'" class="flex flex-col gap-3 w-full px-4">
            <SInput
              v-model="neteasePhone"
              :placeholder="t('login.netease.phonePlaceholder')"
              clearable
            />
            <div class="flex items-center gap-2">
              <SInput
                v-model="neteaseCaptcha"
                class="min-w-0 flex-1"
                :placeholder="t('login.netease.captchaPlaceholder')"
                clearable
                @keydown.enter="handleNeteaseCaptchaLogin"
              />
              <SButton
                variant="secondary"
                :loading="captchaSending"
                :disabled="captchaCountdown > 0"
                @click="handleSendNeteaseCaptcha"
              >
                {{ captchaButtonText }}
              </SButton>
            </div>
            <SButton
              type="primary"
              :loading="neteaseLoginLoading"
              @click="handleNeteaseCaptchaLogin"
            >
              {{ t("login.netease.login") }}
            </SButton>
          </div>

          <div
            v-else-if="neteaseLoginMode === 'cookie'"
            class="flex flex-col items-center gap-3 py-2 px-4"
          >
            <div class="text-xs leading-5 text-on-surface-variant text-center">
              {{ t("login.netease.cookieSecurityTip") }}
            </div>
            <SButton variant="ghost" size="small" :disabled="loading" @click="startAutoFetch">
              <template #icon><IconLucideScanLine /></template>
              {{ t("login.autoFetch") }}
            </SButton>
            <SButton
              variant="ghost"
              size="small"
              :disabled="loading"
              @click="openManualCookie('netease')"
            >
              <template #icon><IconLucideKeyRound /></template>
              {{ t("login.manualCookie") }}
            </SButton>
          </div>

          <div class="text-xs leading-5 text-on-surface-variant text-center px-4">
            {{ t("login.netease.securityTip") }}
          </div>
        </template>
      </div>

      <!-- QQ 音乐 -->
      <div
        v-else-if="activePlatform === 'qqmusic'"
        class="flex flex-col items-center gap-4 py-6 w-full"
      >
        <div v-if="user.isQQMusicLoggedIn" class="flex flex-col items-center gap-2">
          <span class="text-sm text-on-surface">
            {{ t("login.alreadyLoggedIn", { name: user.qqmusicProfile?.nickname }) }}
          </span>
          <SButton variant="ghost" size="small" @click="handleQQLogin">
            {{ t("login.switchAccount") }}
          </SButton>
        </div>
        <SButton v-else :loading="qqLoading" @click="handleQQLogin">
          {{ t("login.qqmusicLogin") }}
        </SButton>
      </div>

      <!-- Spotify -->
      <div
        v-else-if="activePlatform === 'spotify'"
        class="flex flex-col items-center gap-4 py-6 w-full"
      >
        <div v-if="user.isSpotifyLoggedIn" class="flex flex-col items-center gap-2">
          <span class="text-sm text-on-surface">
            {{ t("login.alreadyLoggedIn", { name: user.spotifyProfile?.displayName }) }}
          </span>
          <SButton variant="ghost" size="small" @click="handleSpotifyLogin">
            {{ t("login.switchAccount") }}
          </SButton>
        </div>
        <SButton v-else :loading="spotifyLoading" @click="handleSpotifyLogin">
          {{ t("login.spotifyLogin") }}
        </SButton>
      </div>

      <!-- 酷狗 -->
      <div
        v-else-if="activePlatform === 'kugou'"
        class="flex flex-col items-center gap-4 py-6 w-full"
      >
        <div v-if="user.isKugouLoggedIn" class="flex flex-col items-center gap-2">
          <span class="text-sm text-on-surface">
            {{ t("login.alreadyLoggedIn", { name: user.kugouProfile?.nickname }) }}
          </span>
          <SButton variant="ghost" size="small" @click="handleKugouLogin">
            {{ t("login.switchAccount") }}
          </SButton>
        </div>
        <template v-else>
          <SButton :loading="kugouLoading" @click="handleKugouLogin">
            {{ t("login.kugouLogin") }}
          </SButton>
          <SButton variant="ghost" size="small" @click="openManualCookie('kugou')">
            <template #icon><IconLucideKeyRound /></template>
            {{ t("login.manualCookie") }}
          </SButton>
        </template>
      </div>

      <!-- Bilibili -->
      <div
        v-else-if="activePlatform === 'bilibili'"
        class="flex flex-col items-center gap-4 py-2 w-full"
      >
        <div v-if="user.isBilibiliLoggedIn" class="flex flex-col items-center gap-2">
          <span class="text-sm text-on-surface">
            {{ t("login.alreadyLoggedIn", { name: user.bilibiliProfile?.nickname }) }}
          </span>
          <SButton variant="ghost" size="small" @click="handleBilibiliLogin">
            {{ t("login.switchAccount") }}
          </SButton>
        </div>
        <template v-else>
          <!-- 登录方式切换 -->
          <div class="flex items-center gap-1 rounded-lg bg-on-surface/5 p-1 w-full">
            <button
              v-for="mode in ['qr', 'pwd', 'cookie'] as const"
              :key="mode"
              :class="[
                'flex-1 py-1.5 text-xs rounded-md transition-colors',
                biliLoginMode === mode
                  ? 'bg-surface text-on-surface font-medium'
                  : 'text-on-surface-variant hover:text-on-surface',
              ]"
              @click="biliLoginMode = mode"
            >
              {{ t(`login.bilibili.mode.${mode}`) }}
            </button>
          </div>

          <!-- 二维码登录 -->
          <template v-if="biliLoginMode === 'qr'">
            <div
              class="relative size-36 rounded-2xl bg-white p-2.5 border border-solid border-on-surface/12 shadow-sm overflow-hidden"
            >
              <img
                v-if="biliQrUrl"
                :src="biliQrUrl"
                alt="QR"
                class="pointer-events-none size-full"
                :class="[
                  biliQrStatus === 86090 && 'opacity-30 blur-4',
                  biliQrStatus === 86038 && 'opacity-40',
                ]"
              />
              <div v-else class="size-full flex items-center justify-center text-gray-400">
                <SLoading class="size-6" />
              </div>
              <div
                v-if="biliQrUrl && biliQrStatus !== 86090 && biliQrStatus !== 86038"
                class="absolute inset-0 flex items-center justify-center pointer-events-none"
              >
                <div class="size-7 rounded-md bg-white overflow-hidden">
                  <img src="/icons/logo-icon.png" alt="logo" class="size-full object-contain" />
                </div>
              </div>
              <div
                v-if="biliQrStatus === 86038"
                class="absolute inset-0 flex items-center justify-center text-xs font-medium text-gray-700 bg-white/70 cursor-pointer select-none"
                @click="refreshBiliQr"
              >
                {{ t("login.qrRefresh") }}
              </div>
            </div>
            <div class="text-xs text-on-surface-variant">{{ biliQrTip }}</div>
          </template>

          <!-- 密码登录 -->
          <div v-else-if="biliLoginMode === 'pwd'" class="flex flex-col gap-3 w-full px-4">
            <SInput
              v-model="biliPwdUsername"
              :placeholder="t('login.bilibili.usernamePlaceholder')"
              clearable
            />
            <SInput
              v-model="biliPwdPassword"
              type="password"
              :placeholder="t('login.bilibili.passwordPlaceholder')"
              clearable
              @keydown.enter="handleBilibiliPwdLogin"
            />
            <SButton type="primary" :loading="biliPwdLoading" @click="handleBilibiliPwdLogin">
              {{ t("login.bilibili.pwdLogin") }}
            </SButton>
          </div>

          <!-- Cookie 登录 -->
          <div v-else-if="biliLoginMode === 'cookie'" class="flex flex-col items-center gap-3 py-2">
            <SButton :loading="bilibiliLoading" @click="handleBilibiliLogin">
              {{ t("login.bilibiliLogin") }}
            </SButton>
            <SButton variant="ghost" size="small" @click="openManualCookie('bilibili')">
              <template #icon><IconLucideKeyRound /></template>
              {{ t("login.manualCookie") }}
            </SButton>
          </div>
        </template>
      </div>
    </div>
    <template #footer="{ close }">
      <SButton
        variant="tertiary"
        class="mx-auto"
        :disabled="
          loading ||
          neteaseLoginLoading ||
          captchaSending ||
          qqLoading ||
          spotifyLoading ||
          kugouLoading ||
          bilibiliLoading ||
          biliPwdLoading
        "
        @click="close"
      >
        <template #icon><IconLucideX /></template>
        {{ t("common.cancel") }}
      </SButton>
    </template>
  </SDialog>
  <!-- 手动输入 -->
  <LoginCookieDialog
    :open="cookieDialogOpen"
    :platform="cookieDialogPlatform"
    @update:open="onCookieDialogOpen"
    @success="onCookieSuccess"
  />
</template>
