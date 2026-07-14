<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";
import { useThemeStore } from "@/stores/theme";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import {
  getTrackVideoBg,
  refreshTrackVideoBg,
  onTrackVideoBgChange,
  type TrackVideoBgItem,
} from "@/composables/useTrackVideoBg";
import DEFAULT_COVER from "@/assets/images/song.jpg";
import BackgroundRender from "./BackgroundRender.vue";
import { getVideoUrl } from "@/apis/bilibili";

const media = useMediaStore();
const settings = useSettingsStore();
const theme = useThemeStore();
const status = useStatusStore();

const bgType = computed(() => settings.player.playerBgType as string);

/**
 * 背景是否就绪
 * 展开后延迟 500ms 再挂载，收起后延迟 500ms 卸载以释放 WebGL 上下文 / 模糊位图
 */
const bgReady = ref(false);
let bgReadyTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => status.isExpanded,
  (expanded) => {
    clearTimeout(bgReadyTimer);
    if (expanded) {
      // 已就绪（快速收起后又展开）则保留，避免无谓地卸载重建
      if (!bgReady.value) {
        bgReadyTimer = setTimeout(() => {
          bgReady.value = true;
        }, 500);
      }
    } else {
      // 等收起动画结束后再卸载
      bgReadyTimer = setTimeout(() => {
        bgReady.value = false;
      }, 500);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => clearTimeout(bgReadyTimer));

// 流体背景播放态
const bgPlaying = computed(() => {
  if (!status.isExpanded) return false;
  if (!status.isPlaying && settings.player.playerBgFreezeOnPause) return false;
  return true;
});

/** 按歌曲配置的视频背景 */
const trackVideoBg = ref<TrackVideoBgItem | null>(null);

/** track.video 的本地刷新 URL，避免通过 setTrack 触发全局副作用 */
const refreshedTrackVideoUrl = ref<string | null>(null);

/** 当歌曲切换时，异步加载按歌曲配置的视频背景 */
const loadTrackVideoBg = async (trackId: string | undefined): Promise<void> => {
  refreshedTrackVideoUrl.value = null;
  if (!trackId) {
    trackVideoBg.value = null;
    return;
  }
  const result = await getTrackVideoBg(trackId);
  // 丢弃过期的异步结果，避免歌曲快速切换时的竞态
  if (trackId === media.track?.id) {
    trackVideoBg.value = result;
  }
};

watch(
  () => media.track?.id,
  (trackId) => {
    void loadTrackVideoBg(trackId);
  },
  { immediate: true },
);

// 订阅视频背景配置变更，保存/删除后立即刷新（针对当前歌曲）
const unsubscribeVideoBgChange = onTrackVideoBgChange((trackId) => {
  if (trackId === media.track?.id) {
    videoLoadError.value = false;
    videoRetryCount.value = 0;
    void loadTrackVideoBg(trackId);
  }
});

onBeforeUnmount(() => unsubscribeVideoBgChange());

// 实际生效的背景类型，video / customImage / customVideo 无源或加载失败时回退到 blur
const effectiveBgType = computed(() => {
  // 按歌曲单独配置的视频背景优先级最高，无论全局背景类型是否为 video 都应用
  if (trackVideoBg.value?.videoUrl && !videoLoadError.value) {
    return "video";
  }
  if (bgType.value === "video" && !videoLoadError.value && media.track?.video?.url) {
    return "video";
  }
  if (bgType.value === "video") {
    return "blur";
  }
  if (bgType.value === "customImage" && settings.player.playerBgCustomImage) {
    return "customImage";
  }
  if (bgType.value === "customImage") {
    return "blur";
  }
  if (
    bgType.value === "customVideo" &&
    !videoLoadError.value &&
    settings.player.playerBgCustomVideo
  ) {
    return "customVideo";
  }
  if (bgType.value === "customVideo") {
    return "blur";
  }
  return bgType.value;
});

const videoRef = ref<HTMLVideoElement | null>(null);
const videoLoaded = ref(false);
const pageVisible = ref(!document.hidden);
const reduceMotion = ref(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

/** 视频加载失败标记，失败时回退到模糊背景 */
const videoLoadError = ref(false);

/** 视频重试次数，限制重新解析次数避免无限循环 */
const videoRetryCount = ref(0);

/** 处理视频加载错误，Bilibili 来源 URL 过期时尝试重新解析 */
const onVideoError = async (event: Event) => {
  videoLoaded.value = false;
  const failedUrl = (event.currentTarget as HTMLVideoElement | null)?.currentSrc || videoSrc.value;
  const failedTrackVideoBg =
    trackVideoBg.value?.source === "bilibili" && trackVideoBg.value.videoUrl === failedUrl;
  const failedTrackVideo =
    media.track?.video?.source === "bilibili" && media.track.video.url === failedUrl;

  if ((failedTrackVideoBg || failedTrackVideo) && videoRetryCount.value < 2) {
    videoRetryCount.value++;
    console.warn("[PlayerBackground] 视频背景 URL 可能已过期，尝试重新解析...");

    let refreshed = false;
    if (failedTrackVideoBg && media.track?.id) {
      const result = await refreshTrackVideoBg(media.track.id);
      if (result) {
        trackVideoBg.value = result;
        refreshed = true;
      }
    } else if (failedTrackVideo && media.track?.video?.bvid && media.track.video.cid) {
      try {
        const newUrl = await getVideoUrl(media.track.video.bvid, media.track.video.cid);
        refreshedTrackVideoUrl.value = newUrl;
        refreshed = true;
      } catch (err) {
        console.warn("[PlayerBackground] 重新解析视频 URL 失败:", err);
      }
    }

    if (!refreshed) {
      videoLoadError.value = true;
      console.warn("[PlayerBackground] 视频背景重新解析失败，回退到模糊背景");
    }
  } else {
    videoLoadError.value = true;
    console.warn("[PlayerBackground] 视频背景加载失败，回退到模糊背景");
  }
};

const configuredVideoSrc = computed(() => {
  // 按歌曲配置的视频背景优先，无论全局背景类型
  if (trackVideoBg.value?.videoUrl) {
    return trackVideoBg.value.videoUrl;
  }
  if (bgType.value === "customVideo") {
    return settings.player.playerBgCustomVideo || "";
  }
  if (bgType.value === "video") {
    return refreshedTrackVideoUrl.value || media.track?.video?.url || "";
  }
  return "";
});

/** 视频源切换时变更 key，强制重建 video 元素以避免残留帧 */
const videoKey = computed(() => configuredVideoSrc.value);

/** 当前视频源地址 */
const videoSrc = computed(() => configuredVideoSrc.value);

// 视频源切换时重置错误标记和重试次数
watch(
  () => configuredVideoSrc.value,
  () => {
    videoLoaded.value = false;
    videoLoadError.value = false;
    videoRetryCount.value = 0;
  },
);

const syncVideoPlayback = () => {
  const video = videoRef.value;
  if (!video) return;

  const active =
    bgReady.value &&
    status.isExpanded &&
    status.isPlaying &&
    pageVisible.value &&
    !reduceMotion.value &&
    (effectiveBgType.value === "video" || effectiveBgType.value === "customVideo");
  if (active) {
    void video.play().catch(() => {});
  } else {
    video.pause();
  }
};

/**
 * 视频进度跟随音频：将音频位置按视频时长取模映射到循环视频
 * 偏差超过阈值（拖动进度条 / 跳曲）时才纠正，避免与视频自然播放抢帧
 */
const VIDEO_SYNC_THRESHOLD_S = 0.6;
const syncVideoProgress = (force = false) => {
  const video = videoRef.value;
  if (!video || !videoLoaded.value) return;
  // 仅按歌曲配置 / MV 类视频跟随进度；自定义氛围视频保持自由循环
  if (effectiveBgType.value !== "video") return;
  const videoDuration = video.duration;
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) return;

  const target = (status.position / 1000) % videoDuration;
  if (force || Math.abs(video.currentTime - target) > VIDEO_SYNC_THRESHOLD_S) {
    try {
      video.currentTime = target;
    } catch {
      // 部分流式视频不支持精确 seek，忽略
    }
  }
};

// 拖动进度条 / 跳曲导致音频位置跳变时，同步视频进度
watch(
  () => status.position,
  () => syncVideoProgress(),
);

// 视频加载完成后立即对齐一次当前进度
watch(videoLoaded, (loaded) => {
  if (loaded) syncVideoProgress(true);
});

const syncPageVisibility = () => {
  pageVisible.value = !document.hidden;
};

const syncReducedMotion = (event: MediaQueryListEvent) => {
  reduceMotion.value = event.matches;
};

onMounted(() => {
  document.addEventListener("visibilitychange", syncPageVisibility);
  reducedMotionQuery.addEventListener("change", syncReducedMotion);
});

watch(
  [
    () => status.isPlaying,
    () => status.isExpanded,
    () => effectiveBgType.value,
    () => bgReady.value,
    pageVisible,
    reduceMotion,
    videoRef,
  ],
  () => nextTick(syncVideoPlayback),
);

// 封面颜色（纯色模式）
const coverColor = computed(() => {
  const hex = theme.coverColor;
  if (!hex || hex.length < 7 || !hex.startsWith("#")) return "20, 20, 28";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return "20, 20, 28";
  return `${r}, ${g}, ${b}`;
});

// 模糊模式：双缓冲层，切歌时交叉淡入淡出
const initialCover = media.track?.cover || media.track?.coverOriginal || DEFAULT_COVER;
const blurLayers = reactive([
  { src: initialCover, active: true },
  { src: "", active: false },
]);
let currentLayerIndex = 0;
let preloadImg: HTMLImageElement | null = null;
let switchToken = 0;

watch(
  [() => media.track?.cover || media.track?.coverOriginal, () => status.isExpanded],
  ([newCover, expanded]) => {
    if (!expanded) return;
    const token = ++switchToken;

    if (preloadImg) {
      preloadImg.src = "";
      preloadImg = null;
    }
    const targetCover = newCover || DEFAULT_COVER;
    // 相同不切换
    if (blurLayers[currentLayerIndex].src === targetCover) return;
    const nextIndex = currentLayerIndex === 0 ? 1 : 0;
    const switchLayer = (src: string) => {
      if (token !== switchToken) return;
      preloadImg = null;
      blurLayers[nextIndex].src = src;
      nextTick(() => {
        if (token !== switchToken) return;
        requestAnimationFrame(() => {
          if (token !== switchToken) return;
          blurLayers[nextIndex].active = true;
          blurLayers[currentLayerIndex].active = false;
          currentLayerIndex = nextIndex;
        });
      });
    };
    const img = new Image();
    preloadImg = img;
    img.src = targetCover;
    img
      .decode()
      .then(() => switchLayer(targetCover))
      .catch(() => switchLayer(DEFAULT_COVER));
  },
);

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", syncPageVisibility);
  reducedMotionQuery.removeEventListener("change", syncReducedMotion);
  videoRef.value?.pause();
  clearTimeout(bgReadyTimer);
  switchToken++;
  if (preloadImg) {
    preloadImg.src = "";
    preloadImg = null;
  }
  blurLayers[0].src = "";
  blurLayers[1].src = "";
});
</script>

<template>
  <!-- 纯色背景 -->
  <div class="absolute inset-0 overflow-hidden -z-1 bg-solid-wrap">
    <div class="color" :style="{ backgroundColor: `rgb(${coverColor})` }" />
  </div>
  <!-- 视频背景（含自定义视频） -->
  <Transition
    v-if="effectiveBgType === 'video' || effectiveBgType === 'customVideo'"
    name="bg-fade"
  >
    <div
      v-if="bgReady && !videoLoadError"
      class="absolute inset-0 overflow-hidden -z-1 bg-video-wrap"
      aria-hidden="true"
    >
      <img
        :src="media.track?.cover || DEFAULT_COVER"
        class="bg-video-poster"
        decoding="async"
        alt=""
      />
      <video
        ref="videoRef"
        :key="videoKey"
        :src="videoSrc"
        muted
        loop
        playsinline
        disablePictureInPicture
        preload="metadata"
        :class="['bg-video', { loaded: videoLoaded }]"
        @canplay="videoLoaded = true"
        @error="onVideoError"
      />
    </div>
  </Transition>
  <!-- 自定义图片背景 -->
  <Transition v-else-if="effectiveBgType === 'customImage'" name="bg-fade">
    <div
      v-if="bgReady"
      class="absolute inset-0 overflow-hidden -z-1 bg-blur-wrap"
      aria-hidden="true"
    >
      <img
        :src="settings.player.playerBgCustomImage || DEFAULT_COVER"
        class="bg-img active"
        decoding="async"
        alt=""
      />
    </div>
  </Transition>
  <!-- 模糊背景 -->
  <Transition v-else-if="effectiveBgType === 'blur'" name="bg-fade">
    <div
      v-if="bgReady"
      class="absolute inset-0 overflow-hidden -z-1 bg-blur-wrap"
      aria-hidden="true"
    >
      <img
        v-for="(layer, index) in blurLayers"
        :key="index"
        :src="layer.src"
        :class="['bg-img', { active: layer.active }]"
        decoding="async"
        alt=""
      />
    </div>
  </Transition>
  <!-- 流体背景 -->
  <Transition v-else-if="effectiveBgType === 'animation'" name="bg-fade">
    <div v-if="bgReady" class="absolute inset-0 overflow-hidden -z-1">
      <BackgroundRender
        :album="media.track?.cover || DEFAULT_COVER"
        :playing="bgPlaying"
        :fps="settings.player.playerBgFps"
        :flow-speed="settings.player.playerBgFlowSpeed"
        :render-scale="settings.player.playerBgRenderScale"
        :has-lyric="media.parsedLyric.length > 0"
        :enable-beat="settings.player.playerBgBeat"
      />
    </div>
  </Transition>
</template>

<style scoped>
/* 纯色模式 */
.bg-solid-wrap {
  background-color: rgb(20, 20, 28);
}

.bg-solid-wrap .color {
  width: 100%;
  height: 100%;
  transition: background-color 0.5s ease;
}

.bg-solid-wrap::after {
  content: "";
  position: absolute;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.5);
}

/* 模糊模式 */
.bg-blur-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
}

.bg-blur-wrap::after {
  content: "";
  position: absolute;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 1;
}

.bg-blur-wrap .bg-img {
  position: absolute;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scale(1.5);
  filter: blur(45px) saturate(1.2);
  opacity: 0;
  transition: opacity 0.5s ease-in-out;
}

.bg-blur-wrap .bg-img.active {
  opacity: 1;
}

/* 流体背景渐入 */
.bg-fade-enter-active {
  transition: opacity 0.8s ease-in-out;
}

.bg-fade-leave-active {
  transition: opacity 0.3s ease-in;
}

.bg-fade-enter-from,
.bg-fade-leave-to {
  opacity: 0;
}

/* 视频背景 */
.bg-video-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
}

.bg-video-wrap::after {
  content: "";
  position: absolute;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.4);
  z-index: 1;
}

.bg-video-wrap .bg-video-poster,
.bg-video-wrap .bg-video {
  position: absolute;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bg-video-wrap .bg-video-poster {
  transform: scale(1.2);
  filter: blur(24px) saturate(1.1);
}

.bg-video-wrap .bg-video {
  opacity: 0;
  transition: opacity 0.35s ease;
}

.bg-video-wrap .bg-video.loaded {
  opacity: 1;
}
</style>
