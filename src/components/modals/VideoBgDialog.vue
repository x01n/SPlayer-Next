<script setup lang="ts">
import type { BiliVideoItem } from "@/apis/bilibili";
import { searchVideos, getVideoInfo, getVideoUrl } from "@/apis/bilibili";
import { useStatusStore } from "@/stores/status";
import { useTrackVideoBg } from "@/composables/useTrackVideoBg";
import { toast } from "@/composables/useToast";
import { formatTime } from "@/utils/time";
import IconLucideSearch from "~icons/lucide/search";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideLink from "~icons/lucide/link";
import IconLucideFilm from "~icons/lucide/film";

const { t } = useI18n();
const status = useStatusStore();
const { currentTrackVideoBg, loadTrackVideoBg, saveTrackVideoBg, deleteTrackVideoBg } =
  useTrackVideoBg();

/** 搜索关键词 */
const keyword = ref("");
/** 自定义 URL 输入 */
const customUrl = ref("");

const isSupportedVideoUrl = (url: string): boolean =>
  url.startsWith("http://") || url.startsWith("https://") || url.startsWith("cache://");
/** 搜索中状态 */
const searching = ref(false);
/** 是否已执行过搜索 */
const hasSearched = ref(false);
/** 搜索结果列表 */
const results = ref<BiliVideoItem[]>([]);
/** 搜索请求竞态 token */
let searchToken = 0;

/**
 * 监听弹窗打开，预填歌曲信息并加载当前配置
 */
watch(
  () => status.videoBgDialogOpen,
  async (open) => {
    if (!open) {
      searching.value = false;
      hasSearched.value = false;
      results.value = [];
      return;
    }
    const track = status.videoBgDialogTrack;
    if (track) {
      await loadTrackVideoBg(track.id);
      keyword.value = track.title;
    }
    customUrl.value = "";
    hasSearched.value = false;
    results.value = [];
  },
);

/**
 * 执行 Bilibili 视频搜索
 */
const handleSearch = async (): Promise<void> => {
  const q = keyword.value.trim();
  if (!q) return;
  const myToken = ++searchToken;
  searching.value = true;
  hasSearched.value = false;
  results.value = [];
  try {
    const resp = await searchVideos(q, 1, 20);
    if (myToken !== searchToken) return;
    results.value = resp.items;
  } catch (err) {
    if (myToken !== searchToken) return;
    const msg = err instanceof Error ? err.message : String(err);
    toast.error(msg);
    console.error("[VideoBgDialog] search failed:", err);
  } finally {
    if (myToken === searchToken) {
      searching.value = false;
      hasSearched.value = true;
    }
  }
};

/**
 * 选择搜索结果并获取视频流地址保存
 * @param item - Bilibili 视频搜索结果项
 */
const handleSelect = async (item: BiliVideoItem): Promise<void> => {
  const track = status.videoBgDialogTrack;
  if (!track) return;
  try {
    const { cid } = await getVideoInfo(item.bvid);
    const videoUrl = await getVideoUrl(item.bvid, cid);
    await saveTrackVideoBg(track.id, {
      videoUrl,
      source: "bilibili",
      title: item.title,
      bvid: item.bvid,
      cid,
    });
    toast.success(t("player.videoBg.saved"));
    status.videoBgDialogOpen = false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error(msg);
    console.error("[VideoBgDialog] get video url failed:", err);
  }
};

/**
 * 保存自定义 URL 为视频背景
 */
const handleSaveCustomUrl = async (): Promise<void> => {
  const url = customUrl.value.trim();
  if (!url) return;
  if (!isSupportedVideoUrl(url)) {
    toast.error(t("player.videoBg.urlInvalid"));
    return;
  }
  const track = status.videoBgDialogTrack;
  if (!track) return;
  await saveTrackVideoBg(track.id, {
    videoUrl: url,
    source: "custom",
    title: url,
  });
  toast.success(t("player.videoBg.saved"));
  status.videoBgDialogOpen = false;
};

/**
 * 删除当前歌曲的视频背景配置
 */
const handleDelete = async (): Promise<void> => {
  const track = status.videoBgDialogTrack;
  if (!track) return;
  await deleteTrackVideoBg(track.id);
  toast.success(t("player.videoBg.deleted"));
};

/**
 * 将秒数格式化为 m:ss 或 h:mm:ss
 * @param sec - 秒数
 * @returns 格式化文本
 */
const formatDuration = (sec: number): string => {
  return formatTime(sec * 1000);
};
</script>

<template>
  <SDialog
    v-model:open="status.videoBgDialogOpen"
    :title="
      status.videoBgDialogTrack
        ? t('player.videoBg.title', { name: status.videoBgDialogTrack.title })
        : t('player.videoBg.name')
    "
    width="520px"
  >
    <div class="flex flex-col gap-4">
      <!-- 当前已配置的视频背景 -->
      <div
        v-if="currentTrackVideoBg"
        class="flex items-center gap-3 rounded-xl bg-on-surface/3 p-3 border border-solid border-outline-variant/30"
      >
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <IconLucideFilm class="size-5 text-primary" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-on-surface">
            {{ currentTrackVideoBg.title }}
          </div>
          <div class="text-xs text-on-surface-variant">
            {{
              currentTrackVideoBg.source === "bilibili" ? "Bilibili" : t("player.videoBg.custom")
            }}
          </div>
        </div>
        <SButton variant="ghost" size="small" circle @click="handleDelete">
          <template #icon><IconLucideTrash2 /></template>
        </SButton>
      </div>

      <!-- 搜索区域 -->
      <div class="flex flex-col gap-3">
        <div class="flex gap-2">
          <SInput
            v-model="keyword"
            :placeholder="t('player.videoBg.searchPlaceholder')"
            clearable
          />
          <SButton
            type="primary"
            :loading="searching"
            :disabled="!keyword.trim()"
            @click="handleSearch"
          >
            <template #icon><IconLucideSearch /></template>
            {{ t("common.search") }}
          </SButton>
        </div>

        <!-- 自定义 URL 输入 -->
        <div class="flex gap-2">
          <SInput v-model="customUrl" :placeholder="t('player.videoBg.urlPlaceholder')" clearable />
          <SButton variant="secondary" :disabled="!customUrl.trim()" @click="handleSaveCustomUrl">
            <template #icon><IconLucideLink /></template>
            {{ t("player.videoBg.useUrl") }}
          </SButton>
        </div>
      </div>

      <!-- 搜索结果列表 -->
      <div v-if="results.length > 0" class="flex max-h-[40vh] flex-col gap-2 overflow-y-auto pr-1">
        <div
          v-for="item in results"
          :key="item.bvid"
          class="flex cursor-pointer items-center gap-3 rounded-xl bg-on-surface/3 p-2.5 transition-colors hover:bg-on-surface/5 border border-solid border-outline-variant/30"
          @click="handleSelect(item)"
        >
          <SImg
            v-if="item.pic"
            :src="item.pic"
            referrerpolicy="no-referrer"
            loading="eager"
            class="h-14 w-24 shrink-0 rounded-lg object-cover bg-on-surface/8"
            alt=""
          />
          <div v-else class="h-14 w-24 shrink-0 rounded-lg bg-on-surface/8" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium text-on-surface">{{ item.title }}</div>
            <div class="mt-0.5 flex items-center gap-2 text-xs text-on-surface-variant">
              <span class="truncate">{{ item.author }}</span>
              <span class="shrink-0">{{ formatDuration(item.duration) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div
        v-else-if="hasSearched && !searching"
        class="py-6 text-center text-sm text-on-surface/50"
      >
        {{ t("player.videoBg.noResults") }}
      </div>

      <div v-else-if="searching" class="py-6 text-center text-sm text-on-surface/50">
        <SLoading class="mx-auto mb-2 block text-2xl text-primary/70" />
        {{ t("common.loading") }}
      </div>
    </div>
  </SDialog>
</template>
