import type { SystemConfig } from "@shared/types/settings";

export interface Migration {
  /** 版本号，递增整数 */
  version: number;
  /** 迁移函数，直接修改 data 对象 */
  migrate: (data: SystemConfig) => void;
}

/**
 * 迁移列表，按 version 递增排列
 * 新增字段已由 deepMerge 自动补全，此处仅用于字段重命名、数据转换等
 */
export const migrations: Migration[] = [
  {
    version: 1,
    migrate: (data) => {
      const legacySystem = data.system as typeof data.system & {
        spotify?: Partial<Pick<SystemConfig["spotify"], "clientId" | "clientSecret">>;
      };
      const legacySpotify = legacySystem.spotify;
      if (!legacySpotify) return;
      if (legacySpotify.clientId && !data.spotify.clientId) {
        data.spotify.clientId = legacySpotify.clientId;
      }
      if (legacySpotify.clientSecret && !data.spotify.clientSecret) {
        data.spotify.clientSecret = legacySpotify.clientSecret;
      }
      delete legacySystem.spotify;
    },
  },
];
