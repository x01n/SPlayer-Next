# 外部 API（HTTP）

SPlayer-Next 提供一个可选的 HTTP 接口，用于查询播放状态与控制播放。实时状态推送请使用 [WebSocket API](/socket)。

::: warning 默认关闭与鉴权
外部 API 默认关闭，需在「设置 → 外部 API」中开启。服务默认只绑定 `127.0.0.1`；开启「允许局域网访问」后绑定 `0.0.0.0`。

所有 `/api/*` 请求都必须携带 `X-API-Key`，值为设置中的 `externalApi.apiKey`。密钥为空时，网络服务启动会生成 32 字节 base64url 密钥并保存；空密钥不会关闭鉴权。
:::

## 约定

- **基础路径**：`http://127.0.0.1:<port>/api`
- **默认端口**：`14558`（可在设置中修改）
- **鉴权请求头**：`X-API-Key: <externalApi.apiKey>`
- **数据格式**：除 Bilibili 代理外，请求与响应均为 JSON
- **时间单位**：毫秒（ms）
- **成功响应**：控制类接口返回 `{ "ok": true }`
- **未启用**：返回 `403 { "error": "external API disabled" }`
- **密钥错误或缺失**：返回 `403 { "error": "invalid API key" }`
- **参数非法**：返回 `400 { "error": "<原因>" }`

## Bilibili API 代理

`GET /api/bilibili/:path` 也受外部 API 总开关和 `X-API-Key` 保护，只允许代理以下路径：

- `/x/web-interface/search/type`
- `/x/web-interface/view`
- `/x/player/playurl`

代理会透传上游状态码和响应正文，并设置 `content-type`；不允许的路径返回 `404`，上游请求失败返回 `502`。

## 端点总览

| 方法   | 路径               | 说明             |
| ------ | ------------------ | ---------------- |
| `GET`  | `/api/info`        | 应用与连接信息   |
| `GET`  | `/api/status`      | 播放状态         |
| `GET`  | `/api/volume`      | 当前音量         |
| `GET`  | `/api/now-playing` | 当前播放完整快照 |
| `POST` | `/api/play`        | 播放             |
| `POST` | `/api/pause`       | 暂停             |
| `POST` | `/api/stop`        | 停止             |
| `POST` | `/api/next`        | 下一曲           |
| `POST` | `/api/prev`        | 上一曲           |
| `POST` | `/api/seek`        | 跳转到指定位置   |
| `POST` | `/api/volume`      | 设置音量         |

## 状态查询

### 获取应用信息

```
GET /api/info
```

返回应用名称、版本与当前 WebSocket 连接数。

**响应**

```json
{ "name": "SPlayer-Next", "version": "1.0.0", "wsClients": 0 }
```

### 获取播放状态

```
GET /api/status
```

**响应**

```json
{
  "state": "playing",
  "position": 12000,
  "duration": 240000,
  "volume": 1,
  "isFinished": false
}
```

| 字段         | 类型      | 说明                              |
| ------------ | --------- | --------------------------------- |
| `state`      | `string`  | 播放状态（如 `playing`/`paused`） |
| `position`   | `number`  | 当前播放位置（毫秒）              |
| `duration`   | `number`  | 总时长（毫秒）                    |
| `volume`     | `number`  | 音量（0 ~ 1）                     |
| `isFinished` | `boolean` | 当前曲目是否已播放结束            |

### 获取音量

```
GET /api/volume
```

**响应**

```json
{ "volume": 1 }
```

### 获取当前播放快照

```
GET /api/now-playing
```

返回当前曲目的完整快照（曲目信息、歌词等）。

## 播放控制

### 播放

```
POST /api/play
```

**响应**：`{ "ok": true }`

### 暂停

```
POST /api/pause
```

**响应**：`{ "ok": true }`

### 停止

```
POST /api/stop
```

**响应**：`{ "ok": true }`

### 下一曲

```
POST /api/next
```

**响应**：`{ "ok": true }`

### 上一曲

```
POST /api/prev
```

**响应**：`{ "ok": true }`

### 跳转

```
POST /api/seek
```

**请求体**

| 字段         | 类型     | 必填 | 说明                  |
| ------------ | -------- | ---- | --------------------- |
| `positionMs` | `number` | ✅   | 目标位置（毫秒，≥ 0） |

```json
{ "positionMs": 60000 }
```

**响应**：`{ "ok": true }`；参数非法返回 `400`。

### 设置音量

```
POST /api/volume
```

**请求体**

| 字段     | 类型     | 必填 | 说明          |
| -------- | -------- | ---- | ------------- |
| `volume` | `number` | ✅   | 音量（0 ~ 1） |

```json
{ "volume": 0.5 }
```

**响应**：`{ "ok": true }`；参数非法返回 `400`。

## 示例

```bash
# API Key 由设置中的 externalApi.apiKey 提供
API_KEY="<externalApi.apiKey>"

# 查询播放状态
curl http://127.0.0.1:14558/api/status -H "X-API-Key: $API_KEY"

# 播放 / 暂停 / 下一曲
curl -X POST http://127.0.0.1:14558/api/play -H "X-API-Key: $API_KEY"
curl -X POST http://127.0.0.1:14558/api/pause -H "X-API-Key: $API_KEY"
curl -X POST http://127.0.0.1:14558/api/next -H "X-API-Key: $API_KEY"

# 跳转到 1 分钟处
curl -X POST http://127.0.0.1:14558/api/seek \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "positionMs": 60000 }'

# 设置音量为 50%
curl -X POST http://127.0.0.1:14558/api/volume \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "volume": 0.5 }'
```
