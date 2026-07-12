/**
 * 外部 API 服务器：HTTP (Hono) + WebSocket
 */

import type { Server } from "node:http";
import os from "node:os";
import { Hono } from "hono";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { store } from "@main/store";
import { serverLog } from "@main/utils/logger";
import type { ExternalApiStatus } from "@shared/types/settings";
import {
  externalControlGate,
  wsGate,
  apiKeyGate,
  wsApiKeyGate,
  listenTogetherGate,
  WS_AUTH_PROTOCOL,
} from "./gate";
import { buildListenTogetherRoutes, buildRoutes } from "./routes";
import { wsHandlers, listenTogetherWsHandlers } from "./ws";

import { randomBytes } from "node:crypto";
let runningServer: Server | null = null;
let runningWss: WebSocketServer | null = null;
let runningPort: number | null = null;
let runningHost: string | null = null;
let runningAllowLan = false;
let lastError: { code: string; message: string } | null = null;

/**
 * 取局域网展示地址，绑定 0.0.0.0 时作为展示给用户的局域网入口
 * 优先常见家用/企业网段：WSL2/Hyper-V 的虚拟交换机常占用 172.x 且排在物理网卡前
 */
const getLanAddress = (): string | null => {
  const candidates: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) candidates.push(item.address);
    }
  }
  return (
    candidates.find((address) => address.startsWith("192.168.")) ??
    candidates.find((address) => address.startsWith("10.")) ??
    candidates[0] ??
    null
  );
};

export const getServerStatus = (): ExternalApiStatus => ({
  listening: runningServer !== null,
  allowLan: runningAllowLan,
  host: runningHost,
  port: runningPort,
  error: lastError,
});

/** 启动外部 API 服务 */
export const ensureServerAuthKeys = (): void => {
  if (!store.get("externalApi.apiKey")) {
    store.set("externalApi.apiKey", randomBytes(32).toString("base64url"));
    serverLog.info("已生成外部 API 鉴权密钥");
  }
  if (!store.get("listenTogether.authKey")) {
    store.set("listenTogether.authKey", randomBytes(32).toString("base64url"));
    serverLog.info("已生成一起听服务器鉴权密钥");
  }
};

export const startServer = (): Promise<ExternalApiStatus> => {
  return new Promise((resolve) => {
    if (runningServer) {
      resolve(getServerStatus());
      return;
    }
    const externalApiEnabled = store.get("externalApi.enabled");
    const listenTogetherEnabled = store.get("listenTogether.enabled");
    if (!externalApiEnabled && !listenTogetherEnabled) {
      resolve(getServerStatus());
      return;
    }

    ensureServerAuthKeys();

    const port = store.get("externalApi.port");
    const hostname = store.get("externalApi.allowLan") ? "0.0.0.0" : "127.0.0.1";

    const app = new Hono();
    app.use("/api/*", externalControlGate, apiKeyGate);
    app.route("/api", buildRoutes());
    app.use("/listen-together/api/*", listenTogetherGate);
    app.route("/listen-together/api", buildListenTogetherRoutes());
    app.get(
      "/ws",
      externalControlGate,
      wsGate,
      wsApiKeyGate,
      upgradeWebSocket(() => wsHandlers),
    );
    app.get(
      "/listen-together/ws",
      listenTogetherGate,
      upgradeWebSocket(() => listenTogetherWsHandlers),
    );
    app.get("/", (c) => c.text("SPlayer Next network service"));

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 256 * 1024,
      handleProtocols: (protocols) =>
        protocols.has(WS_AUTH_PROTOCOL) ? WS_AUTH_PROTOCOL : false,
    });
    let settled = false;

    const server = serve({
      fetch: app.fetch,
      port,
      hostname,
      websocket: { server: wss },
    }) as Server;

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      const error = { code: err.code ?? "UNKNOWN", message: err.message };
      serverLog.error(`网络服务监听 ${port} 失败 (${error.code}): ${error.message}`);
      wss.close();
      try {
        server.close();
      } catch {
        // server.close 在 listen 失败的情况下可能抛 ERR_SERVER_NOT_RUNNING，忽略
      }
      runningServer = null;
      runningWss = null;
      runningPort = null;
      runningHost = null;
      runningAllowLan = false;
      lastError = error;
      resolve(getServerStatus());
    });

    server.once("listening", () => {
      if (settled) return;
      settled = true;
      runningServer = server;
      runningWss = wss;
      runningPort = port;
      runningAllowLan = hostname === "0.0.0.0";
      runningHost = runningAllowLan ? (getLanAddress() ?? "0.0.0.0") : hostname;
      lastError = null;
      serverLog.info(`网络服务已启动: http://${hostname}:${port}`);
      resolve(getServerStatus());
    });
  });
};

/** 停止外部 API 服务 */
export const stopServer = (): Promise<void> => {
  if (!runningServer) return Promise.resolve();
  const server = runningServer;
  const wss = runningWss;
  runningServer = null;
  runningWss = null;
  runningPort = null;
  runningHost = null;
  runningAllowLan = false;
  return new Promise((resolve) => {
    wss?.close();
    server.close((err) => {
      if (err) serverLog.warn("外部 API 关闭异常:", err);
      else serverLog.info("外部 API 已关闭");
      resolve();
    });
  });
};

/** 配置变更后重启服务 */
export const restartServer = async (): Promise<ExternalApiStatus> => {
  await stopServer();
  return startServer();
};
