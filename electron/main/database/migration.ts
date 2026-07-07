import type Database from "better-sqlite3";

/** 当前 schema 版本 */
const SCHEMA_VERSION = 3;

/** PRAGMA table_info 返回的列信息 */
interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/**
 * 判断表是否存在指定列
 * @param d - 数据库实例
 * @param table - 表名
 * @param column - 列名
 * @returns 是否存在
 */
const hasColumn = (d: Database.Database, table: string, column: string): boolean => {
  const rows = d.prepare("SELECT name FROM pragma_table_info(?)").all(table) as TableInfoRow[];
  return rows.some((r) => r.name === column);
};

/**
 * 执行数据库迁移
 * @param d - 数据库实例
 */
export const migrate = (d: Database.Database): void => {
  const version = d.pragma("user_version", { simple: true }) as number;
  let v = version;

  // v1 → v2: 添加 file_mtime / file_ctime 列
  if (v < 2) {
    if (!hasColumn(d, "tracks", "file_mtime")) {
      d.exec("ALTER TABLE tracks ADD COLUMN file_mtime INTEGER");
    }
    if (!hasColumn(d, "tracks", "file_ctime")) {
      d.exec("ALTER TABLE tracks ADD COLUMN file_ctime INTEGER");
    }
    v = 2;
  }

  // v2 → v3: 添加 track 列
  if (v < 3) {
    if (!hasColumn(d, "tracks", "track")) {
      d.exec("ALTER TABLE tracks ADD COLUMN track INTEGER");
    }
    v = 3;
  }

  // 版本无关部分
  // 补 lyric_match_cache.extra 列
  if (!hasColumn(d, "lyric_match_cache", "extra")) {
    d.exec("ALTER TABLE lyric_match_cache ADD COLUMN extra TEXT");
  }

  // 确保版本号同步到当前 schema 版本
  if (v !== SCHEMA_VERSION) {
    v = SCHEMA_VERSION;
  }
  if (v !== version) {
    d.pragma(`user_version = ${v}`);
  }
};
