<script setup lang="ts">
import defaultFallback from "@/assets/images/song.jpg";

export interface SImgProps {
  /** 图片地址 */
  src?: string;
  /** 占位图地址 */
  fallback?: string;
  /** alt 文字 */
  alt?: string;
  /** referrer policy */
  referrerpolicy?:
    | ""
    | "no-referrer"
    | "no-referrer-when-downgrade"
    | "origin"
    | "origin-when-cross-origin"
    | "same-origin"
    | "strict-origin"
    | "strict-origin-when-cross-origin"
    | "unsafe-url";
  /** 图片加载策略 */
  loading?: "lazy" | "eager";
}

const props = withDefaults(defineProps<SImgProps>(), {
  fallback: defaultFallback,
  alt: "",
  loading: "lazy",
});

const emit = defineEmits<{
  load: [el: HTMLImageElement];
}>();

const isLoaded = ref(false);

const onLoad = (e: Event) => {
  const target = e.target as HTMLImageElement;
  target.style.opacity = "1";
  isLoaded.value = true;
  emit("load", target);
};

watch(
  () => props.src,
  () => {
    isLoaded.value = false;
  },
);
</script>

<template>
  <div class="relative isolate overflow-hidden">
    <!-- 占位图：封面加载完后淡出移除 -->
    <Transition name="fade">
      <img
        v-if="!isLoaded"
        :src="fallback"
        :alt="alt"
        class="absolute w-full h-full object-cover z-0"
      />
    </Transition>
    <!-- 封面：Transition 控制外层 div 的交叉淡入淡出，img 的 opacity 由 @load 单独控制 -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="src" :key="src" class="absolute inset-0 z-1">
        <img
          :src="src"
          :alt="alt"
          :referrerpolicy="referrerpolicy"
          class="w-full h-full object-cover opacity-0 transition-opacity duration-200"
          decoding="async"
          :loading="loading"
          @load="onLoad"
          @error="isLoaded = false"
        />
      </div>
    </Transition>
  </div>
</template>
