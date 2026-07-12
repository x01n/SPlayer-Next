import type { SettingCategory, SettingSection } from "@/types/settings-schema";
import IconLucideUsers from "~icons/lucide/users";

const listenTogetherSection: SettingSection = {
  id: "listenTogether",
  items: [
    {
      key: "listenTogetherEnabled",
      type: "switch",
      binding: { store: "settings", path: "system.listenTogether.enabled" },
      defaultValue: false,
    },
    {
      key: "listenTogetherAuthKey",
      type: "text",
      binding: { store: "settings", path: "system.listenTogether.authKey" },
      defaultValue: "",
    },
    {
      key: "listenTogetherServerUrl",
      type: "text",
      binding: { store: "settings", path: "system.listenTogether.serverUrl" },
      defaultValue: "",
    },
    {
      key: "listenTogetherDefaultRoomName",
      type: "text",
      binding: { store: "settings", path: "system.listenTogether.defaultRoomName" },
      defaultValue: "一起听房间",
    },
    {
      key: "listenTogetherSyncInterval",
      type: "slider",
      binding: { store: "settings", path: "system.listenTogether.syncInterval" },
      min: 1000,
      max: 10000,
      step: 500,
      defaultValue: 8000,
      marks: { 1000: "1s", 3000: "3s", 5000: "5s", 10000: "10s" },
    },
    {
      key: "listenTogetherVoteTimeout",
      type: "slider",
      binding: { store: "settings", path: "system.listenTogether.voteTimeout" },
      min: 2000,
      max: 15000,
      step: 1000,
      defaultValue: 5000,
      marks: { 2000: "2s", 5000: "5s", 10000: "10s", 15000: "15s" },
    },
    {
      key: "listenTogetherAllowAnonymousChat",
      type: "switch",
      binding: { store: "settings", path: "system.listenTogether.allowAnonymousChat" },
      defaultValue: false,
    },
  ],
};

const listenTogetherCategory: SettingCategory = {
  id: "listenTogether",
  icon: IconLucideUsers,
  sections: [listenTogetherSection],
};

export default listenTogetherCategory;
