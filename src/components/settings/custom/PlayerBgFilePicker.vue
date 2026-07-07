<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";
import IconLucideImage from "~icons/lucide/image";
import IconLucideImagePlus from "~icons/lucide/image-plus";
import IconLucideFilm from "~icons/lucide/film";
import IconLucideVideo from "~icons/lucide/video";
import IconLucideX from "~icons/lucide/x";

const props = defineProps<{
  type: "image" | "video";
  modelValue?: string | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string | null): void;
}>();

const { t } = useI18n();
const settings = useSettingsStore();

const picking = ref(false);

const src = computed(() =>
  props.type === "image"
    ? settings.player.playerBgCustomImage
    : settings.player.playerBgCustomVideo,
);

const setSrc = (value: string | null): void => {
  if (props.type === "image") {
    settings.player.playerBgCustomImage = value;
  } else {
    settings.player.playerBgCustomVideo = value;
  }
  emit("update:modelValue", value);
};

/** 选择文件 */
const handlePick = async (): Promise<void> => {
  if (picking.value) return;
  picking.value = true;
  try {
    if (props.type === "image") {
      const url = await window.api.theme.pickBackgroundImage();
      if (url) setSrc(url);
    } else {
      const url = await window.api.theme.pickCustomVideo();
      if (url) setSrc(url);
    }
  } finally {
    picking.value = false;
  }
};

/** 清除 */
const handleClear = (): void => {
  setSrc(null);
};
</script>

<template>
  <div class="flex items-center gap-3">
    <div
      class="w-24 h-14 shrink-0 rounded-lg border border-solid border-outline-variant/30 overflow-hidden bg-on-surface/5 flex items-center justify-center"
    >
      <img
        v-if="type === 'image' && src"
        :src="src"
        class="w-full h-full object-cover"
        draggable="false"
        alt=""
      />
      <video
        v-else-if="type === 'video' && src"
        :src="src"
        class="w-full h-full object-cover"
        muted
        preload="metadata"
      />
      <IconLucideImage v-else-if="type === 'image'" class="size-6 text-on-surface-variant/50" />
      <IconLucideFilm v-else class="size-6 text-on-surface-variant/50" />
    </div>
    <SButton
      variant="secondary"
      size="small"
      circle
      :loading="picking"
      :title="src ? t('settings.playerBgFile.replace') : t('settings.playerBgFile.select')"
      @click="handlePick"
    >
      <template #icon>
        <IconLucideImagePlus v-if="type === 'image'" />
        <IconLucideVideo v-else />
      </template>
    </SButton>
    <SButton
      v-if="src"
      variant="ghost"
      size="small"
      circle
      :title="t('settings.playerBgFile.clear')"
      @click="handleClear"
    >
      <template #icon><IconLucideX /></template>
    </SButton>
  </div>
</template>
