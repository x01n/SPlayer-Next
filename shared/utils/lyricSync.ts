import type { LyricLine } from "@shared/types/lyrics";

/**
 * 选出「最新已开始」的行索引（startTime <= time 的最大下标）
 * 下一句一开始就切到下一句，不管上一句是否结束
 * @param lines 歌词行数组
 * @param time 当前播放毫秒
 */
export const pickLatestStartedIndex = (lines: LyricLine[], time: number): number => {
  if (lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].startTime <= time) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // 跳过背景行，往前找最近的主歌词行
  while (result >= 0 && lines[result].isBG) result--;
  return result;
};

/**
 * 提前切到下一行
 * @param lines 歌词行数组
 * @param time 当前播放毫秒
 */
export const pickAdvanceOnEndIndex = (lines: LyricLine[], time: number): number => {
  const idx = pickLatestStartedIndex(lines, time);
  if (idx >= 0 && lines[idx].endTime <= time) {
    // 找到下一个非背景行
    let nextIdx = idx + 1;
    while (nextIdx < lines.length && lines[nextIdx].isBG) nextIdx++;
    if (nextIdx < lines.length && lines[nextIdx].startTime <= time) {
      return nextIdx;
    }
  }
  return idx;
};

/**
 * 选出当前应作为 primary 的行索引
 * @param lines 歌词行数组
 * @param time 当前播放毫秒
 */
export const pickPrimaryIndex = (lines: LyricLine[], time: number): number => {
  if (lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let latest = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].startTime <= time) {
      latest = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (latest < 0) return -1;

  // 跳过背景行，找到 startTime <= time 的最新非背景行
  while (latest >= 0 && lines[latest].isBG) latest--;
  if (latest < 0) return -1;

  // latest 行仍活跃则直接返回，避免重叠时回跳到上一行
  if (time < lines[latest].endTime) return latest;
  // latest 已结束，返回自身（间隙或末行）
  const next = lines[latest + 1];
  if (!next || time < next.startTime) return latest;

  // 时间已越过 latest 的 endTime 且 next 已开始（理论上不应发生，因为 latest 是 startTime <= time 的最大索引）
  return latest;
};

/**
 * 计算单词的逐字扫动进度 [0,1]
 *
 * 含与应用内引擎一致的 preRoll 提前量：每个词在 startTime 之前提前开始扫动，
 * 让相邻词亮区衔接而非硬切，也使外部歌词与应用内的起亮时刻对齐
 *
 * @param word - 单词时间区间
 * @param lineStartTime - 所属行的起始时间（ms），preRoll 不会越过行首
 * @param currentMs - 当前播放毫秒
 * @returns 扫动进度，0 未开始，1 已完成
 */
export const getWordSweepProgress = (
  word: { startTime: number; endTime: number },
  lineStartTime: number,
  currentMs: number,
): number => {
  const wordDuration = Math.abs(word.endTime - word.startTime) || 1;
  const preRoll = Math.min(80, wordDuration * 0.3);
  const adjustedStart = Math.max(lineStartTime, word.startTime - preRoll);
  const adjustedDuration = Math.max(1, word.endTime - adjustedStart);
  return Math.max(0, Math.min(1, (currentMs - adjustedStart) / adjustedDuration));
};

const LAST_LINE_FALLBACK_MS = 8000;

/**
 * 将最后一行无效 endTime 截到曲目时长或 startTime+8s
 * @param lines 歌词行数组
 * @param trackDurationMs 曲目时长 ms
 */
export const clampLastLineEnd = (lines: LyricLine[], trackDurationMs?: number): LyricLine[] => {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1];
  const reasonable =
    typeof trackDurationMs === "number" && trackDurationMs > last.startTime
      ? trackDurationMs
      : last.startTime + LAST_LINE_FALLBACK_MS;
  if (last.endTime <= reasonable) return lines;
  const clamped: LyricLine = {
    ...last,
    endTime: reasonable,
    words: (last.words || []).map((w, i, arr) =>
      i === arr.length - 1 && w.endTime > reasonable ? { ...w, endTime: reasonable } : w,
    ),
  };
  return [...lines.slice(0, -1), clamped];
};
