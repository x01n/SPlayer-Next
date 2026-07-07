import { createI18n } from "vue-i18n";
import zhCN from "./locales/zh-CN.json";
import enUS from "./locales/en-US.json";

/** 从 localStorage 读取持久化的语言配置 */
const storedLocale = localStorage.getItem("splayer:locale");
const locale = storedLocale === "en-US" ? "en-US" : "zh-CN";

const i18n = createI18n({
  legacy: false,
  locale,
  fallbackLocale: "en-US",
  messages: {
    "zh-CN": zhCN,
    "en-US": enUS,
  },
});

export default i18n;
