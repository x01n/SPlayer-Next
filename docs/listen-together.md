# 一起听协议

一起听是独立于外部控制 API 的房间同步协议。它使用独立的服务器级密钥，不复用 `externalApi.apiKey`。

## 网络入口

| 用途 | 路径 | 鉴权 |
| --- | --- | --- |
| 创建房间 | `POST /listen-together/api/rooms` | 一起听开关 + body 中的 `authKey` |
| 房间连接 | `GET /listen-together/ws` | 一起听开关；加入消息中的 `authKey` 和 `roomKey` |

默认端口为 `14558`。本地监听地址仍由 `externalApi.port` 和 `externalApi.allowLan` 决定；`listenTogether.serverUrl` 只用于邀请链接和客户端连接，不改变本地绑定地址。服务地址可以是 HTTP、HTTPS、带端口或带反向代理路径的地址。

一起听未启用时，上述入口返回 `403`：

```json
{ "error": "Listen Together disabled" }
```

## 密钥与凭据

### 服务器密钥

服务器级密钥存储在 `listenTogether.authKey`：

- 创建房间和加入房间都必须提供。
- 留空时，网络服务启动会生成 32 字节 base64url 随机密钥并保存。
- 不能依赖外部控制 API Key。
- 不写入日志、邀请链接或仓库。

### 房间密钥

创建房间后服务端返回 `roomKey`。房间密钥用于定位并加入指定房间，不应公开发布到日志中。

### 房主令牌

创建房间后服务端返回 `hostToken`。房主异常断线后，使用 `hostToken` 作为加入请求中的 `roomKey` 可恢复房主身份；普通成员使用房间 `roomKey` 加入。

### 会话令牌与消息签名

加入成功后服务端返回会话 `token` 和房间 `cryptoKey`。除 `join`、`leave`、`chunkAck` 外的客户端消息必须携带 `signature`：

```text
signature = SHA-256(JSON.stringify(payload) + cryptoKey).slice(0, 16)
```

结果为十六进制字符串的前 16 个字符。当前协议使用截断 SHA-256，不是 HMAC。服务端先校验消息结构，再校验签名；签名无效返回业务错误，不执行操作。

## 创建房间

请求：

```http
POST /listen-together/api/rooms
Content-Type: application/json
```

```json
{
  "nickname": "房主昵称",
  "neteaseUserId": 123456,
  "authKey": "<listenTogether.authKey>",
  "roomName": "一起听房间"
}
```

字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `nickname` | `string` | 是 | 房主昵称 |
| `neteaseUserId` | `number` | 否 | 网易云用户 ID，用于聊天身份验证 |
| `authKey` | `string` | 是 | 服务器级密钥 |
| `roomName` | `string` | 否 | 房间名称 |

成功响应：

```json
{
  "ok": true,
  "room": {
    "id": "房间 ID",
    "name": "一起听房间",
    "hostId": "房主成员 ID",
    "members": [],
    "state": "waiting",
    "createdAt": 0
  },
  "roomKey": "房间密钥",
  "hostToken": "房主令牌"
}
```

昵称缺失返回 `400`。服务器密钥错误返回 `403`。房间数量达到上限或创建失败返回 `409`。

渲染进程创建本地房间时也使用相同的服务器级密钥校验，并由主进程持有房主身份。

## 邀请链接

邀请链接使用自定义协议：

```text
splayer-listentogether://join/i/{inviteCode}?serverUrl={encodedServerUrl}
```

旧格式仍可解析：

```text
splayer-listentogether://join?serverUrl={serverUrl}&roomId={roomId}&roomKey={roomKey}
```

邀请链接可以包含服务器地址、房间定位信息和房间密钥，但不能包含服务器级长期 `authKey`。如果服务器使用 HTTPS，客户端连接使用对应的 WSS；反向代理路径也必须保留。

## WebSocket 加入

连接：

```text
ws(s)://{serverUrl}/listen-together/ws
```

连接建立后，服务端先发送 `hello`。客户端发送 `join`：

```json
{
  "op": "join",
  "payload": {
    "roomId": "房间 ID",
    "roomKey": "房间密钥或房主令牌",
    "authKey": "<listenTogether.authKey>",
    "nickname": "成员昵称",
    "neteaseUserId": 123456,
    "clientTimestamp": 0
  }
}
```

`join` 不要求消息签名，但必须包含 `roomId`、`roomKey`、`authKey` 和 `nickname`。加入成功后服务端发送 `joined`，其中包含：

- `token`：当前 WebSocket 会话令牌
- `room`：房间状态
- `chatHistory`：聊天历史
- `cryptoKey`：当前房间签名密钥
- `memberId`：当前成员 ID
- `serverTimestamp`：服务端时间戳
- `clientTimestamp`：客户端加入时的时间戳

`leave` 和 `chunkAck` 不要求签名；`leave` 当前不携带 payload。除上述三类消息外，客户端必须在消息顶层携带 `signature`。

## 客户端操作

客户端消息统一使用 `op` 和 `payload`：

| `op` | payload 主要字段 | 说明 |
| --- | --- | --- |
| `join` | `roomId`、`roomKey`、`authKey`、`nickname` | 加入或恢复房主身份 |
| `leave` | 无 | 离开房间；房主主动离开会关闭房间 |
| `sync` | `track`、`position`、`isPlaying` | 同步播放状态 |
| `propose` | `type`、`data` | 发起播放操作提案 |
| `vote` | `proposalId`、`agree` | 对提案投票 |
| `chat` | `content`、`replyTo`、`mentions` | 发送聊天消息 |
| `heartbeat` | `timestamp` | 更新成员活跃时间 |
| `kick` | `memberId` | 房主踢出成员 |
| `blacklist` | `memberId` | 房主拉黑成员 |
| `recall` | `messageId` | 撤回聊天消息 |
| `queue` | `action`、`data` | 修改房间队列 |
| `searchShare` | `platform`、`keyword`、`results` | 共享搜索结果 |
| `reaction` | `emoji` | 发送表情反应 |
| `audioSource` | `trackId`、`sourceType`、`quality`、`platform`、`hasUrl` | 上报音源能力 |
| `chunkAck` | 无 | 确认分片；当前服务端忽略 |

`propose.type` 当前支持：`seek`、`play`、`pause`、`skip`、`prev`、`volume`、`loadTrack`。

`queue.action` 当前支持：`add`、`remove`、`clear`、`reorder`、`move`、`set`。

### 队列权限

普通成员只能执行 `queue` 的 `add` 操作。`remove`、`clear`、`reorder`、`move` 和 `set` 仅房主可以执行。

### 聊天权限

当 `listenTogether.allowAnonymousChat` 关闭时，没有 `neteaseUserId` 的匿名成员不能发送聊天消息。聊天内容长度由服务端现有规则限制为 1 至 10000 个字符。

### 提案与投票

提案必须属于当前房间，并且提案发起者是当前在线成员。投票也必须来自该房间的在线成员。提案过期、已执行或房间不匹配时，服务端不会写入投票。

## 服务端消息

服务端消息统一使用 `kind` 和可选的 `data`：

`hello`、`joined`、`memberJoined`、`memberLeft`、`roomUpdate`、`sync`、`proposal`、`voteUpdate`、`executed`、`chat`、`chatAck`、`error`、`roomClosed`、`kicked`、`blacklisted`、`queueUpdate`、`searchShared`、`reaction`、`audioSourceUpdate`、`bestAudioSource`、`messageRecalled`。

`error` 示例：

```json
{
  "kind": "error",
  "data": { "error": "消息签名无效" }
}
```

`executed` 的 data 使用以下结构，便于客户端消费提案结果：

```json
{
  "proposalId": "提案 ID",
  "result": true,
  "payload": {
    "type": "play",
    "data": {}
  }
}
```

被踢出、拉黑或房间关闭时，服务端发送对应的 `kicked`、`blacklisted` 或 `roomClosed` 消息，并关闭对应连接。

## 房间生命周期与限制

- 每个房间最多 50 人，包含房主。
- 最多保留 64 个活跃房间。
- 房主异常断线后房间保留 30 分钟；期间可使用 `hostToken` 恢复房主身份。
- 所有成员离线后房间最多保留 120 分钟。
- 房主断线保留时间与全员离线保留时间取更早的回收时间。
- 房主主动 `leave` 会立即关闭房间。
- 关闭房间时会断开连接并清理会话、提案、聊天、队列音源和同步定时器。
- WebSocket 服务端单条入站消息最大为 `256 KiB`。

## 安全要求

- 不要将 `listenTogether.authKey`、`roomKey`、`hostToken`、session `token` 或 `cryptoKey` 写入日志。
- 不要把服务器级 `authKey` 放入邀请链接。
- HTTPS/WSS 部署应通过反向代理保护传输链路；服务端地址配置只影响公开地址生成和客户端连接。
- 客户端收到服务端错误后，应停止当前失败操作，不要重复发送未签名或结构不完整的消息。
