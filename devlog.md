# SPlayer-Next 拓展开发日志

## 2026-07-04

### 已完成

#### 插件系统扩展
- 新增插件类型：`panel`（面板窗口）、`service`（后台服务）
- 新增插件权限：`fs:read`、`fs:write`、`http:external`、`ui:panel`、`native:audio`
- 新增设置类型：`textarea`、`color`、`password`、`slider`
- 新增面板窗口管理：`electron/main/plugins/panel.ts`
- 扩展 IPC 通信：面板消息广播、双向通信
- 扩展 Store：panelPlugins computed 属性
- 扩展 UI：PluginSettingsForm.vue 支持新设置类型渲染
- 修复 SCombobox.vue：支持 fallback-option 显示选项中不存在的值
- 修复 FontConfig.vue：自定义字体输入别名匹配问题
- 修改文件：15+ 个文件，约 580 行新增/修改代码
- 验证：`pnpm typecheck` 通过

#### 一起听功能拓展
- 扩展类型定义：`ListenTogetherQueueItem`、`ListenTogetherQueueAction`、`ListenTogetherSearchShare`、`ListenTogetherReaction`
- 扩展 `ListenTogetherRoom`：新增 `queue` 字段
- 扩展 WS 协议：`queue`/`searchShare`/`reaction` 客户端操作，`queueUpdate`/`searchShared`/`reaction` 服务端广播
- 客户端服务：`sendQueue`/`sendSearchShare`/`sendReaction` 发送方法，`onQueueUpdate`/`onSearchShared`/`onReaction` 订阅方法
- Store：新增 `queue`/`searchShares`/`reactions` 状态，`sendQueueAction`/`sendSearchShare`/`sendReaction` 方法
- 服务端处理器：`handleQueue`/`handleSearchShare`/`handleReaction`
- 房间管理：`applyQueueAction` 支持 add/remove/clear/reorder/set 操作
- 验证：`pnpm typecheck` 通过

#### Spotify 音源支持
- 新增渲染端 Proxy：`src/apis/spotify.ts`、`src/apis/search/spotify.ts`、`src/apis/song/spotify.ts`
- 新增主进程实现：`electron/main/apis/spotify/`（index/auth/search/song/modules）
- 新增歌词匹配：`electron/main/apis/common/lyric/spotify.ts`（空实现）
- 扩展类型定义：`shared/types/platform.ts`、`shared/types/apis.ts`
- 扩展搜索分发：`src/apis/search/index.ts`
- 扩展 URL 解析：`src/services/audioSource.ts`
- 扩展歌词格式：`src/services/lyricLoader.ts`
- 扩展 IPC 分发：`electron/main/ipc/apis.ts`、`electron/main/ipc/lyrics.ts`
- OAuth Client Credentials Flow 认证（从设置读取 clientId/clientSecret）
- 验证：`pnpm typecheck` 通过

### 待验证
- 插件面板功能实际运行测试（仅通过 typecheck，未运行 Electron）
- 一起听队列同步的实际 WS 通信测试
- Spotify 搜索 API 的实际调用测试（需要 Client ID/Secret）

### 修改文件统计
- 新建文件：约 10 个
- 修改文件：约 20 个
- 删除/修复：清理多处重复定义导致的语法错误
- 全部通过 `pnpm typecheck`（node + web 两端）
