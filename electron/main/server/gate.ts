/**
 * 外部 API 门禁中间件
 * - externalApi.enabled   总开关：关闭时 /api/* 与 /ws 全部 403
 * - externalApi.wsEnabled 子开关：关闭时 /ws 单独 403，REST 不受影响
 */

import type { MiddlewareHandler } from "hono";
import { store } from "@main/store";

export const externalControlGate: MiddlewareHandler = async (c, next) => {
  if (!store.get("externalApi.enabled")) {
    return c.json({ error: "external API disabled" }, 403);
  }
  await next();
  return;
};

/** WS 子开关 */
export const wsGate: MiddlewareHandler = async (c, next) => {
  if (!store.get("externalApi.wsEnabled")) {
    return c.json({ error: "WebSocket disabled" }, 403);
  }
  await next();
  return;
};

/** API 密钥鉴权中间件：HTTP 使用 X-API-Key，WebSocket 使用子协议 */
export const apiKeyGate: MiddlewareHandler = async (c, next) => {
  const configuredKey = store.get("externalApi.apiKey");
  const providedKey = c.req.header("X-API-Key") ?? "";
  if (!configuredKey || providedKey !== configuredKey) {
    return c.json({ error: "invalid API key" }, 403);
  }
  await next();
  return;
};

/** 浏览器 WebSocket 鉴权使用的固定子协议 */
export const WS_AUTH_PROTOCOL = "splayer-auth-v1";

const WS_API_KEY_PROTOCOL_PREFIX = "splayer-key.";

/** WebSocket 密钥鉴权中间件：浏览器使用子协议，其他客户端也可使用 X-API-Key */
export const wsApiKeyGate: MiddlewareHandler = async (c, next) => {
  const configuredKey = store.get("externalApi.apiKey");
  const headerKey = c.req.header("X-API-Key");
  const protocols = (c.req.header("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  const encodedKeys = protocols
    .filter((protocol) => protocol.startsWith(WS_API_KEY_PROTOCOL_PREFIX))
    .map((protocol) => protocol.slice(WS_API_KEY_PROTOCOL_PREFIX.length));

  let providedKey = headerKey ?? "";
  if (!headerKey && protocols.includes(WS_AUTH_PROTOCOL) && encodedKeys.length === 1) {
    try {
      const decodedKey = Buffer.from(encodedKeys[0], "base64url").toString("utf8");
      const canonicalKey = Buffer.from(decodedKey, "utf8").toString("base64url");
      if (canonicalKey === encodedKeys[0]) providedKey = decodedKey;
    } catch {
      providedKey = "";
    }
  }

  if (!configuredKey || providedKey !== configuredKey) {
    return c.json({ error: "invalid API key" }, 403);
  }
  await next();
  return;
};

export const listenTogetherGate: MiddlewareHandler = async (c, next) => {
  if (!store.get("listenTogether.enabled")) {
    return c.json({ error: "Listen Together disabled" }, 403);
  }
  await next();
  return;
};
