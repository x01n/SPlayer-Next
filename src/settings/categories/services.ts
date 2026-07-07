import type { SettingCategory } from "@/types/settings-schema";
import ExternalApiPanel from "@/components/settings/custom/ExternalApiPanel.vue";
import LastfmPanel from "@/components/settings/custom/LastfmPanel.vue";
import QQMusicLoginPanel from "@/components/settings/custom/QQMusicLoginPanel.vue";
import SpotifyLoginPanel from "@/components/settings/custom/SpotifyLoginPanel.vue";
import KugouLoginPanel from "@/components/settings/custom/KugouLoginPanel.vue";
import BilibiliLoginPanel from "@/components/settings/custom/BilibiliLoginPanel.vue";
import IconLucideGlobe from "~icons/lucide/globe";

const servicesCategory: SettingCategory = {
  id: "services",
  icon: IconLucideGlobe,
  sections: [
    {
      id: "network",
      items: [
        {
          key: "neteaseRealIp",
          type: "switch",
          binding: { store: "settings", path: "system.neteaseRealIp" },
          defaultValue: false,
        },
      ],
    },
    {
      id: "media",
      items: [
        {
          key: "systemMediaControls",
          type: "switch",
          binding: { store: "settings", path: "system.media.systemMediaControls" },
          defaultValue: true,
        },
      ],
    },
    {
      id: "discord",
      items: [
        {
          key: "discordEnabled",
          type: "switch",
          binding: { store: "settings", path: "system.media.discord.enabled" },
          defaultValue: false,
          children: [
            {
              key: "discordShowWhenPaused",
              type: "switch",
              binding: { store: "settings", path: "system.media.discord.showWhenPaused" },
              defaultValue: false,
            },
            {
              key: "discordDisplayMode",
              type: "select",
              binding: { store: "settings", path: "system.media.discord.displayMode" },
              options: [
                { value: "name", labelKey: "settings.discordDisplayMode.name" },
                { value: "details", labelKey: "settings.discordDisplayMode.details" },
                { value: "state", labelKey: "settings.discordDisplayMode.state" },
              ],
              defaultValue: "name",
            },
          ],
        },
      ],
    },
    {
      id: "lastfm",
      items: [
        {
          key: "lastfmEnabled",
          type: "switch",
          binding: { store: "settings", path: "system.lastfm.enabled" },
          defaultValue: false,
          children: [
            {
              key: "lastfmAccount",
              type: "custom",
              component: LastfmPanel,
              fullWidth: true,
              hideDescription: true,
              keywords: ["settings.lastfm.connect", "settings.lastfm.disconnect"],
            },
            {
              key: "lastfmScrobble",
              type: "switch",
              binding: { store: "settings", path: "system.lastfm.scrobble" },
              defaultValue: true,
            },
            {
              key: "lastfmNowPlaying",
              type: "switch",
              binding: { store: "settings", path: "system.lastfm.nowPlaying" },
              defaultValue: true,
            },
            {
              key: "lastfmLoveSync",
              type: "switch",
              binding: { store: "settings", path: "system.lastfm.loveSync" },
              defaultValue: true,
            },
          ],
        },
      ],
    },
    {
      id: "qqmusic",
      tag: { text: "Beta" },
      items: [
        {
          key: "qqmusicAccount",
          type: "custom",
          component: QQMusicLoginPanel,
          fullWidth: true,
          hideDescription: true,
          keywords: ["settings.qqmusic.connect", "settings.qqmusic.disconnect"],
        },
      ],
    },
    {
      id: "externalApi",
      tag: { text: "Beta" },
      items: [
        {
          key: "externalApiEnabled",
          type: "switch",
          binding: { store: "settings", path: "system.externalApi.enabled" },
          defaultValue: false,
          children: [
            {
              key: "externalApiWs",
              type: "switch",
              binding: { store: "settings", path: "system.externalApi.wsEnabled" },
              defaultValue: false,
            },
            {
              key: "externalApiAllowLan",
              type: "switch",
              binding: { store: "settings", path: "system.externalApi.allowLan" },
              defaultValue: false,
            },
            {
              key: "externalApiPort",
              type: "number",
              binding: { store: "settings", path: "system.externalApi.port" },
              min: 1024,
              max: 65535,
              defaultValue: 14558,
            },
            {
              key: "externalApiApiKey",
              type: "text",
              binding: { store: "settings", path: "system.externalApi.apiKey" },
              defaultValue: "",
            },
            {
              key: "externalApiPanel",
              type: "custom",
              component: ExternalApiPanel,
              fullWidth: true,
              hideDescription: true,
              keywords: ["settings.externalApi.endpoint", "settings.externalApi.restart"],
            },
          ],
        },
      ],
    },
    {
      id: "kugou",
      tag: { text: "Beta" },
      items: [
        {
          key: "kugouAccount",
          type: "custom",
          component: KugouLoginPanel,
          fullWidth: true,
          hideDescription: true,
          keywords: ["settings.kugou.connect", "settings.kugou.disconnect"],
        },
      ],
    },
    {
      id: "bilibili",
      tag: { text: "Beta" },
      items: [
        {
          key: "bilibiliAccount",
          type: "custom",
          component: BilibiliLoginPanel,
          fullWidth: true,
          hideDescription: true,
          keywords: ["settings.bilibili.connect", "settings.bilibili.disconnect"],
        },
        {
          key: "bilibiliHighQualityAudio",
          type: "switch",
          binding: { store: "settings", path: "system.bilibili.highQualityAudio" },
          defaultValue: false,
        },
      ],
    },
    {
      id: "spotify",
      items: [
        {
          key: "spotifyAccount",
          type: "custom",
          component: SpotifyLoginPanel,
          fullWidth: true,
          hideDescription: true,
          keywords: ["settings.spotifyLogin.login", "settings.spotifyLogin.logout"],
        },
        {
          key: "spotifyClientId",
          type: "text",
          binding: { store: "settings", path: "spotify.clientId" },
          defaultValue: "",
          placeholderKey: "settings.spotifyClientId.placeholder",
        },
        {
          key: "spotifyClientSecret",
          type: "text",
          binding: { store: "settings", path: "spotify.clientSecret" },
          defaultValue: "",
          placeholderKey: "settings.spotifyClientSecret.placeholder",
        },
      ],
    },
  ],
};

export default servicesCategory;
