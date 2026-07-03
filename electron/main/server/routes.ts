/**
 * 外部 API REST 路由
 * 控制路由：POST，状态查询：GET
 */

import { Hono } from "hono";
import { app as electronApp } from "electron";
import { getPlayer } from "@main/services/engine";
import { toMs } from "@main/utils/time";
import * as nowPlaying from "@main/services/nowPlaying";
import { playerControl } from "@main/services/playerControl";
import { store } from "@main/store";
import { getWsClientCount } from "./broadcast";

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

  // 一起听路由
  api.post("/listen-together/rooms", async (c) => {
    const { isListenTogetherEnabled, createRoom } = await import("./listenTogether/room");
    if (!isListenTogetherEnabled()) {
      return c.json({ error: "一起听功能未启用" }, 403);
    }

    const body = (await c.req.json().catch(() => null)) as {
      nickname?: string;
      neteaseUserId?: number;
      authKey?: string;
    } | null;

    if (!body?.nickname) {
      return c.json({ error: "nickname required" }, 400);
    }

    // 校验一起听鉴权密钥
    const configuredAuthKey = store.get("listenTogether.authKey");
    if (configuredAuthKey && body.authKey !== configuredAuthKey) {
      return c.json({ error: "invalid authKey" }, 403);
    }

    const room = createRoom(body.nickname, body.neteaseUserId);
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
    });
  });

  api.get("/listen-together/rooms/:roomId", async (c) => {
    const { getRoom } = await import("./listenTogether/room");
    const roomId = c.req.param("roomId");
    const room = getRoom(roomId);
    if (!room) return c.json({ error: "房间不存在" }, 404);

    return c.json({
      id: room.id,
      name: room.name,
      hostId: room.hostId,
      memberCount: room.members.length,
      state: room.state,
      currentTrack: room.currentTrack,
      createdAt: room.createdAt,
    });
  });

  api.post("/listen-together/rooms/:roomId/join", async (c) => {
    const { joinRoom } = await import("./listenTogether/room");
    const roomId = c.req.param("roomId");
    const body = (await c.req.json().catch(() => null)) as {
      roomKey?: string;
      nickname?: string;
      neteaseUserId?: number;
    } | null;

    if (!body?.roomKey || !body?.nickname) {
      return c.json({ error: "roomKey and nickname required" }, 400);
    }

    const result = joinRoom(roomId, body.roomKey, body.nickname, body.neteaseUserId);
    if (!result.ok) {
      return c.json({ error: result.error }, 403);
    }

    return c.json({
      ok: true,
      token: result.token,
      room: result.room,
    });
  });

  return api;
};
