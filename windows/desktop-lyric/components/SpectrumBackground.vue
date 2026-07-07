<script setup lang="ts">
import { startFftListening, stopFftListening, getFftFrame } from "../composables/useFftData";

interface Props {
  /** 频谱颜色 */
  color?: string;
  /** 高度（px），默认 60 */
  height?: number;
  /** 透明度（0~1），默认 0.6 */
  opacity?: number;
  /** 是否启用 */
  enabled?: boolean;
  /** bar 圆角（px），默认 2 */
  radius?: number;
  /** 是否处于播放状态 */
  playing?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  color: "rgba(255, 255, 255, 0.6)",
  height: 60,
  opacity: 0.6,
  enabled: true,
  radius: 2,
  playing: false,
});

const canvasRef = ref<HTMLCanvasElement | null>(null);

/** 后端推送数据长度 */
const FFT_SIZE = 128;
/** 极低频跳过的段数（噪声多） */
const SKIP_LOW = 8;
/** bar 之间的固定间隙（px） */
const BAR_GAP = 3;
/** 后端推送间隔（ms），用于时间插值 */
const PUSH_INTERVAL = 50;

/** 上一帧推送数据 */
const prev = new Float32Array(FFT_SIZE);
/** 当前帧推送数据 */
const curr = new Float32Array(FFT_SIZE);
/** 实际渲染显示值（经过指数平滑） */
const display = new Float32Array(FFT_SIZE);
/** 上一次推送数据的引用，用于检测新帧到达 */
let lastRef: Float32Array | null = null;
/** 上一次推送到达的时间戳 */
let lastUpdate = 0;

/** 解析后的颜色 */
const resolvedColor = ref("rgba(255, 255, 255, 0.6)");

/** 解析颜色字符串为带透明度的 rgba */
const parseColor = (color: string, opacity: number): string => {
  try {
    const div = document.createElement("div");
    div.style.color = color;
    document.body.appendChild(div);
    const computed = getComputedStyle(div).color;
    document.body.removeChild(div);
    const rgbMatch = computed.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${opacity})`;
    }
  } catch {
    // 解析失败回退
  }
  return `rgba(255, 255, 255, ${opacity})`;
};

watch(
  () => [props.color, props.opacity],
  ([color, opacity]) => {
    resolvedColor.value = parseColor(color as string, opacity as number);
  },
  { immediate: true },
);

/** 调整画布大小 */
const resizeCanvas = (): void => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.parentElement?.clientWidth ?? document.body.clientWidth;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${props.height}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(props.height * dpr);
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

/** 绘制频谱 */
const draw = (): void => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // 检测新帧推送
  const data = getFftFrame();
  if (data !== lastRef) {
    lastRef = data;
    prev.set(curr);
    for (let i = 0; i < FFT_SIZE; i++) curr[i] = data[i] ?? 0;
    lastUpdate = performance.now();
  }

  // 时间插值：在 prev → curr 之间按时间平滑过渡
  const t = Math.min((performance.now() - lastUpdate) / PUSH_INTERVAL, 1);
  // 上行快（响应灵敏），下行慢（视觉柔和）
  const ATTACK = 0.4;
  const DECAY = 0.88;

  for (let i = 0; i < FFT_SIZE; i++) {
    const target = prev[i] + (curr[i] - prev[i]) * t;
    if (target > display[i]) {
      display[i] = display[i] + (target - display[i]) * ATTACK;
    } else {
      display[i] = display[i] * DECAY + target * (1 - DECAY);
    }
  }

  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const usableLen = FFT_SIZE - SKIP_LOW;
  const barWidth = 3;
  const slotWidth = barWidth + BAR_GAP;
  const numBars = Math.floor(cssWidth / 2 / slotWidth);
  if (numBars === 0) return;

  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = resolvedColor.value;

  const halfWidth = cssWidth / 2;
  for (let i = 0; i < numBars; i++) {
    const startBin = SKIP_LOW + Math.floor((i * usableLen) / numBars);
    const endBin = SKIP_LOW + Math.floor(((i + 1) * usableLen) / numBars);
    const lo = Math.max(SKIP_LOW, startBin - 1);
    const hi = Math.min(FFT_SIZE, Math.max(endBin, startBin + 1) + 1);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += display[j];
    const v = sum / (hi - lo);

    const barHeight = v * cssHeight;
    if (barHeight <= 0.5) continue;
    const y = cssHeight - barHeight;
    const xRight = halfWidth + i * slotWidth;
    const xLeft = halfWidth - (i + 1) * slotWidth;
    ctx.beginPath();
    ctx.roundRect(xRight, y, barWidth, barHeight, props.radius);
    ctx.roundRect(xLeft, y, barWidth, barHeight, props.radius);
    ctx.fill();
  }
};

const { resume, pause } = useRafFn(draw, { immediate: false });

let fftAcquired = false;

const startCapture = (): void => {
  if (!fftAcquired) {
    startFftListening();
    fftAcquired = true;
  }
  resume();
};

const stopCapture = (): void => {
  pause();
  if (fftAcquired) {
    stopFftListening();
    fftAcquired = false;
  }
};

watch(
  () => [props.enabled, props.playing],
  ([enabled, playing]) => {
    if (enabled && playing) startCapture();
    else stopCapture();
  },
  { immediate: true },
);

onMounted(() => {
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", resizeCanvas);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  stopCapture();
  prev.fill(0);
  curr.fill(0);
  display.fill(0);
  lastRef = null;
});

const onVisibilityChange = (): void => {
  if (document.hidden) {
    stopCapture();
  } else if (props.enabled && props.playing) {
    startCapture();
  }
};
</script>

<template>
  <div
    class="spectrum-wrapper"
    :style="{ height: `${height}px`, opacity: enabled && playing ? 1 : 0 }"
  >
    <canvas ref="canvasRef" class="spectrum-canvas" />
  </div>
</template>

<style scoped>
.spectrum-wrapper {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  pointer-events: none;
  z-index: 0;
  transition: opacity 0.3s ease;
}
.spectrum-canvas {
  width: 100%;
  height: 100%;
  display: block;
  mask: linear-gradient(
    90deg,
    hsla(0, 0%, 100%, 0) 0,
    hsla(0, 0%, 100%, 0.6) 5%,
    #fff 12%,
    #fff 88%,
    hsla(0, 0%, 100%, 0.6) 95%,
    hsla(0, 0%, 100%, 0)
  );
}
</style>
