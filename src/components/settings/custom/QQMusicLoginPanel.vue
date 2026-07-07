<script setup lang="ts">
import { useUserStore } from "@/stores/user";
import { toast } from "@/composables/useToast";
import IconLucideLogIn from "~icons/lucide/log-in";
import IconLucideLogOut from "~icons/lucide/log-out";

defineOptions({ inheritAttrs: false });

const { t } = useI18n();
const userStore = useUserStore();
const confirmOpen = ref(false);
const loading = ref(false);

/** 刷新 QQ 音乐登录状态 */
const refresh = async (): Promise<void> => {
  await userStore.qqmusicFetchStatus();
};

onMounted(refresh);

/** 打开 QQ 音乐登录窗口 */
const handleLogin = async (): Promise<void> => {
  loading.value = true;
  try {
    const ok = await userStore.qqmusicLogin();
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
  await userStore.qqmusicLogout();
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
              userStore.isQQMusicLoggedIn
                ? t("settings.qqmusic.connectedAs", { name: userStore.qqmusicProfile?.nickname || userStore.qqmusicProfile?.userId })
                : t("settings.qqmusic.notConnected")
            }}
          </div>
          <div class="text-xs text-on-surface-variant/60 mt-0.5">
            {{ t("settings.qqmusic.connectHint") }}
          </div>
        </div>
      </div>

      <div class="shrink-0 flex items-center gap-2">
        <SButton
          v-if="userStore.isQQMusicLoggedIn"
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
        <SButton v-else variant="secondary" size="small" type="primary" :loading="loading" @click="handleLogin">
          {{ t("login.cookieConfirm") }}
        </SButton>
      </div>
    </div>

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
