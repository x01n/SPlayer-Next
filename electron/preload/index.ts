import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";
import type { LocaleCode, TaskbarLyricSettings, DesktopLyricSettings, DynamicIslandSettings } from "@shared/types/settings";
import type {
  PluginInfo,
  PluginResolveUrlArgs,
  PluginInvokeMenuArgs,
  PluginMatchLyricArgs,
  PluginMatchCoverArgs,
  PluginPanelShowArgs,
  PluginPanelMessageArgs,
} from "@shared/types/plugin";
import type { HotkeyActionId, HotkeyBinding, HotkeyConflict } from "@shared/types/hotkey";
import type { LoadOptions, Track, TrackSource, PlayerEvent, RepeatMode, ShuffleMode } from "@shared/types/player";
import type { ApiPlatform } from "@shared/types/apis";
import type { ScanProgress } from "@shared/types/library";
import type { StreamingServerConfig } from "@shared/types/streaming";
import type { PlayEventInput, FavoriteEventInput } from "@shared/types/stats";
import type { TagEditRequest } from "@shared/types/tagEditor";
import type { UpdateEvent } from "@shared/types/update";
import type { CloudUploadProgress } from "@shared/types/cloudUpload";
import type { MusicCommentQuery } from "@shared/types/comment";
import type { DownloadRequest, DownloadProgress, DownloadTask } from "@shared/types/download";
import type {
  NowPlayingUpdatePayload,
  NowPlayingSnapshot,
  NowPlayingPositionSync,
  NowPlayingLyricOffsetSync,
} from "@shared/types/nowPlaying";

/** 各 channel 的回调集合，避免 removeAllListeners 导致跨消费者竞态 */
const listenerMap = new Map<string, Set<(_event: Electron.IpcRendererEvent, data: unknown) => void>>();

/** 获取或创建代理 handler */
const getProxyHandler = (channel: string): ((_event: Electron.IpcRendererEvent, data: unknown) => void) => {
  return (_event: Electron.IpcRendererEvent, data: unknown): void => {
    const set = listenerMap.get(channel);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(_event, data);
      } catch (err) {
        console.error(`[preload] handler error on ${channel}:`, err);
      }
    }
  };
};

/** 订阅主进程推送的事件 */
const subscribe = <T>(channel: string, callback: (data: T) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, data: T): void => {
    try {
      const result = callback(data) as unknown;
      if (result instanceof Promise) {
        (result as Promise<unknown>).catch((err) => console.error(`[preload] handler error:`, err));
      }
    } catch (err) {
      console.error(`[preload] handler error:`, err);
    }
  };
  let set = listenerMap.get(channel);
  if (!set) {
    set = new Set();
    listenerMap.set(channel, set);
    ipcRenderer.on(channel, getProxyHandler(channel));
  }
  set.add(handler as (_event: Electron.IpcRendererEvent, data: unknown) => void);
  return () => {
    const currentSet = listenerMap.get(channel);
    if (currentSet) {
      currentSet.delete(handler as (_event: Electron.IpcRendererEvent, data: unknown) => void);
      if (currentSet.size === 0) {
        listenerMap.delete(channel);
        ipcRenderer.removeAllListeners(channel);
      }
    }
  };
};

// 暴露给渲染进程的自定义 API
const api = {
  config: {
    get: (keyPath: string) => ipcRenderer.invoke("config:get", keyPath),
    set: (keyPath: string, value: unknown) => ipcRenderer.invoke("config:set", keyPath, value),
    getAll: () => ipcRenderer.invoke("config:getAll"),
    reset: () => ipcRenderer.invoke("config:reset"),
    replaceAll: (config: unknown) => ipcRenderer.invoke("config:replaceAll", config),
    exportToFile: (
      payload?: unknown,
    ): Promise<{ ok: boolean; reason?: "canceled" | "writeFailed" }> =>
      ipcRenderer.invoke("config:exportToFile", payload),
    importFromFile: (): Promise<
      { ok: true; data: unknown } | { ok: false; reason: "canceled" | "readFailed" | "parseFailed" }
    > => ipcRenderer.invoke("config:importFromFile"),
  },
  player: {
    load: (source: string, options?: LoadOptions) =>
      ipcRenderer.invoke("player:load", source, options ?? {}),
    play: () => ipcRenderer.invoke("player:play"),
    pause: () => ipcRenderer.invoke("player:pause"),
    stop: () => ipcRenderer.invoke("player:stop"),
    seek: (position: number) => ipcRenderer.invoke("player:seek", position),
    setVolume: (volume: number) => ipcRenderer.invoke("player:setVolume", volume),
    getVolume: () => ipcRenderer.invoke("player:getVolume"),
    setFadeDuration: (ms: number) => ipcRenderer.invoke("player:setFadeDuration", ms),
    getFadeDuration: () => ipcRenderer.invoke("player:getFadeDuration"),
    getStatus: () => ipcRenderer.invoke("player:getStatus"),
    getFftData: () => ipcRenderer.invoke("player:getFftData"),
    setFftEnabled: (enabled: boolean) => ipcRenderer.invoke("player:setFftEnabled", enabled),
    setNormalizationEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("player:setNormalizationEnabled", enabled),
    setEqualizerEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("player:setEqualizerEnabled", enabled),
    setEqualizerBands: (gainsDb: number[]) =>
      ipcRenderer.invoke("player:setEqualizerBands", gainsDb),
    setPreampGain: (preampDb: number) => ipcRenderer.invoke("player:setPreampGain", preampDb),
    setSpeed: (speed: number) => ipcRenderer.invoke("player:setSpeed", speed),
    setPitch: (semitones: number) => ipcRenderer.invoke("player:setPitch", semitones),
    setPitchSync: (sync: boolean) => ipcRenderer.invoke("player:setPitchSync", sync),
    reinit: () => ipcRenderer.invoke("player:reinit"),
    getOutputDevices: () => ipcRenderer.invoke("player:getOutputDevices"),
    getDefaultDeviceName: () => ipcRenderer.invoke("player:getDefaultDeviceName"),
    setOutputDevice: (deviceName: string | null) =>
      ipcRenderer.invoke("player:setOutputDevice", deviceName),
    getSelectedDeviceName: () => ipcRenderer.invoke("player:getSelectedDeviceName"),
    getCoverRaw: () => ipcRenderer.invoke("player:getCoverRaw"),
    readLyricFile: (filePath: string) => ipcRenderer.invoke("player:readLyricFile", filePath),
    syncPlayMode: (repeatMode: RepeatMode, shuffleMode: ShuffleMode) =>
      ipcRenderer.send("player:syncPlayMode", repeatMode, shuffleMode),
    syncLikeState: (liked: boolean) => ipcRenderer.send("player:syncLikeState", liked),
    dispatch: (type: string) => ipcRenderer.send("player:dispatch", type),
    onEvent: (callback: (event: PlayerEvent) => void) => subscribe("player:event", callback),
  },
  system: {
    toggleDevTools: () => ipcRenderer.invoke("system:toggleDevTools"),
    showInExplorer: (filePath: string) => ipcRenderer.invoke("system:showInExplorer", filePath),
    openLogsDir: () => ipcRenderer.invoke("system:openLogsDir"),
    setLocale: (locale: LocaleCode) => ipcRenderer.send("system:setLocale", locale),
    focusMainWindow: () => ipcRenderer.invoke("system:focusMainWindow"),
    openSettings: (category?: string, highlight?: string) =>
      ipcRenderer.invoke("system:openSettings", category, highlight),
    onOpenSettings: (callback: (payload: { category?: string; highlight?: string }) => void) =>
      subscribe<{ category?: string; highlight?: string }>("system:openSettings", callback),
    listFonts: () => ipcRenderer.invoke("system:listFonts"),
    fetchRemoteBytes: (url: string) => ipcRenderer.invoke("system:fetchRemoteBytes", url),
    saveFile: (data: ArrayBuffer, fileName: string) =>
      ipcRenderer.invoke("system:saveFile", data, fileName),
    relaunch: () => ipcRenderer.invoke("system:relaunch"),
    onProtocolUrl: (callback: (url: string) => void) =>
      subscribe<string>("protocol:orpheus", callback),
    consumePendingProtocolUrl: (): Promise<string | null> =>
      ipcRenderer.invoke("system:consumePendingProtocolUrl"),
    consumePendingListenTogetherUrl: (): Promise<string | null> =>
      ipcRenderer.invoke("system:consumePendingListenTogetherUrl"),
    onListenTogetherUrl: (callback: (url: string) => void) =>
      subscribe<string>("protocol:listenTogether", callback),
  },
  library: {
    scan: (incremental?: boolean) => ipcRenderer.invoke("library:scan", incremental),
    cancelScan: () => ipcRenderer.invoke("library:cancelScan"),
    getTracks: () => ipcRenderer.invoke("library:getTracks"),
    getAlbums: () => ipcRenderer.invoke("library:getAlbums"),
    getArtists: () => ipcRenderer.invoke("library:getArtists"),
    getAlbumTracks: (albumName: string) => ipcRenderer.invoke("library:getAlbumTracks", albumName),
    getArtistTracks: (artistName: string) =>
      ipcRenderer.invoke("library:getArtistTracks", artistName),
    getTracksByIds: (ids: string[]) => ipcRenderer.invoke("library:getTracksByIds", ids),
    searchTracks: (query: string) => ipcRenderer.invoke("library:searchTracks", query),
    getTrackCount: () => ipcRenderer.invoke("library:getTrackCount"),
    getRandomTrack: () => ipcRenderer.invoke("library:getRandomTrack"),
    getRandomTracks: (limit: number) => ipcRenderer.invoke("library:getRandomTracks", limit),
    isScanning: () => ipcRenderer.invoke("library:isScanning"),
    addScanDir: () => ipcRenderer.invoke("library:addScanDir"),
    removeScanDir: (dir: string) => ipcRenderer.invoke("library:removeScanDir", dir),
    getScanDirs: () => ipcRenderer.invoke("library:getScanDirs"),
    deleteTracks: (paths: string[]) => ipcRenderer.invoke("library:deleteTracks", paths),
    readTags: (path: string) => ipcRenderer.invoke("library:readTags", path),
    writeTags: (edits: TagEditRequest[]) => ipcRenderer.invoke("library:writeTags", edits),
    pickCoverImage: () => ipcRenderer.invoke("library:pickCoverImage"),
    fetchArtistAvatar: (artistName: string) =>
      ipcRenderer.invoke("library:fetchArtistAvatar", artistName),
    prefetchArtistAvatars: (artistNames: string[]) =>
      ipcRenderer.invoke("library:prefetchArtistAvatars", artistNames),
    onScanProgress: (callback: (progress: ScanProgress) => void) =>
      subscribe("library:scanProgress", callback),
  },
  window: {
    toggleDesktopLyric: () => ipcRenderer.invoke("window:toggleDesktopLyric"),
    closeDesktopLyric: () => ipcRenderer.invoke("window:closeDesktopLyric"),
    isDesktopLyricOpen: () => ipcRenderer.invoke("window:isDesktopLyricOpen"),
    onDesktopLyricVisibilityChange: (callback: (open: boolean) => void) =>
      subscribe<boolean>("desktopLyric:visibilityChange", callback),
    toggleDynamicIsland: () => ipcRenderer.invoke("window:toggleDynamicIsland"),
    closeDynamicIsland: () => ipcRenderer.invoke("window:closeDynamicIsland"),
    isDynamicIslandOpen: () => ipcRenderer.invoke("window:isDynamicIslandOpen"),
    onDynamicIslandVisibilityChange: (callback: (open: boolean) => void) =>
      subscribe<boolean>("dynamicIsland:visibilityChange", callback),
    toggleTaskbarLyric: () => ipcRenderer.invoke("window:toggleTaskbarLyric"),
    closeTaskbarLyric: () => ipcRenderer.invoke("window:closeTaskbarLyric"),
    isTaskbarLyricOpen: () => ipcRenderer.invoke("window:isTaskbarLyricOpen"),
    onTaskbarLyricVisibilityChange: (callback: (open: boolean) => void) =>
      subscribe<boolean>("taskbarLyric:visibilityChange", callback),
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggleMaximize"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    onMaximizeChange: (callback: (maximized: boolean) => void) =>
      subscribe<boolean>("window:maximizeChange", callback),
    toggleFullscreen: () => ipcRenderer.send("window:toggleFullscreen"),
    isFullscreen: () => ipcRenderer.invoke("window:isFullscreen"),
    onFullscreenChange: (callback: (fullscreen: boolean) => void) =>
      subscribe<boolean>("window:fullscreenChange", callback),
    hide: () => ipcRenderer.send("window:hide"),
    quit: () => ipcRenderer.send("window:quit"),
  },
  desktopLyric: {
    onConfigChange: (callback: (config: DesktopLyricSettings) => void) =>
      subscribe("desktopLyric:configChange", callback),
    setHeight: (height: number) => ipcRenderer.invoke("desktopLyric:setHeight", height),
    setMouseIgnore: (ignore: boolean) => ipcRenderer.send("desktopLyric:setMouseIgnore", ignore),
    move: (x: number, y: number) => ipcRenderer.send("desktopLyric:move", x, y),
    saveState: () => ipcRenderer.send("desktopLyric:saveState"),
    onCursorInside: (callback: (inside: boolean) => void) =>
      subscribe<boolean>("desktopLyric:cursorInside", callback),
  },
  dynamicIsland: {
    onConfigChange: (callback: (config: DynamicIslandSettings) => void) =>
      subscribe("dynamicIsland:configChange", callback),
    move: (x: number, y: number) => ipcRenderer.send("dynamicIsland:move", x, y),
    saveState: () => ipcRenderer.send("dynamicIsland:saveState"),
    resize: (width: number) => ipcRenderer.send("dynamicIsland:resize", width),
    setHeight: (height: number) => ipcRenderer.send("dynamicIsland:setHeight", height),
    getMode: () => ipcRenderer.invoke("dynamicIsland:getMode"),
    onModeChange: (callback: (mode: "snapped" | "floating") => void) =>
      subscribe<"snapped" | "floating">("dynamicIsland:modeChange", callback),
    onCursorInside: (callback: (inside: boolean) => void) =>
      subscribe<boolean>("dynamicIsland:cursorInside", callback),
  },
  taskbarLyric: {
    onLayout: (
      callback: (data: {
        isCentered: boolean;
        systemType: string;
        isLight: boolean;
        anchor: "left" | "right";
      }) => void,
    ) =>
      subscribe<{
        isCentered: boolean;
        systemType: string;
        isLight: boolean;
        anchor: "left" | "right";
      }>("taskbarLyric:layout", callback),
    onConfigChange: (callback: (config: TaskbarLyricSettings) => void) =>
      subscribe<TaskbarLyricSettings>("taskbarLyric:configChange", callback),
  },
  plugins: {
    list: () => ipcRenderer.invoke("plugin:list"),
    install: (filePath: string) => ipcRenderer.invoke("plugin:install", filePath),
    pickAndInstall: () => ipcRenderer.invoke("plugin:pickAndInstall"),
    installFromUrl: (url: string) => ipcRenderer.invoke("plugin:installFromUrl", url),
    uninstall: (id: string) => ipcRenderer.invoke("plugin:uninstall", id),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("plugin:setEnabled", id, enabled),
    setSetting: (id: string, key: string, value: unknown) =>
      ipcRenderer.invoke("plugin:setSetting", id, key, value),
    checkUpdate: (id: string) => ipcRenderer.invoke("plugin:checkUpdate", id),
    applyUpdate: (id: string) => ipcRenderer.invoke("plugin:applyUpdate", id),
    resolveUrl: (args: PluginResolveUrlArgs) => ipcRenderer.invoke("plugin:resolveUrl", args),
    invokeMenu: (args: PluginInvokeMenuArgs) => ipcRenderer.invoke("plugin:invokeMenu", args),
    matchLyric: (args: PluginMatchLyricArgs) => ipcRenderer.invoke("plugin:matchLyric", args),
    matchCover: (args: PluginMatchCoverArgs) => ipcRenderer.invoke("plugin:matchCover", args),
    market: () => ipcRenderer.invoke("plugin:market"),
    onStatus: (callback: (info: PluginInfo) => void) =>
      subscribe<PluginInfo>("plugin:status", callback),
    showPanel: (args: PluginPanelShowArgs) => ipcRenderer.invoke("plugin:showPanel", args),
    hidePanel: (args: { pluginId: string; panelId: string }) =>
      ipcRenderer.invoke("plugin:hidePanel", args),
    closePanel: (args: { pluginId: string; panelId: string }) =>
      ipcRenderer.invoke("plugin:closePanel", args),
    postPanelMessage: (args: PluginPanelMessageArgs) =>
      ipcRenderer.invoke("plugin:postPanelMessage", args),
    listPanels: () => ipcRenderer.invoke("plugin:listPanels"),
    onPanelMessage: (callback: (args: PluginPanelMessageArgs) => void) =>
      subscribe<PluginPanelMessageArgs>("plugin:panel-message", callback),
  },
  apis: {
    call: (platform: ApiPlatform, name: string, params?: Record<string, unknown>) =>
      ipcRenderer.invoke("apis:call", platform, name, params ?? {}),
    clearSession: (platform: ApiPlatform) => ipcRenderer.invoke("apis:clearSession", platform),
    openLoginWeb: (platform: ApiPlatform) => ipcRenderer.invoke("apis:openLoginWeb", platform),
    setCookie: (platform: ApiPlatform, cookie: string) =>
      ipcRenderer.invoke("apis:setCookie", platform, cookie),
    qqmusicLogin: () => ipcRenderer.invoke("qqmusic:login"),
    qqmusicLogout: () => ipcRenderer.invoke("qqmusic:logout"),
    qqmusicFetchStatus: () => ipcRenderer.invoke("qqmusic:fetchStatus"),
  },
  qqmusic: {
    /** 打开 QQ 音乐网页登录窗口 */
    login: () => ipcRenderer.invoke("qqmusic:login"),
    /** 退出 QQ 音乐登录 */
    logout: () => ipcRenderer.invoke("qqmusic:logout"),
    /** 获取 QQ 音乐登录状态 */
    getStatus: () => ipcRenderer.invoke("qqmusic:fetchStatus"),
  },
  spotify: {
    login: () => ipcRenderer.invoke("spotify:login"),
    logout: () => ipcRenderer.invoke("spotify:logout"),
    getStatus: () => ipcRenderer.invoke("spotify:fetchStatus"),
  },
  kugou: {
    logout: () => ipcRenderer.invoke("kugou:logout"),
    getStatus: () => ipcRenderer.invoke("kugou:fetchStatus"),
  },
  bilibili: {
    logout: () => ipcRenderer.invoke("bilibili:logout"),
    getStatus: () => ipcRenderer.invoke("bilibili:fetchStatus"),
    qrKey: () => ipcRenderer.invoke("bilibili:qrKey"),
    qrCheck: (key: string) => ipcRenderer.invoke("bilibili:qrCheck", key),
    pwdLogin: (username: string, password: string) =>
      ipcRenderer.invoke("bilibili:pwdLogin", username, password),
    proxy: (path: string, query: string) =>
      ipcRenderer.invoke("bilibili:proxy", path, query),
  },
  cloud: {
    pickSongs: () => ipcRenderer.invoke("cloud:pickSongs"),
    uploadSong: (path: string, uploadId: string) =>
      ipcRenderer.invoke("cloud:uploadSong", path, uploadId),
    onUploadProgress: (callback: (progress: CloudUploadProgress) => void) =>
      subscribe<CloudUploadProgress>("cloud:upload-progress", callback),
  },
  lyrics: {
    matchById: (platform: string, id: string) =>
      ipcRenderer.invoke("lyrics:matchById", platform, id),
    matchByQuery: (platform: string, track: Track) =>
      ipcRenderer.invoke("lyrics:matchByQuery", platform, track),
    searchCandidates: (track: Track) =>
      ipcRenderer.invoke("lyrics:searchCandidates", track),
    commitManualMatch: (commit: { fingerprint: string; platform: string; platformId: string; extra?: unknown }) =>
      ipcRenderer.invoke("lyrics:commitManualMatch", commit),
    fetchTTMLOverlay: (track: Track, platform: string) =>
      ipcRenderer.invoke("lyrics:fetchTTMLOverlay", track, platform),
    matchLocalTTML: (track: Track) => ipcRenderer.invoke("lyrics:matchLocalTTML", track),
    pickLyricRepoDir: () => ipcRenderer.invoke("lyrics:pickLyricRepoDir"),
  },
  comments: {
    sources: () => ipcRenderer.invoke("comments:sources"),
    get: (args: MusicCommentQuery) => ipcRenderer.invoke("comments:get", args),
  },
  download: {
    start: (req: DownloadRequest) => ipcRenderer.invoke("download:start", req),
    cancel: (taskId: string) => ipcRenderer.invoke("download:cancel", taskId),
    retry: (req: DownloadRequest) => ipcRenderer.invoke("download:retry", req),
    remove: (taskId: string) => ipcRenderer.invoke("download:remove", taskId),
    clearFinished: () => ipcRenderer.invoke("download:clearFinished"),
    list: () => ipcRenderer.invoke("download:list"),
    pickDir: () => ipcRenderer.invoke("download:pickDir"),
    getDir: () => ipcRenderer.invoke("download:getDir"),
    resetDir: () => ipcRenderer.invoke("download:resetDir"),
    onProgress: (callback: (data: DownloadProgress) => void) => subscribe("download:progress", callback),
    onState: (callback: (task: DownloadTask) => void) => subscribe("download:state", callback),
  },
  nowPlaying: {
    update: (payload: NowPlayingUpdatePayload) => ipcRenderer.send("nowPlaying:update", payload),
    requestSnapshot: () => ipcRenderer.invoke("nowPlaying:requestSnapshot"),
    setLyricOffset: (trackId: string, offsetMs: number) =>
      ipcRenderer.send("nowPlaying:setLyricOffset", trackId, offsetMs),
    onTrackChange: (callback: (data: { track: Track | null }) => void) =>
      subscribe("nowPlaying:track-change", callback),
    onLyricChange: (callback: (snapshot: NowPlayingSnapshot) => void) =>
      subscribe("nowPlaying:lyric-change", callback),
    onPositionSync: (callback: (data: NowPlayingPositionSync) => void) =>
      subscribe("nowPlaying:position-sync", callback),
    onLyricOffsetChange: (callback: (data: NowPlayingLyricOffsetSync) => void) =>
      subscribe("nowPlaying:lyric-offset-change", callback),
  },
  theme: {
    pickBackgroundImage: (): Promise<string | null> =>
      ipcRenderer.invoke("theme:pickBackgroundImage"),
    pickCustomVideo: (): Promise<string | null> =>
      ipcRenderer.invoke("theme:pickCustomVideo"),
    clearBackgroundImages: (): Promise<void> => ipcRenderer.invoke("theme:clearBackgroundImages"),
  },
  cache: {
    getStats: () => ipcRenderer.invoke("cache:getStats"),
    clear: (id: string) => ipcRenderer.invoke("cache:clear", id),
    clearAllByKind: (kind: "file" | "db") => ipcRenderer.invoke("cache:clearAllByKind", kind),
    getDir: () => ipcRenderer.invoke("cache:getDir"),
    pickDir: () => ipcRenderer.invoke("cache:pickDir"),
    resetDir: () => ipcRenderer.invoke("cache:resetDir"),
    song: {
      lookup: (cacheKey: string): Promise<string | null> =>
        ipcRenderer.invoke("cache:song:lookup", cacheKey),
      fetch: (cacheKey: string, source: TrackSource, streamUrl: string): Promise<string | null> =>
        ipcRenderer.invoke("cache:song:fetch", cacheKey, source, streamUrl),
      cancel: (cacheKey: string): Promise<void> =>
        ipcRenderer.invoke("cache:song:cancel", cacheKey),
    },
  },
  streaming: {
    loadServers: () => ipcRenderer.invoke("streaming:loadServers"),
    saveServers: (payload: {
      servers: StreamingServerConfig[];
      activeServerId: string | null;
    }): Promise<void> => ipcRenderer.invoke("streaming:saveServers", payload),
  },
  lastfm: {
    connect: () => ipcRenderer.invoke("lastfm:connect"),
    cancelConnect: () => ipcRenderer.invoke("lastfm:cancelConnect"),
    disconnect: () => ipcRenderer.invoke("lastfm:disconnect"),
    getStatus: () => ipcRenderer.invoke("lastfm:getStatus"),
    love: (artist: string, track: string, loved: boolean) =>
      ipcRenderer.invoke("lastfm:love", artist, track, loved),
  },
  externalApi: {
    restart: () => ipcRenderer.invoke("externalApi:restart"),
    getStatus: () => ipcRenderer.invoke("externalApi:getStatus"),
  },
  update: {
    check: (manual: boolean) => ipcRenderer.invoke("update:check", manual),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    openDownloadPage: () => ipcRenderer.invoke("update:openDownloadPage"),
    onEvent: (callback: (event: UpdateEvent) => void) => subscribe("update:event", callback),
  },
  stats: {
    recordPlay: (event: PlayEventInput) => ipcRenderer.send("stats:recordPlay", event),
    recordFavorite: (event: FavoriteEventInput) => ipcRenderer.send("stats:recordFavorite", event),
    getStatsSummary: () => ipcRenderer.invoke("stats:getStatsSummary"),
    getTopTracks: (limit: number) => ipcRenderer.invoke("stats:getTopTracks", limit),
  },
  hotkey: {
    getAll: () => ipcRenderer.invoke("hotkey:getAll"),
    set: (id: HotkeyActionId, binding: HotkeyBinding) =>
      ipcRenderer.invoke("hotkey:set", id, binding),
    reset: (id?: HotkeyActionId) => ipcRenderer.invoke("hotkey:reset", id),
    setGlobalEnabled: (enabled: boolean) => ipcRenderer.invoke("hotkey:setGlobalEnabled", enabled),
    probe: (accelerator: string) => ipcRenderer.invoke("hotkey:probe", accelerator),
    getConflicts: () => ipcRenderer.invoke("hotkey:getConflicts"),
    onTrigger: (callback: (id: HotkeyActionId) => void) =>
      subscribe<HotkeyActionId>("hotkey:trigger", callback),
    onConflicts: (callback: (conflicts: HotkeyConflict[]) => void) =>
      subscribe<HotkeyConflict[]>("hotkey:conflicts", callback),
  },
  listenTogether: {
    createRoom: (nickname: string, neteaseUserId?: number, authKey?: string, roomName?: string) =>
      ipcRenderer.invoke("listenTogether:createRoom", nickname, neteaseUserId, authKey, roomName),
    closeRoom: (roomId: string) => ipcRenderer.invoke("listenTogether:closeRoom", roomId),
    getRoom: () => ipcRenderer.invoke("listenTogether:getRoom"),
    getRoomKey: () => ipcRenderer.invoke("listenTogether:getRoomKey"),
    getShareLink: (roomId: string) => ipcRenderer.invoke("listenTogether:getShareLink", roomId),
    getRawShareLink: (roomId: string) =>
      ipcRenderer.invoke("listenTogether:getRawShareLink", roomId),
    isEnabled: () => ipcRenderer.invoke("listenTogether:isEnabled"),
    verifyAuthKey: (key: string) => ipcRenderer.invoke("listenTogether:verifyAuthKey", key),
    kickMember: (roomId: string, memberId: string) =>
      ipcRenderer.invoke("listenTogether:kickMember", roomId, memberId),
    blacklistMember: (roomId: string, memberId: string) =>
      ipcRenderer.invoke("listenTogether:blacklistMember", roomId, memberId),
    decodeInviteCode: (code: string) => ipcRenderer.invoke("listenTogether:decodeInviteCode", code),
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.api = api;
}
