import { shallowRef } from "vue";
import { acquireFft, releaseFft } from "@/services/fftCapture";

/** 后端推送数据长度 */
const FFT_SIZE = 128;

/** 当前 FFT 数据帧 */
const fftFrame = shallowRef<Float32Array>(new Float32Array(FFT_SIZE));

/** 是否正在监听 */
let isListening = false;

/** 取消订阅函数 */
let unsubEvent: (() => void) | null = null;

/**
 */
const handlePlayerEvent = (event: { type: string; data?: number[] }): void => {
  if (event.type !== "fftData" || !event.data) return;
  const data = event.data;
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
  // 通过引用计数启用后端 FFT 推送，避免一个窗口关闭影响其他窗口
  acquireFft();
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
  releaseFft();
  fftFrame.value = new Float32Array(FFT_SIZE);
};

/**
 * 获取当前 FFT 数据帧
 */
export const getFftFrame = (): Float32Array => fftFrame.value;
