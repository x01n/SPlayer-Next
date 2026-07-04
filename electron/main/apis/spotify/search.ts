/**
 * Spotify 搜索实现
 *
 * 调用 Spotify Web API /v1/search 搜索单曲/专辑/歌手/歌单
 */

import { getAccessToken } from "./auth";
import { coreLog } from "@main/utils/logger";

interface SpotifyImage {
  url: string;
  height?: number;
  width?: number;
}

interface SpotifyTrackItem {
  id: string;
  name: string;
  duration_ms: number;
  artists: Array<{ name: string }>;
  album: {
    name: string;
    images: SpotifyImage[];
  };
}

interface SpotifyAlbumItem {
  id: string;
  name: string;
  images: SpotifyImage[];
  artists: Array<{ name: string }>;
  total_tracks: number;
}

interface SpotifyArtistItem {
  id: string;
  name: string;
  images?: SpotifyImage[];
}

interface SpotifyPlaylistItem {
  id: string;
  name: string;
  images?: SpotifyImage[];
  owner?: { display_name?: string };
  tracks?: { total: number };
}

interface SpotifySearchResponse {
  tracks?: {
    items: SpotifyTrackItem[];
    total: number;
    offset: number;
    limit: number;
  };
  albums?: {
    items: SpotifyAlbumItem[];
    total: number;
    offset: number;
    limit: number;
  };
  artists?: {
    items: SpotifyArtistItem[];
    total: number;
    offset: number;
    limit: number;
  };
  playlists?: {
    items: SpotifyPlaylistItem[];
    total: number;
    offset: number;
    limit: number;
  };
}

/**
 * 发起 Spotify Web API 搜索请求
 * @param params - 搜索参数
 */
const search = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const {
    keywords,
    type = "track",
    offset = 0,
    limit = 20,
  } = params as {
    keywords?: string;
    type?: string;
    offset?: number;
    limit?: number;
  };

  if (!keywords) {
    return { code: 400, total: 0, [type === "track" ? "tracks" : type === "album" ? "albums" : type === "artist" ? "artists" : "playlists"]: [] };
  }

  const token = await getAccessToken();
  if (!token) {
    // 未配置凭证时返回空结果，不抛错
    return { code: 401, total: 0, [type === "track" ? "tracks" : type === "album" ? "albums" : type === "artist" ? "artists" : "playlists"]: [] };
  }

  const url =
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(keywords)}` +
    `&type=${type}&limit=${limit}&offset=${offset}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text();
      coreLog.warn(`[spotify] search failed: ${res.status} ${text}`);
      return { code: res.status, total: 0, [type === "track" ? "tracks" : type === "album" ? "albums" : type === "artist" ? "artists" : "playlists"]: [] };
    }

    const data = (await res.json()) as SpotifySearchResponse;

    if (type === "track") {
      const tracks = data.tracks?.items ?? [];
      return {
        code: 200,
        total: data.tracks?.total ?? tracks.length,
        tracks: tracks.map((t) => ({
          id: t.id,
          name: t.name,
          duration_ms: t.duration_ms,
          artists: t.artists,
          album: {
            name: t.album.name,
            images: t.album.images,
          },
        })),
      };
    }

    if (type === "album") {
      const albums = data.albums?.items ?? [];
      return {
        code: 200,
        total: data.albums?.total ?? albums.length,
        albums: albums.map((a) => ({
          id: a.id,
          name: a.name,
          images: a.images,
          artists: a.artists,
          total_tracks: a.total_tracks,
        })),
      };
    }

    if (type === "artist") {
      const artists = data.artists?.items ?? [];
      return {
        code: 200,
        total: data.artists?.total ?? artists.length,
        artists: artists.map((a) => ({
          id: a.id,
          name: a.name,
          images: a.images,
        })),
      };
    }

    if (type === "playlist") {
      const playlists = data.playlists?.items ?? [];
      return {
        code: 200,
        total: data.playlists?.total ?? playlists.length,
        playlists: playlists.map((p) => ({
          id: p.id,
          name: p.name,
          images: p.images,
          owner: p.owner,
          tracks: p.tracks,
        })),
      };
    }

    return { code: 400, total: 0 };
  } catch (err) {
    coreLog.warn("[spotify] search error:", err);
    return { code: 500, total: 0 };
  }
};

export default search;
