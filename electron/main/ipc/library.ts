import { ipcMain, dialog } from "electron";
import fs from "node:fs/promises";
import { store } from "@main/store";
import {
  getAllTracks,
  searchTracks,
  getTrackCount,
  deleteTracksByDir,
  deleteTracksByPaths,
  getAlbumList,
  getArtistList,
  getAlbumTracks,
  getArtistTracks,
  getTracksByIds,
  getRandomTrack,
  getRandomTracks,
  upsertTracks,
} from "@main/database";
import { startScan, cancelScan, isScanning, scannedToUpsert } from "@main/services/scanner";
import { getEngine } from "@main/services/engine";
import { fetchArtistAvatar, prefetchArtistAvatars } from "@main/apis/musicbrainz";
import { fetchBytes } from "@main/utils/fetchBytes";
import { getCoverCacheDir } from "@main/utils/config";
import { libraryLog } from "@main/utils/logger";
import { t } from "@main/utils/i18n";
import { ErrorCode } from "@shared/types/errors";
import type { JsTagWriteRequest } from "@splayer/audio-engine";
import type { TagEditRequest, TagWriteOutcome } from "@shared/types/tagEditor";

/**
 * 注册音乐库相关 IPC
 */
export const registerLibraryIpc = (): void => {
  // 开始扫描（全量或增量）
  ipcMain.handle("library:scan", (_event, incremental?: boolean) => {
    try {
      const dirs = store.get("library.scanDirs");
      if (!Array.isArray(dirs) || dirs.length === 0) {
        return { success: false, error: ErrorCode.SCAN_NO_DIRS };
      }
      startScan(dirs as string[], incremental ?? true);
      return { success: true };
    } catch (error) {
      libraryLog.error("启动扫描失败:", error);
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 取消扫描
  ipcMain.handle("library:cancelScan", async () => {
    await cancelScan();
    return { success: true };
  });

  // 获取全部曲目
  ipcMain.handle("library:getTracks", () => {
    try {
      return { success: true, data: getAllTracks() };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 获取专辑聚合列表
  ipcMain.handle("library:getAlbums", () => {
    try {
      return { success: true, data: getAlbumList() };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 获取歌手聚合列表
  ipcMain.handle("library:getArtists", () => {
    try {
      return { success: true, data: getArtistList() };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 获取某专辑下的全部曲目
  ipcMain.handle("library:getAlbumTracks", (_event, albumName: string) => {
    try {
      if (typeof albumName !== "string" || albumName.length === 0) {
        return { success: false, error: ErrorCode.UNKNOWN };
      }
      return { success: true, data: getAlbumTracks(albumName) };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 获取某歌手的全部曲目
  ipcMain.handle("library:getArtistTracks", (_event, artistName: string) => {
    try {
      if (typeof artistName !== "string" || artistName.length === 0) {
        return { success: false, error: ErrorCode.UNKNOWN };
      }
      return { success: true, data: getArtistTracks(artistName) };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 按 ID 批量获取曲目
  ipcMain.handle("library:getTracksByIds", (_event, ids: string[]) => {
    try {
      if (!Array.isArray(ids)) {
        return { success: false, error: ErrorCode.UNKNOWN };
      }
      return { success: true, data: getTracksByIds(ids) };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 搜索曲目
  ipcMain.handle("library:searchTracks", (_event, query: string) => {
    try {
      if (typeof query !== "string") {
        return { success: false, error: ErrorCode.UNKNOWN };
      }
      return { success: true, data: searchTracks(query) };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 获取曲目总数
  ipcMain.handle("library:getTrackCount", () => {
    try {
      return { success: true, data: getTrackCount() };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 随机取一首曲目
  ipcMain.handle("library:getRandomTrack", () => {
    try {
      return { success: true, data: getRandomTrack() };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 随机取多首曲目
  ipcMain.handle("library:getRandomTracks", (_event, limit: number) => {
    try {
      if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return { success: false, error: ErrorCode.UNKNOWN };
      }
      return { success: true, data: getRandomTracks(limit) };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 获取扫描状态
  ipcMain.handle("library:isScanning", () => {
    return { success: true, data: isScanning() };
  });

  // 弹出目录选择器，添加扫描目录
  ipcMain.handle("library:addScanDir", async () => {
    const result = await dialog.showOpenDialog({
      title: t("selectMusicFolder"),
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: ErrorCode.SCAN_DIR_NOT_SELECTED };
    }
    const dir = result.filePaths[0];
    const dirs = store.get("library.scanDirs");
    const dirList = Array.isArray(dirs) ? (dirs as string[]) : [];
    if (dirList.includes(dir)) {
      return { success: false, error: ErrorCode.SCAN_DIR_EXISTS };
    }
    dirList.push(dir);
    store.set("library.scanDirs", dirList);
    libraryLog.info(`添加扫描目录: ${dir}`);
    return { success: true, data: dir };
  });

  // 移除扫描目录及其下所有曲目
  ipcMain.handle("library:removeScanDir", async (_event, dir: string) => {
    try {
      if (typeof dir !== "string" || dir.length === 0) {
        return { success: false, error: ErrorCode.UNKNOWN };
      }
      const dirs = store.get("library.scanDirs");
      const dirList = Array.isArray(dirs) ? (dirs as string[]) : [];
      const idx = dirList.indexOf(dir);
      if (idx === -1) {
        return { success: false, error: ErrorCode.SCAN_DIR_NOT_FOUND };
      }
      // 正在扫描时必须先取消
      if (isScanning()) await cancelScan();
      deleteTracksByDir(dir);
      dirList.splice(idx, 1);
      store.set("library.scanDirs", dirList);
      libraryLog.info(`移除扫描目录: ${dir}`);
      return { success: true };
    } catch (_error) {
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 获取已配置的扫描目录列表
  ipcMain.handle("library:getScanDirs", () => {
    const dirs = store.get("library.scanDirs");
    return { success: true, data: Array.isArray(dirs) ? dirs : [] };
  });

  // 获取歌手头像（MusicBrainz + TheAudioDB）
  ipcMain.handle("library:fetchArtistAvatar", async (_event, artistName: string) => {
    try {
      if (typeof artistName !== "string" || artistName.length === 0) {
        return { success: true, data: null };
      }
      const url = await fetchArtistAvatar(artistName);
      return { success: true, data: url };
    } catch (error) {
      libraryLog.error(`获取歌手头像失败 [${artistName}]:`, error);
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 预取歌手头像
  ipcMain.handle("library:prefetchArtistAvatars", async (_event, artistNames: string[]) => {
    try {
      if (!Array.isArray(artistNames) || artistNames.length === 0) {
        return { success: true, data: {} };
      }
      const data = await prefetchArtistAvatars(artistNames);
      return { success: true, data };
    } catch (error) {
      libraryLog.error("预取歌手头像失败:", error);
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });

  // 读取本地文件的可编辑标签
  ipcMain.handle("library:readTags", async (_event, filePath: string) => {
    try {
      if (typeof filePath !== "string" || filePath.length === 0) {
        return { success: false, error: ErrorCode.FILE_NOT_FOUND };
      }
      const tags = await getEngine().readTrackTags(filePath);
      return { success: true, data: tags };
    } catch (error) {
      libraryLog.error(`读取标签失败 [${filePath}]:`, error);
      return { success: false, error: ErrorCode.TAG_READ_FAILED };
    }
  });

  // 批量写入文件标签并写回数据库
  ipcMain.handle("library:writeTags", async (_event, edits: TagEditRequest[]) => {
    try {
      if (!Array.isArray(edits) || edits.length === 0) {
        return { success: false, error: ErrorCode.TAG_WRITE_FAILED };
      }
      const requests: JsTagWriteRequest[] = [];
      // 实际带封面写入的路径集合
      const replacedCovers = new Set<string>();
      for (const edit of edits) {
        try {
          const { coverPath, coverUrl, ...fields } = edit;
          let cover: Buffer | undefined;
          if (coverPath) {
            cover = await fs.readFile(coverPath);
          } else if (coverUrl) {
            cover = (await fetchBytes(coverUrl, { requireImage: true })) ?? undefined;
            if (!cover) libraryLog.warn(`封面下载失败，跳过封面只写文本: ${coverUrl}`);
          }
          if (cover) replacedCovers.add(edit.path);
          requests.push({ ...fields, cover });
        } catch (editErr) {
          libraryLog.warn(`标签写入准备失败: ${edit.path}, 跳过该曲目`, editErr);
        }
      }
      const results = await getEngine().writeTrackTags(requests, getCoverCacheDir());
      // 写回数据库：有封面更新的曲目需要刷新封面缓存 URL（?v=mtime）以触发前端更新
      const upserts = results
        .filter((r) => r.success && r.track)
        .map((r) => {
          const track = r.track!;
          const upsert = scannedToUpsert(track);
          if (upsert.cover && replacedCovers.has(upsert.path)) {
            upsert.cover = `${upsert.cover}?v=${upsert.mtime}`;
          }
          return upsert;
        });
      if (upserts.length > 0) upsertTracks(upserts);

      const tracks = getTracksByIds(upserts.map((u) => u.id));
      const byPath = new Map(tracks.map((t) => [t.path, t]));
      const data: TagWriteOutcome[] = results.map((r) => ({
        path: r.path,
        success: r.success,
        error: r.error ?? undefined,
        track: byPath.get(r.path),
      }));
      libraryLog.info(`标签写入完成: ${upserts.length}/${results.length} 成功`);
      return { success: true, data };
    } catch (error) {
      libraryLog.error("写入标签失败:", error);
      return { success: false, error: ErrorCode.TAG_WRITE_FAILED };
    }
  });

  // 弹出文件选择器，选择封面图片，返回路径与预览 dataUrl
  ipcMain.handle("library:pickCoverImage", async () => {
    const result = await dialog.showOpenDialog({
      title: t("selectCoverImage"),
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: ErrorCode.FILE_NOT_SELECTED };
    }
    try {
      const coverPath = result.filePaths[0];
      const stat = await fs.stat(coverPath);
      // 上限 5MB
      if (stat.size > 5 * 1024 * 1024) {
        return { success: false, error: ErrorCode.TAG_WRITE_FAILED };
      }
      // 预览只回小缩略图
      const data = await fs.readFile(coverPath);
      const thumb = await getEngine().makeImageThumbnail(data, 300);
      const dataUrl = `data:image/jpeg;base64,${Buffer.from(thumb).toString("base64")}`;
      return { success: true, data: { path: coverPath, dataUrl } };
    } catch (error) {
      libraryLog.error("读取封面图片失败:", error);
      return { success: false, error: ErrorCode.TAG_WRITE_FAILED };
    }
  });

  // 删除曲目文件并从数据库移除
  ipcMain.handle("library:deleteTracks", async (_event, paths: string[]) => {
    try {
      if (!Array.isArray(paths) || paths.length === 0) {
        return { success: false, error: ErrorCode.UNKNOWN };
      }
      const failed: string[] = [];
      for (const filePath of paths) {
        try {
          await fs.unlink(filePath);
        } catch {
          failed.push(filePath);
        }
      }
      const deleted = paths.filter((p) => !failed.includes(p));
      if (deleted.length > 0) {
        deleteTracksByPaths(deleted);
      }
      libraryLog.info(`删除 ${deleted.length} 个文件，${failed.length} 个失败`);
      return { success: true, data: { deleted: deleted.length, failed: failed.length } };
    } catch (error) {
      libraryLog.error("批量删除文件失败:", error);
      return { success: false, error: ErrorCode.UNKNOWN };
    }
  });
};
