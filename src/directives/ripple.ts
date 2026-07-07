import type { Directive } from "vue";

/**
 * v-ripple 涟漪指令
 *
 * 用法：
 *   v-ripple          — 启用涟漪
 *   v-ripple="false"  — 禁用
 */

const RIPPLE_HANDLER = Symbol("rippleHandler");
const RIPPLE_ORIGINAL_POSITION = Symbol("rippleOriginalPosition");
const RIPPLE_ORIGINAL_OVERFLOW = Symbol("rippleOriginalOverflow");
const RIPPLE_ACTIVE_SPANS = Symbol("rippleActiveSpans");

interface RippleElement extends HTMLElement {
  [RIPPLE_HANDLER]?: (e: PointerEvent) => void;
  [RIPPLE_ORIGINAL_POSITION]?: string;
  [RIPPLE_ORIGINAL_OVERFLOW]?: string;
  [RIPPLE_ACTIVE_SPANS]?: Set<HTMLElement>;
}

const setupRipple = (el: RippleElement) => {
  if (el[RIPPLE_HANDLER]) return;

  const position = getComputedStyle(el).position;
  el[RIPPLE_ORIGINAL_POSITION] = el.style.position || undefined;
  if (!position || position === "static") {
    el.style.position = "relative";
  }
  el[RIPPLE_ORIGINAL_OVERFLOW] = el.style.overflow || undefined;
  el.style.overflow = "hidden";

  const activeSpans = new Set<HTMLElement>();
  el[RIPPLE_ACTIVE_SPANS] = activeSpans;

  const handler = (e: PointerEvent) => {
    const rect = el.getBoundingClientRect();
    const radius = Math.sqrt(rect.width ** 2 + rect.height ** 2);
    const size = radius * 2;
    const x = e.clientX - rect.left - radius;
    const y = e.clientY - rect.top - radius;

    const ripple = document.createElement("span");
    Object.assign(ripple.style, {
      position: "absolute",
      left: `${x}px`,
      top: `${y}px`,
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: "50%",
      backgroundColor: "currentColor",
      opacity: "0.2",
      transform: "scale(0)",
      pointerEvents: "none",
      transition: "transform 0.8s cubic-bezier(0.2, 0, 0, 1), opacity 0.6s ease",
    });

    el.appendChild(ripple);
    activeSpans.add(ripple);

    requestAnimationFrame(() => {
      ripple.style.transform = "scale(1)";
    });

    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      activeSpans.delete(ripple);
      ripple.style.opacity = "0";

      const onTransitionEnd = () => {
        ripple.remove();
      };
      ripple.addEventListener("transitionend", onTransitionEnd, { once: true });

      // 兜底：若 transitionend 未触发（如元素被隐藏），1s 后强制移除并清理监听器
      setTimeout(() => {
        ripple.removeEventListener("transitionend", onTransitionEnd);
        ripple.remove();
      }, 1000);
    };
    el.addEventListener("pointerup", cleanup, { once: true });
    el.addEventListener("pointerleave", cleanup, { once: true });
    el.addEventListener("pointercancel", cleanup, { once: true });
  };

  el.addEventListener("pointerdown", handler);
  el[RIPPLE_HANDLER] = handler;
};

const teardownRipple = (el: RippleElement) => {
  if (!el[RIPPLE_HANDLER]) return;
  el.removeEventListener("pointerdown", el[RIPPLE_HANDLER]);

  // 清理所有尚未消失的涟漪元素，防止内存泄漏
  const activeSpans = el[RIPPLE_ACTIVE_SPANS];
  if (activeSpans) {
    for (const span of activeSpans) {
      span.remove();
    }
    activeSpans.clear();
  }

  // 恢复原始样式，避免样式泄漏
  if (el[RIPPLE_ORIGINAL_POSITION] !== undefined) {
    el.style.position = el[RIPPLE_ORIGINAL_POSITION];
  } else {
    el.style.removeProperty("position");
  }
  if (el[RIPPLE_ORIGINAL_OVERFLOW] !== undefined) {
    el.style.overflow = el[RIPPLE_ORIGINAL_OVERFLOW];
  } else {
    el.style.removeProperty("overflow");
  }

  delete el[RIPPLE_HANDLER];
  delete el[RIPPLE_ORIGINAL_POSITION];
  delete el[RIPPLE_ORIGINAL_OVERFLOW];
  delete el[RIPPLE_ACTIVE_SPANS];
};

export const vRipple: Directive<RippleElement, boolean | undefined> = {
  mounted(el, binding) {
    if (binding.value !== false) setupRipple(el);
  },
  updated(el, binding) {
    if (binding.value !== false) {
      setupRipple(el);
    } else {
      teardownRipple(el);
    }
  },
  unmounted(el) {
    teardownRipple(el);
  },
};
