/**
 * 外部 API REST 路由
 * 控制路由：POST，状态查询：GET
 */

import { Hono } from "hono";
import { app as electronApp } from "electron";
import { getPlayer } from "@main/services/engine";
import { getEngine } from "@main/services/engine";
import { toMs } from "@main/utils/time";
import * as nowPlaying from "@main/services/nowPlaying";
import { playerControl } from "@main/services/playerControl";
import { getBilibiliProxyCookie } from "@main/apis/bilibili/auth";
import { getWsClientCount } from "./broadcast";

const BILIBILI_API_BASE = "https://api.bilibili.com";
const BILIBILI_PROXY_PATHS = new Set([
  "/x/web-interface/search/type",
  "/x/web-interface/view",
  "/x/player/playurl",
]);
const BILIBILI_PROXY_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const getBilibiliProxyUrl = (path: string, search: string): string | null => {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!BILIBILI_PROXY_PATHS.has(normalizedPath)) return null;
  return `${BILIBILI_API_BASE}${normalizedPath}${search}`;
};

const getBilibiliProxyHeaders = async (): Promise<Record<string, string>> => {
  const headers = { ...BILIBILI_PROXY_HEADERS };
  const cookie = await getBilibiliProxyCookie();
  if (cookie) headers.Cookie = cookie;
  return headers;
};

export const buildRoutes = (): Hono => {
  const api = new Hono();

  api.get("/info", (c) =>
    c.json({
      name: electronApp.getName(),
      version: electronApp.getVersion(),
      wsClients: getWsClientCount(),
    }),
  );

  api.get("/status", (c) => {
    const raw = getPlayer().getStatus();
    return c.json({
      state: raw.state,
      position: toMs(raw.position),
      duration: toMs(raw.duration),
      volume: raw.volume,
      isFinished: raw.isFinished,
    });
  });

  api.get("/volume", (c) => c.json({ volume: getPlayer().getVolume() }));

  api.get("/bilibili/:path{.+}", async (c) => {
    const targetUrl = getBilibiliProxyUrl(c.req.param("path"), new URL(c.req.url).search);
    if (!targetUrl) return c.json({ error: "Bilibili proxy path not allowed" }, 404);

    try {
      const engine = getEngine();
      const res = await engine.httpGet(targetUrl, await getBilibiliProxyHeaders());
      return new Response(res.body, {
        status: res.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // 当前播放完整快照
  api.get("/now-playing", (c) => c.json(nowPlaying.snapshot()));

  api.post("/play", (c) => {
    playerControl.play();
    return c.json({ ok: true });
  });

  api.post("/pause", (c) => {
    playerControl.pause();
    return c.json({ ok: true });
  });

  api.post("/stop", (c) => {
    playerControl.stop();
    return c.json({ ok: true });
  });

  api.post("/seek", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { positionMs?: number } | null;
    const positionMs = Number(body?.positionMs);
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      return c.json({ error: "positionMs (number, >=0) required" }, 400);
    }
    try {
      await playerControl.seek(positionMs);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    return c.json({ ok: true });
  });

  api.post("/volume", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { volume?: number } | null;
    const volume = Number(body?.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      return c.json({ error: "volume (number, 0..1) required" }, 400);
    }
    playerControl.setVolume(volume);
    return c.json({ ok: true });
  });

  api.post("/next", (c) => {
    playerControl.next();
    return c.json({ ok: true });
  });
  api.post("/prev", (c) => {
    playerControl.prev();
    return c.json({ ok: true });
  });

  return api;
};

/** 构建一起听 REST 路由 */
export const buildListenTogetherRoutes = (): Hono => {
  const api = new Hono();

  api.post("/rooms", async (c) => {
    const { createRoom, verifyAuthKey } = await import("./listenTogether/room");
    const body = (await c.req.json().catch(() => null)) as {
      nickname?: string;
      neteaseUserId?: number;
      authKey?: string;
      roomName?: string;
    } | null;

    if (!body?.nickname) {
      return c.json({ error: "nickname required" }, 400);
    }
    if (!body.authKey || !verifyAuthKey(body.authKey)) {
      return c.json({ error: "invalid authKey" }, 403);
    }

    try {
      const room = createRoom(body.nickname, body.neteaseUserId, body.roomName);
      return c.json({
        ok: true,
        room: {
          id: room.id,
          name: room.name,
          hostId: room.hostId,
          members: room.members,
          state: room.state,
          createdAt: room.createdAt,
        },
        roomKey: room.roomKey,
        hostToken: room.hostToken,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  return api;
};
