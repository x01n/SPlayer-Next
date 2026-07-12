# WebSocket API

WebSocket 接口在 [外部 API](/api) 的基础上提供实时双向通信：既能下发控制命令，也能订阅播放状态推送。

::: warning 默认关闭与鉴权
WebSocket 需要同时开启「外部 API」和「WebSocket」开关。连接 `/ws` 时仍受外部 API 的监听地址与 API Key 鉴权约束。
:::

## 连接

- **地址**：`ws://127.0.0.1:<port>/ws`
- **默认端口**：`14558`（与 HTTP 接口共用）
- **浏览器鉴权**：使用固定子协议 `splayer-auth-v1`，并将 API Key 以 Base64URL 编码后放入 `splayer-key.` 协议项
- **非浏览器鉴权**：可使用 `X-API-Key` 请求头
- **握手失败**：缺少或错误密钥返回 HTTP `403`
- **入站消息上限**：`256 KiB`

浏览器不能自定义 `X-API-Key`，请使用：

```javascript
const apiKey = "<externalApi.apiKey>";
const bytes = new TextEncoder().encode(apiKey);
const encodedKey = btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const ws = new WebSocket("ws://127.0.0.1:14558/ws", [
  "splayer-auth-v1",
  `splayer-key.${encodedKey}`,
]);
```

::: danger 不要回显密钥
服务端只选择并回显固定协议 `splayer-auth-v1`，不会回显 `splayer-key.` 密钥协议项；也不要将密钥写入日志或分享链接。
:::

## 服务器 → 客户端

所有下行消息都带有 `kind` 字段：

| `kind`  | 形态                                  | 说明                               |
| ------- | ------------------------------------- | ---------------------------------- |
| `hello` | `{ "kind": "hello", "clients": N }`   | 连接建立时发送，附当前连接数       |
| `event` | `{ "kind": "event", "type", "data" }` | 播放事件推送（状态、进度、切歌等） |
| `ack`   | `{ "kind": "ack", "op" }`             | 命令执行成功的回执                 |
| `error` | `{ "kind": "error", "op", "error" }`  | 命令失败，`error` 为原因           |

## 客户端 → 服务器

下行命令为 JSON，统一通过 `op` 字段标识：

```json
{ "op": "play" }
```

| `op`        | 附加字段                   | 说明             |
| ----------- | -------------------------- | ---------------- |
| `play`      | —                          | 播放             |
| `pause`     | —                          | 暂停             |
| `stop`      | —                          | 停止             |
| `next`      | —                          | 下一曲           |
| `prev`      | —                          | 上一曲           |
| `seek`      | `{ "positionMs": number }` | 跳转（毫秒，≥0） |
| `setVolume` | `{ "volume": number }`     | 音量（0 ~ 1）    |

非法 JSON 或未知 `op` 会收到 `{ "kind": "error", ... }`。

## 示例

```javascript
const apiKey = "<externalApi.apiKey>";
const bytes = new TextEncoder().encode(apiKey);
const encodedKey = btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const ws = new WebSocket("ws://127.0.0.1:14558/ws", [
  "splayer-auth-v1",
  `splayer-key.${encodedKey}`,
]);

ws.onopen = () => {
  // 暂停播放
  ws.send(JSON.stringify({ op: "pause" }));
  // 跳转到 1 分钟处
  ws.send(JSON.stringify({ op: "seek", positionMs: 60000 }));
};

ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  switch (msg.kind) {
    case "hello":
      console.log("已连接，当前客户端数：", msg.clients);
      break;
    case "event":
      console.log("播放事件：", msg.type, msg.data);
      break;
    case "ack":
      console.log("命令成功：", msg.op);
      break;
    case "error":
      console.warn("命令失败：", msg.op, msg.error);
      break;
  }
};
```
