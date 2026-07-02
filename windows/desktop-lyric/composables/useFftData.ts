import { shallowRef } from "vue";

/** 后端推送数据长度 */
const FFT_SIZE = 128;

/** 当前 FFT 数据帧 */
const fftFrame = shallowRef<Float32Array>(new Float32Array(FFT_SIZE));

/** 上一帧引用，用于检测新帧 */
let lastRef: readonly number[] = [];

/** 是否正在监听 */
let isListening = false;

/** 取消订阅函数 */
let unsubEvent: (() => void) | null = null;

/**
 */
const handlePlayerEvent = (event: { type: string; data?: number[] }): void => {
  if (event.type !== "fftData" || !event.data) return;
  const data = event.data;
  if (data === lastRef) return;
  lastRef = data;
  const frame = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    frame[i] = data[i] ?? 0;
  }
  fftFrame.value = frame;
};

/**
 * 启动 FFT 数据监听
 */
export const startFftListening = (): void => {
  if (isListening) return;
  isListening = true;
  // 启用后端 FFT 推送
  window.api.player.setFftEnabled(true).catch(() => {});
  // 订阅 player 事件
  unsubEvent = window.api.player.onEvent((event: unknown) => {
    const e = event as { type: string; data?: number[] };
    handlePlayerEvent(e);
  });
};

/**
 * 停止 FFT 数据监听
 */
export const stopFftListening = (): void => {
  if (!isListening) return;
  isListening = false;
  unsubEvent?.();
  unsubEvent = null;
  window.api.player.setFftEnabled(false).catch(() => {});
  fftFrame.value.fill(0);
  lastRef = [];
};

/**
 * 获取当前 FFT 数据帧
 */
export const getFftFrame = (): Float32Array => fftFrame.value;
