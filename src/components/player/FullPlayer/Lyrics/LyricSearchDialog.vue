<script setup lang="ts">
import type { Track } from "@shared/types/player";
import type { LyricMatchResult, LyricSearchCandidate } from "@shared/types/lyrics";
import { ALL_PLATFORMS, PLATFORM_SHORT_NAME, type Platform } from "@shared/types/platform";
import { useMediaStore } from "@/stores/media";
import { toast } from "@/composables/useToast";
import { formatTime } from "@/utils/time";

const props = defineProps<{
  /** 弹窗是否打开 */
  open: boolean;
}>();

const emit = defineEmits<{
  /** 弹窗打开状态变化 */
  "update:open": [value: boolean];
  /** 用户点击应用按钮，返回歌词匹配结果 */
  apply: [result: LyricMatchResult];
}>();

const { t } = useI18n();
const media = useMediaStore();

/** 搜索表单：歌名 */
const title = ref("");
/** 搜索表单：歌手 */
const artist = ref("");
/** 当前选中的平台 */
const selectedPlatform = ref<Platform | "all">("all");

/** 搜索中状态 */
const searching = ref(false);
/** 是否已执行过搜索 */
const hasSearched = ref(false);
/** 候选列表 */
const candidates = ref<LyricSearchCandidate[]>([]);
/** 选中候选后获取歌词中 */
const applying = ref(false);

/** 搜索请求竞态 token */
let searchToken = 0;

/** 平台下拉选项 */
const platformOptions = computed(() => [
  { value: "all", label: t("player.lyricSearch.allPlatforms") },
  ...ALL_PLATFORMS.map((p) => ({ value: p, label: PLATFORM_SHORT_NAME[p] })),
]);

/**
 * 打开弹窗时预填当前歌曲信息，并清空上次搜索结果
 */
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const track = media.track;
    title.value = track?.title ?? "";
    artist.value = track?.artists?.map((item) => item.name).join(", ") ?? "";
    selectedPlatform.value = "all";
    searching.value = false;
    hasSearched.value = false;
    candidates.value = [];
    applying.value = false;
  },
);

/**
 * 根据表单构建用于搜索的 Track 元数据
 * @returns 可用于 searchCandidates 的 Track 对象；无当前歌曲时返回 null
 */
const buildSearchTrack = (): Track | null => {
  const track = media.track;
  if (!track) return null;
  const titleValue = title.value.trim();
  const artistValue = artist.value.trim();
  return {
    ...track,
    title: titleValue || track.title,
    artists: artistValue
      ? artistValue
          .split(/[,，]/)
          .map((name) => ({ name: name.trim() }))
          .filter((item) => item.name)
      : track.artists,
  };
};

/**
 * 执行搜索候选
 */
const handleSearch = async (): Promise<void> => {
  const track = buildSearchTrack();
  if (!track) return;
  const myToken = ++searchToken;
  searching.value = true;
  hasSearched.value = false;
  candidates.value = [];
  try {
    const resp = await window.api.lyrics.searchCandidates(track);
    if (myToken !== searchToken) return;
    if (!resp.ok) {
      toast.error(resp.error || t("player.lyricSearch.searchFailed"));
      candidates.value = [];
      return;
    }
    let list = resp.data ?? [];
    if (selectedPlatform.value !== "all") {
      list = list.filter((c) => c.platform === selectedPlatform.value);
    }
    candidates.value = list;
  } catch (err) {
    console.error("[LyricSearchDialog] search failed:", err);
    toast.error(t("player.lyricSearch.searchFailed"));
    candidates.value = [];
  } finally {
    if (myToken === searchToken) {
      searching.value = false;
      hasSearched.value = true;
    }
  }
};

/**
 * 选中候选并获取歌词
 * @param candidate - 选中的候选
 */
const handleSelectCandidate = async (candidate: LyricSearchCandidate): Promise<void> => {
  if (applying.value) return;
  applying.value = true;
  try {
    const id = candidate.platform === "qqmusic" ? candidate.id : candidate.id;
    const resp = await window.api.lyrics.matchById(candidate.platform, id);
    if (!resp.ok || !resp.data) {
      toast.error(t("player.lyricSearch.fetchFailed"));
      return;
    }
    // 写入手动匹配缓存
    const track = media.track;
    if (track) {
      // 使用主进程的 commitManualMatch 写入匹配缓存
      await window.api.lyrics.commitManualMatch({
        fingerprint: buildFingerprint(track),
        platform: candidate.platform,
        platformId: candidate.id,
        extra: candidate.extra,
      });
    }
    emit("apply", resp.data);
    emit("update:open", false);
  } catch (err) {
    console.error("[LyricSearchDialog] apply failed:", err);
    toast.error(t("player.lyricSearch.fetchFailed"));
  } finally {
    applying.value = false;
  }
};

/**
 * 构建指纹（与主进程同规则）
 * @param track - 歌曲信息
 */
const buildFingerprint = (track: Track): string => {
  const normalize = (text: string) =>
    text.toLowerCase().replace(/[、&;，,/|()·・\s\-_'"`~!?？！.。]+/g, "");
  const title = normalize(track.title);
  const artist = normalize(track.artists[0]?.name || "");
  const bucket = track.duration ? Math.round(track.duration / 5000) : 0;
  return `${title}|${artist}|${bucket}`;
};
</script>

<template>
  <SDialog
    :open="open"
    :title="t('player.lyricSearch.title')"
    width="580px"
    @update:open="emit('update:open', $event)"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-3">
        <SInput
          v-model="title"
          :placeholder="t('player.lyricSearch.songNamePlaceholder')"
          clearable
        />
        <SInput
          v-model="artist"
          :placeholder="t('player.lyricSearch.artistPlaceholder')"
          clearable
        />
        <SSelect v-model="selectedPlatform" :options="platformOptions" />
      </div>
      <SButton type="primary" :loading="searching" :disabled="!title.trim()" @click="handleSearch">
        <template #icon><IconLucideSearch /></template>
        {{ t("common.search") }}
      </SButton>

      <!-- 候选列表 -->
      <div v-if="candidates.length > 0" class="flex flex-col gap-2 max-h-[45vh] overflow-y-auto pr-1">
        <div
          v-for="candidate in candidates"
          :key="`${candidate.platform}-${candidate.id}`"
          class="flex items-center gap-3 p-2.5 rounded-xl bg-on-surface/3 border border-solid border-outline-variant/30 cursor-pointer hover:bg-on-surface/6 transition-colors"
          @click="handleSelectCandidate(candidate)"
        >
          <SImg
            :src="candidate.cover"
            class="size-12 shrink-0 rounded-lg overflow-hidden bg-on-surface/5"
          />
          <div class="flex-1 min-w-0 flex flex-col gap-0.5">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium truncate">{{ candidate.title }}</span>
              <span class="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">
                {{ PLATFORM_SHORT_NAME[candidate.platform] }}
              </span>
            </div>
            <div class="flex items-center gap-1 text-xs text-on-surface/60">
              <span class="truncate">{{ candidate.artists.join(" / ") }}</span>
              <template v-if="candidate.album">
                <span class="mx-1">·</span>
                <span class="truncate">{{ candidate.album }}</span>
              </template>
            </div>
          </div>
          <span class="text-xs text-on-surface/50 tabular-nums shrink-0">
            {{ formatTime(candidate.duration ?? 0) }}
          </span>
          <SButton
            type="primary"
            size="small"
            :loading="applying"
            class="shrink-0"
            @click.stop="handleSelectCandidate(candidate)"
          >
            {{ t("player.lyricSearch.apply") }}
          </SButton>
        </div>
      </div>

      <div
        v-else-if="hasSearched && !searching"
        class="text-center text-sm text-on-surface/50 py-8"
      >
        {{ t("player.lyricSearch.noResults") }}
      </div>
    </div>
  </SDialog>
</template>
