import { handleOrpheus } from "@/services/orpheus";

/**
 * 主窗口接入 orpheus 协议唤起
 */
export const useOrpheusProtocol = (): void => {
  let unsubscribe: (() => void) | null = null;
  onMounted(async () => {
    const systemApi = window.api?.system;
    if (!systemApi) return;
    unsubscribe = systemApi.onProtocolUrl(handleOrpheus);
    const pending = await systemApi.consumePendingProtocolUrl();
    if (pending) await handleOrpheus(pending);
  });
  onBeforeUnmount(() => unsubscribe?.());
};
