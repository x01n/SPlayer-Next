/**
 * 外部 API 门禁中间件
 * - externalApi.enabled   总开关：关闭时 /api/* 与 /ws 全部 403
 * - externalApi.wsEnabled 子开关：关闭时 /ws 单独 403，REST 不受影响
 */

import type { MiddlewareHandler } from "hono";
import { store } from "@main/store";

/** 总开关 */
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

/** API 密钥鉴权中间件：校验 X-API-Key 请求头或 api_key 查询参数 */
export const apiKeyGate: MiddlewareHandler = async (c, next) => {
  const configuredKey = store.get("externalApi.apiKey");
  // 未配置密钥时放行（向后兼容）
  if (!configuredKey) {
    await next();
    return;
  }
  const providedKey =
    c.req.header("X-API-Key") ?? c.req.query("api_key") ?? "";
  if (providedKey !== configuredKey) {
    return c.json({ error: "invalid API key" }, 403);
  }
  await next();
  return;
};
