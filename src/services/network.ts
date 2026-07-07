import { ref } from "vue";

/**
 * 网络质量状态
 */
export type NetworkQuality = "good" | "poor" | "offline";

interface NetworkState {
  online: boolean;
  quality: NetworkQuality;
}

/** 当前网络状态 */
export const networkState = ref<NetworkState>({ online: true, quality: "good" });

/** 上次探测时间戳 */
let lastProbeAt = 0;
/** 是否正在探测中，防止并发 */
let isProbing = false;
/** 等待探测完成的回调队列 */
const probeWaiters: Array<(state: NetworkState) => void> = [];

/** 探测间隔（毫秒） */
const PROBE_INTERVAL_MS = 30_000;
/** 探测超时（毫秒） */
const PROBE_TIMEOUT_MS = 3_000;
/** 判定为网络不好的 RTT 阈值（毫秒） */
const POOR_RTT_THRESHOLD_MS = 1_500;

/**
 * 探测网络质量
 * 使用轻量级 HEAD 请求探测 Bilibili 搜索页（稳定且与本项目相关）
 * @returns 探测到的网络质量
 */
const probeNetworkQuality = async (): Promise<NetworkQuality> => {
  if (!navigator.onLine) return "offline";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = performance.now();
  try {
    await fetch("https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&page_size=1", {
      method: "HEAD",
      signal: controller.signal,
    });
    const rtt = performance.now() - start;
    return rtt > POOR_RTT_THRESHOLD_MS ? "poor" : "good";
  } catch (err) {
    console.warn("[network] probe failed:", err);
    return "offline";
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * 获取当前网络状态
 * 带缓存：30 秒内重复调用直接返回缓存结果；并发调用共享同一次探测
 * @returns 网络状态
 */
export const getNetworkState = async (): Promise<NetworkState> => {
  const now = Date.now();
  if (lastProbeAt !== 0 && now - lastProbeAt < PROBE_INTERVAL_MS) {
    return { ...networkState.value };
  }
  if (isProbing) {
    return new Promise<NetworkState>((resolve) => probeWaiters.push(resolve));
  }
  isProbing = true;
  try {
    const quality = await probeNetworkQuality();
    networkState.value = { online: quality !== "offline", quality };
    lastProbeAt = Date.now();
    const result = { ...networkState.value };
    // 唤醒所有等待者
    while (probeWaiters.length > 0) {
      const waiter = probeWaiters.shift()!;
      waiter(result);
    }
    return result;
  } catch (err) {
    console.warn("[network] getNetworkState failed:", err);
    networkState.value = { online: false, quality: "offline" };
    lastProbeAt = Date.now();
    const result = { ...networkState.value };
    while (probeWaiters.length > 0) {
      const waiter = probeWaiters.shift()!;
      waiter(result);
    }
    return result;
  } finally {
    isProbing = false;
  }
};

/**
 * 强制刷新网络状态
 * 忽略缓存间隔，立即重新探测
 */
export const refreshNetworkState = async (): Promise<NetworkState> => {
  lastProbeAt = 0; // 重置时间戳，让 getNetworkState 重新探测
  return getNetworkState();
};

/**
 * 监听浏览器在线/离线事件，自动更新状态
 * @returns 清理函数，用于移除事件监听
 */
export const startNetworkMonitoring = (): (() => void) => {
  const handleOnline = () => {
    networkState.value.online = true;
    // 恢复在线时立即刷新质量
    void refreshNetworkState();
  };
  const handleOffline = () => {
    networkState.value = { online: false, quality: "offline" };
    lastProbeAt = Date.now(); // 离线状态也视为已探测，避免频繁重试
  };
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  return () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
  };
};
