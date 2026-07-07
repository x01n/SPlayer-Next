/**
 * 一起听协议URL处理组合式函数
 * 在应用挂载后监听一起听协议唤起事件
 */

import { onMounted, onBeforeUnmount } from "vue";
import { handleListenTogetherUrl } from "@/services/listenTogetherProtocol";

export const useListenTogetherProtocol = (): void => {
  let unsubscribe: (() => void) | null = null;

  onMounted(async () => {
    const systemApi = window.api?.system;
    if (!systemApi) return;
    unsubscribe = systemApi.onListenTogetherUrl(async (url: string) => {
      if (url.startsWith("splayer-listentogether://")) {
        await handleListenTogetherUrl(url);
      }
    });

    const pending = await systemApi.consumePendingListenTogetherUrl();
    if (pending && pending.startsWith("splayer-listentogether://")) {
      await handleListenTogetherUrl(pending);
    }
  });

  onBeforeUnmount(() => unsubscribe?.());
};
