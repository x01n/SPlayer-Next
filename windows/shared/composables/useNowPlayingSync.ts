import type { Ref, ShallowRef } from "vue";
import type { LyricLine } from "@shared/types/lyrics";
import type { NowPlayingSnapshot } from "@shared/types/nowPlaying";
import type { Track } from "@shared/types/player";
import { clampLastLineEnd } from "@shared/utils/lyricSync";

/** 同步偏差阈值 */
const SYNC_DRIFT_THRESHOLD = 40;
/** 最大允许无同步插值时长（ms），超过则停止插值防止卡顿期间歌词超前 */
const MAX_INTERPOLATION_MS = 800;

/** 提供给逐字高亮的非响应式当前播放时间 */
let currentNowPlayingMs = 0;

export const getNowPlayingCurrentMs = (): number => currentNowPlayingMs;

export interface NowPlayingSyncOptions {
  /** 选择当前主行索引的算法 */
  pickIndex: (lyric: LyricLine[], time: number) => number;
  /** 日志 / 错误前缀 */
  logTag: string;
}

export interface NowPlayingSync {
  track: ShallowRef<Track | null>;
  lyric: ShallowRef<LyricLine[]>;
  playing: Ref<boolean>;
  primaryIndex: Ref<number>;
}

/**
 * 播放状态同步
 * 拉取 / 订阅快照、维护播放锚点、RAF 高频更新 currentMs 与 primaryIndex
 */
export const useNowPlayingSync = (options: NowPlayingSyncOptions): NowPlayingSync => {
  const { pickIndex, logTag } = options;

  const track = shallowRef<Track | null>(null);
  const lyric = shallowRef<LyricLine[]>([]);
  const playing = ref(false);
  const primaryIndex = ref(-1);

  let anchorPos = 0;
  let anchorPerf = 0;
  let anchorInitialized = false;
  let rafId: number | null = null;
  /** 最近一次收到 position-sync 时的 performance.now() */
  let lastSyncReceivePerf = 0;
  /** 当前曲目歌词偏移（ms，正值为歌词提前） */
  let lyricOffsetMs = 0;
  /** 当前播放速度倍率，插值时把墙钟时长换算到源时间 */
  let speed = 1.0;

  const resetAnchor = (positionMs: number, sendTimestamp: number): void => {
    const ipcDelay = Math.max(0, Date.now() - sendTimestamp);
    anchorPos = positionMs + (playing.value ? ipcDelay * speed : 0);
    anchorPerf = performance.now();
    lastSyncReceivePerf = anchorPerf;
    // currentNowPlayingMs 始终是「叠加 offset 后的歌词时间」，与 syncOnce 保持一致
    currentNowPlayingMs = anchorPos + lyricOffsetMs;
    anchorInitialized = true;
  };

  // 倍速变化：先按旧 speed 把锚点推到当前再换挡，避免视觉跳变
  const applySpeed = (nextSpeed: number): void => {
    if (nextSpeed === speed) return;
    if (anchorInitialized && playing.value) {
      anchorPos += (performance.now() - anchorPerf) * speed;
      anchorPerf = performance.now();
    }
    speed = nextSpeed;
  };

  // 仅当与 RAF 插值的偏差超过阈值时才重置锚点，避免每次 5Hz 同步都打断动画
  const applyAnchor = (positionMs: number, sendTimestamp: number, nextSpeed: number): void => {
    applySpeed(nextSpeed);
    if (!anchorInitialized || !playing.value) {
      resetAnchor(positionMs, sendTimestamp);
      return;
    }
    const ipcDelay = Math.max(0, Date.now() - sendTimestamp);
    const candidate = positionMs + ipcDelay * speed;
    const projected = anchorPos + (performance.now() - anchorPerf) * speed;
    const drift = candidate - projected;
    if (Math.abs(drift) > SYNC_DRIFT_THRESHOLD) {
      resetAnchor(positionMs, sendTimestamp);
    } else {
      // 渐进校正锚点，消除微小累积误差（5ms 以上才校正，避免高频抖动）
      if (Math.abs(drift) > 5) {
        anchorPos += drift * 0.3;
        anchorPerf = performance.now();
      }
      lastSyncReceivePerf = performance.now();
    }
  };

  const applySnapshot = (snap: NowPlayingSnapshot): void => {
    track.value = snap.track;
    lyric.value = clampLastLineEnd(snap.lyric, snap.track?.duration);
    playing.value = snap.playing;
    speed = snap.speed;
    lyricOffsetMs = snap.lyricOffsetMs;
    primaryIndex.value = -1;
    resetAnchor(snap.position, snap.sendTimestamp);
  };

  const syncOnce = (): void => {
    const now = performance.now();
    const elapsedSinceSync = now - lastSyncReceivePerf;
    let next: number;
    if (playing.value) {
      const elapsed = now - anchorPerf;
      // 长时间未收到同步时停止插值，避免卡顿期间歌词持续超前
      if (elapsedSinceSync > MAX_INTERPOLATION_MS) {
        next = anchorPos + Math.min(elapsed, MAX_INTERPOLATION_MS) * speed;
      } else {
        next = anchorPos + elapsed * speed;
      }
    } else {
      next = anchorPos;
    }
    currentNowPlayingMs = next + lyricOffsetMs;
    const idx = pickIndex(lyric.value, currentNowPlayingMs);
    if (idx !== primaryIndex.value) primaryIndex.value = idx;
  };

  const tick = (): void => {
    syncOnce();
    rafId = playing.value ? requestAnimationFrame(tick) : null;
  };

  const kickTick = (): void => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(tick);
  };

  const unsubscribers: Array<() => void> = [];

  onMounted(async () => {
    try {
      const snap = await window.api.nowPlaying.requestSnapshot();
      applySnapshot(snap);
    } catch (error) {
      console.error(`[${logTag}] requestSnapshot failed`, error);
    }

    unsubscribers.push(
      window.api.nowPlaying.onLyricChange((snap) => {
        applySnapshot(snap);
        kickTick();
      }),
      window.api.nowPlaying.onPositionSync((data) => {
        playing.value = data.playing;
        applyAnchor(data.position, data.sendTimestamp, data.speed);
        kickTick();
      }),
      window.api.nowPlaying.onLyricOffsetChange(({ offsetMs }) => {
        lyricOffsetMs = offsetMs;
        // 暂停时主动重算一次
        syncOnce();
      }),
    );

    kickTick();
  });

  onBeforeUnmount(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    for (const off of unsubscribers) off();
  });

  return { track, lyric, playing, primaryIndex };
};
