import type { Track, Artist, Album, AudioQuality } from "@shared/types/player";
import type { AlbumSummary, ArtistSummary } from "@shared/types/library";
import { getDb } from "./index";

/** 数据库行类型 */
interface TrackRow {
  id: string;
  path: string;
  title: string;
  track?: number;
  artists: string;
  album: string | null;
  duration: number;
  cover: string | null;
  codec: string | null;
  sample_rate: number | null;
  bit_rate: number | null;
  channels: number | null;
  bits_per_sample: number | null;
  file_size: number;
  file_mtime: number | null;
  file_ctime: number | null;
  scanned_at: number;
}

/**
 * 安全解析 JSON 字符串，失败时返回默认值
 * @param json - JSON 字符串
 * @param defaultValue - 解析失败时的默认值
 * @returns 解析结果或默认值
 */
const safeJsonParse = <T>(json: string, defaultValue: T): T => {
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
};

/** 将数据库行解析为 Track */
const rowToTrack = (row: TrackRow): Track => {
  const quality: AudioQuality | undefined =
    row.codec != null
      ? {
          codec: row.codec,
          sampleRate: row.sample_rate ?? 0,
          bitRate: row.bit_rate ?? 0,
          channels: row.channels ?? 0,
          bitsPerSample: row.bits_per_sample ?? 0,
        }
      : undefined;

  return {
    id: row.id,
    source: "local",
    path: row.path,
    title: row.title,
    track: row.track ?? undefined,
    artists: safeJsonParse<Artist[]>(row.artists, []),
    album: row.album ? safeJsonParse<Album>(row.album, { name: row.album }) : undefined,
    duration: row.duration,
    cover: row.cover ?? undefined,
    fileSize: row.file_size ?? undefined,
    mtime: row.file_mtime ?? undefined,
    ctime: row.file_ctime ?? undefined,
    quality,
  };
};

/** 查询全部曲目 */
export const getAllTracks = (): Track[] => {
  const rows = getDb().prepare("SELECT * FROM tracks").all() as TrackRow[];
  return rows.map(rowToTrack);
};

/** 获取曲目总数 */
export const getTrackCount = (): number => {
  const row = getDb().prepare("SELECT COUNT(*) as count FROM tracks").get() as { count: number };
  return row.count;
};

/** 随机取一首曲目，库为空时返回 null */
export const getRandomTrack = (): Track | null => {
  const row = getDb().prepare("SELECT * FROM tracks ORDER BY RANDOM() LIMIT 1").get() as
    | TrackRow
    | undefined;
  return row ? rowToTrack(row) : null;
};

/** 随机取多首曲目 */
export const getRandomTracks = (limit: number): Track[] => {
  const safe = Math.max(0, Math.min(limit | 0, 500));
  if (safe === 0) return [];
  const rows = getDb()
    .prepare("SELECT * FROM tracks ORDER BY RANDOM() LIMIT ?")
    .all(safe) as TrackRow[];
  return rows.map(rowToTrack);
};

/** 用于增量扫描比对的文件记录 */
export interface FileRecord {
  path: string;
  mtime: number;
  size: number;
}

/** 获取所有文件记录（path + mtime + size），用于增量扫描比对 */
export const getFileRecords = (): FileRecord[] => {
  return getDb()
    .prepare("SELECT path, COALESCE(file_mtime, 0) as mtime, file_size as size FROM tracks")
    .all() as FileRecord[];
};

/** 批量插入/更新的扫描结果 */
export interface UpsertTrack {
  id: string;
  path: string;
  title: string;
  track?: number;
  artists: Artist[];
  album?: Album;
  duration: number;
  cover?: string;
  codec?: string;
  sampleRate?: number;
  bitRate?: number;
  channels?: number;
  bitsPerSample?: number;
  fileSize: number;
  mtime: number;
  ctime: number;
}

/** 批量插入/更新曲目（使用事务） */
export const upsertTracks = (tracks: UpsertTrack[]): void => {
  if (tracks.length === 0) return;
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO tracks
      (id, path, title, track, artists, album, duration, cover, codec, sample_rate, bit_rate, channels, bits_per_sample, file_size, file_mtime, file_ctime, scanned_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const tx = d.transaction(() => {
    for (const t of tracks) {
      stmt.run(
        t.id,
        t.path,
        t.title,
        t.track ?? null,
        JSON.stringify(t.artists),
        t.album ? JSON.stringify(t.album) : null,
        t.duration,
        t.cover ?? null,
        t.codec ?? null,
        t.sampleRate ?? null,
        t.bitRate ?? null,
        t.channels ?? null,
        t.bitsPerSample ?? null,
        t.fileSize,
        t.mtime,
        t.ctime,
        now,
      );
    }
  });
  tx();
};

/** 批量删除曲目（按路径） */
export const deleteTracksByPaths = (paths: string[]): void => {
  if (paths.length === 0) return;
  const d = getDb();
  const stmt = d.prepare("DELETE FROM tracks WHERE path = ?");
  const tx = d.transaction(() => {
    for (const p of paths) {
      stmt.run(p);
    }
  });
  tx();
};

/** 模糊搜索曲目（title / artists / album），最多返回 200 条 */
export const searchTracks = (query: string): Track[] => {
  if (!query || query.trim().length === 0) return [];
  const escaped = query.replace(/[%_\\]/g, "\\$&");
  const pattern = `%${escaped}%`;
  const rows = getDb()
    .prepare(
      "SELECT * FROM tracks WHERE title LIKE ? ESCAPE '\\' OR artists LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\' LIMIT 200",
    )
    .all(pattern, pattern, pattern) as TrackRow[];
  return rows.map(rowToTrack);
};

/** SQLite 最大参数数量（默认 999，留余量取 900） */
const SQLITE_MAX_VARIABLE_NUMBER = 900;

/**
 * 删除指定目录下的所有曲目
 * 同时处理正斜杠和反斜杠路径分隔符，兼容跨平台路径格式
 * @param dir - 目录路径
 */
export const deleteTracksByDir = (dir: string): void => {
  const normalizedDir = dir.replace(/\\/g, "/");
  const prefix = normalizedDir.endsWith("/") ? normalizedDir : `${normalizedDir}/`;
  getDb()
    .prepare("DELETE FROM tracks WHERE REPLACE(path, '\\\\', '/') LIKE ?")
    .run(prefix + "%");
};

/** 专辑列表 */
export const getAlbumList = (): AlbumSummary[] => {
  const rows = getDb()
    .prepare(
      `SELECT
         json_extract(album, '$.name') AS name,
         json_extract(album, '$.artist') AS artist,
         MAX(CASE WHEN cover IS NOT NULL THEN cover END) AS cover,
         COUNT(*) AS trackCount
       FROM tracks
       WHERE album IS NOT NULL AND json_extract(album, '$.name') IS NOT NULL
       GROUP BY name`,
    )
    .all() as { name: string; artist: string | null; cover: string | null; trackCount: number }[];

  return rows.map((row) => ({
    name: row.name,
    cover: row.cover ?? undefined,
    artist: row.artist ?? undefined,
    trackCount: row.trackCount,
  }));
};

/** 歌手列表 */
export const getArtistList = (): ArtistSummary[] => {
  const rows = getDb()
    .prepare(
      `SELECT
         json_extract(a.value, '$.name') AS name,
         COUNT(DISTINCT t.id) AS trackCount,
         MAX(CASE WHEN t.cover IS NOT NULL THEN t.cover END) AS cover
       FROM tracks t, json_each(t.artists) a
       WHERE json_extract(a.value, '$.name') IS NOT NULL
         AND TRIM(json_extract(a.value, '$.name')) != ''
       GROUP BY name`,
    )
    .all() as { name: string; trackCount: number; cover: string | null }[];
  return rows.map((row) => ({
    name: row.name,
    trackCount: row.trackCount,
    cover: row.cover ?? undefined,
  }));
};

/** 按专辑名获取全部曲目 */
export const getAlbumTracks = (albumName: string): Track[] => {
  const rows = getDb()
    .prepare("SELECT * FROM tracks WHERE json_extract(album, '$.name') = ?")
    .all(albumName) as TrackRow[];
  return rows.map(rowToTrack);
};

/** 按歌手名获取全部曲目 */
export const getArtistTracks = (artistName: string): Track[] => {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT t.* FROM tracks t, json_each(t.artists) a
       WHERE LOWER(json_extract(a.value, '$.name')) = LOWER(?)`,
    )
    .all(artistName) as TrackRow[];
  return rows.map(rowToTrack);
};

/**
 * 按 ID 批量获取曲目
 * 当 ID 数量超过 SQLite 参数限制时自动分批查询
 * @param ids - 曲目 ID 数组
 * @returns 曲目列表
 */
export const getTracksByIds = (ids: string[]): Track[] => {
  if (ids.length === 0) return [];

  const results: Track[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < ids.length; i += SQLITE_MAX_VARIABLE_NUMBER) {
    const batch = ids.slice(i, i + SQLITE_MAX_VARIABLE_NUMBER);
    const placeholders = batch.map(() => "?").join(",");
    const rows = getDb()
      .prepare(`SELECT * FROM tracks WHERE id IN (${placeholders})`)
      .all(...batch) as TrackRow[];

    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        results.push(rowToTrack(row));
      }
    }
  }

  return results;
};
