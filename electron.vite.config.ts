import { resolve } from "path";
import { defineConfig } from "electron-vite";
import type { Plugin, ViteDevServer } from "vite";
import UnoCSS from "unocss/vite";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Icons from "unplugin-icons/vite";
import IconsResolver from "unplugin-icons/resolver";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import RekaResolver from "reka-ui/resolver";
import Components from "unplugin-vue-components/vite";
import pkg from "./package.json" with { type: "json" };

const BILIBILI_PROXY_TARGET = "https://api.bilibili.com";
const BILIBILI_PROXY_PREFIX = "/api/bilibili";
const BILIBILI_PROXY_PATHS = new Set([
  "/x/web-interface/search/type",
  "/x/web-interface/view",
  "/x/player/playurl",
]);
const BILIBILI_PROXY_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};
const BILIBILI_COOKIE_TTL = 30 * 60 * 1000;
let bilibiliAnonymousCookie = "";
let bilibiliAnonymousCookieExpireAt = 0;

const parseBilibiliSetCookie = (cookies: string[]): string =>
  cookies
    .map((item) => item.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");

const getSetCookieHeaders = (headers: Headers): string[] => {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  return withGetSetCookie.getSetCookie?.() ?? [];
};

const getBilibiliAnonymousCookie = async (): Promise<string> => {
  if (bilibiliAnonymousCookie && Date.now() < bilibiliAnonymousCookieExpireAt) {
    return bilibiliAnonymousCookie;
  }

  const res = await fetch("https://search.bilibili.com/all", {
    headers: {
      ...BILIBILI_PROXY_HEADERS,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const cookies = getSetCookieHeaders(res.headers);
  bilibiliAnonymousCookie = parseBilibiliSetCookie(cookies);
  bilibiliAnonymousCookieExpireAt = Date.now() + BILIBILI_COOKIE_TTL;
  return bilibiliAnonymousCookie;
};

const createBilibiliProxyPlugin = (): Plugin => ({
  name: "splayer-bilibili-proxy",
  configureServer(server: ViteDevServer): void {
    server.middlewares.use(BILIBILI_PROXY_PREFIX, async (req, res, next) => {
      const requestUrl = new URL(req.url ?? "", BILIBILI_PROXY_TARGET);
      if (!BILIBILI_PROXY_PATHS.has(requestUrl.pathname)) {
        next();
        return;
      }

      try {
        const cookie = await getBilibiliAnonymousCookie();
        const upstream = await fetch(
          `${BILIBILI_PROXY_TARGET}${requestUrl.pathname}${requestUrl.search}`,
          {
            headers: {
              ...BILIBILI_PROXY_HEADERS,
              ...(cookie ? { Cookie: cookie } : {}),
            },
          },
        );
        const body = Buffer.from(await upstream.arrayBuffer());
        res.statusCode = upstream.status;
        res.statusMessage = upstream.statusText;
        res.setHeader(
          "Content-Type",
          upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
        );
        res.setHeader("Cache-Control", "no-store");
        res.end(body);
      } catch (err) {
        res.statusCode = 502;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
  },
});

export default defineConfig({
  main: {
    publicDir: resolve(__dirname, "public"),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/main/index.ts"),
          // 插件 host worker（utilityProcess 入口，托管所有插件 vm 上下文）
          "host.worker": resolve(__dirname, "electron/main/plugins/host.worker.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@main": resolve(__dirname, "electron/main"),
        "@shared": resolve(__dirname, "shared"),
        "@splayer/audio-engine": resolve(__dirname, "native/audio-engine"),
        "@splayer/media-ctrl": resolve(__dirname, "native/media-ctrl"),
        "@splayer/taskbar-lyric": resolve(__dirname, "native/taskbar-lyric"),
        "@splayer/taskbar-thumbnail": resolve(__dirname, "native/taskbar-thumbnail"),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/preload/index.ts"),
          panel: resolve(__dirname, "electron/preload/panel.ts"),
        },
      },
    },
  },
  renderer: {
    root: ".",
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_REPO_URL__: JSON.stringify(pkg.repository.url),
      __APP_REPO_NAME__: JSON.stringify(pkg.productName),
      __APP_AUTHOR__: JSON.stringify(pkg.author.name),
      __APP_HOMEPAGE__: JSON.stringify(pkg.homepage),
      __APP_AUTHOR_URL__: JSON.stringify(pkg.author.url),
    },
    server: {
      port: 14558,
      watch: {
        ignored: ["**/native/**/target/**"],
      },
    },
    publicDir: resolve(__dirname, "public"),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "index.html"),
          "desktop-lyric": resolve(__dirname, "windows/desktop-lyric/index.html"),
          "dynamic-island": resolve(__dirname, "windows/dynamic-island/index.html"),
          "taskbar-lyric": resolve(__dirname, "windows/taskbar-lyric/index.html"),
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@shared": resolve(__dirname, "shared"),
        "@windows": resolve(__dirname, "windows"),
        "@root": resolve(__dirname),
      },
    },
    plugins: [
      createBilibiliProxyPlugin(),
      vue(),
      UnoCSS(),
      AutoImport({
        imports: ["vue", "pinia", "vue-router", "@vueuse/core", "vue-i18n"],
        eslintrc: {
          enabled: true,
          filepath: "./auto-eslint.mjs",
        },
      }),
      Icons({
        compiler: "vue3",
        scale: 1,
        customCollections: {
          sp: FileSystemIconLoader("./src/assets/icons"),
        },
      }),
      Components({
        dirs: ["src/components"],
        resolvers: [RekaResolver(), IconsResolver({ prefix: "icon", customCollections: ["sp"] })],
      }),
    ],
  },
});
