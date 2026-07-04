/**
 * Spotify 搜索实现（渲染端）
 */

import type { Track } from "@shared/types/player";
import type { CoverItem } from "@/types/artist";
import { spotify as spotifyApi } from "@/apis/spotify";
import type { SearchResult } from "./index";

interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists: Array<{ name: string }>;
  album?: {
    name: string;
    images?: Array<{ url: string }>;
  };
}

interface SpotifyAlbum {
  id: string;
  name: string;
  images?: Array<{ url: string }>;
  artists: Array<{ name: string }>;
  total_tracks: number;
}

interface SpotifyArtist {
  id: string;
  name: string;
  images?: Array<{ url: string }>;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  images?: Array<{ url: string }>;
  owner?: { display_name?: string };
  tracks?: { total: number };
}

interface TracksResp {
  total?: number;
  tracks?: SpotifyTrack[];
}

interface AlbumsResp {
  total?: number;
  albums?: SpotifyAlbum[];
}

interface ArtistsResp {
  total?: number;
  artists?: SpotifyArtist[];
}

interface PlaylistsResp {
  total?: number;
  playlists?: SpotifyPlaylist[];
}

/** Spotify 封面 URL，根据目标尺寸选择最接近的图片 */
const pickImage = (images?: Array<{ url: string; height?: number; width?: number }>, targetSize = 300): string | undefined => {
  if (!images || images.length === 0) return undefined;
  // Spotify 返回的图片按尺寸从小到大排列，找最接近 targetSize 的
  let best = images[0];
  let bestDiff = Infinity;
  for (const img of images) {
    const size = img.width ?? img.height ?? 0;
    const diff = Math.abs(size - targetSize);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = img;
    }
  }
  return best.url;
};

const trackToTrack = (track: SpotifyTrack): Track => {
  const cover = pickImage(track.album?.images, 300);
  const coverOriginal = pickImage(track.album?.images, 640);
  return {
    id: track.id,
    source: "spotify",
    title: track.name,
    artists: track.artists.map((a) => ({ name: a.name })),
    album: track.album ? { name: track.album.name, cover } : undefined,
    duration: track.duration_ms ?? 0,
    cover,
    coverOriginal,
  };
};

const albumToCover = (album: SpotifyAlbum): CoverItem => ({
  id: album.id,
  title: album.name,
  cover: pickImage(album.images, 300),
  subtitle: album.artists.map((a) => a.name).join(" / "),
  trackCount: album.total_tracks ?? 0,
});

const artistToCover = (artist: SpotifyArtist): CoverItem => ({
  id: artist.id,
  title: artist.name,
  cover: pickImage(artist.images, 300),
  subtitle: "",
  trackCount: 0,
});

const playlistToCover = (playlist: SpotifyPlaylist): CoverItem => ({
  id: playlist.id,
  title: playlist.name,
  cover: pickImage(playlist.images, 300),
  subtitle: playlist.owner?.display_name ?? "",
  trackCount: playlist.tracks?.total ?? 0,
});


export const songs = async (
  keyword: string,
  offset: number,
  limit: number,
): Promise<SearchResult<Track>> => {
  const body = await spotifyApi.search<TracksResp>({
    keywords: keyword,
    offset,
    limit,
  });
  const items = (body?.tracks ?? []).map(trackToTrack);
  const total = body?.total ?? items.length;
  return { items, total, hasMore: offset + items.length < total };
};

export const albums = async (
  keyword: string,
  offset: number,
  limit: number,
): Promise<SearchResult<CoverItem>> => {
  const body = await spotifyApi.search<AlbumsResp>({
    keywords: keyword,
    type: "album",
    offset,
    limit,
  });
  const items = (body?.albums ?? []).map(albumToCover);
  const total = body?.total ?? items.length;
  return { items, total, hasMore: offset + items.length < total };
};

export const artists = async (
  keyword: string,
  offset: number,
  limit: number,
): Promise<SearchResult<CoverItem>> => {
  const body = await spotifyApi.search<ArtistsResp>({
    keywords: keyword,
    type: "artist",
    offset,
    limit,
  });
  const items = (body?.artists ?? []).map(artistToCover);
  const total = body?.total ?? items.length;
  return { items, total, hasMore: offset + items.length < total };
};

export const playlists = async (
  keyword: string,
  offset: number,
  limit: number,
): Promise<SearchResult<CoverItem>> => {
  const body = await spotifyApi.search<PlaylistsResp>({
    keywords: keyword,
    type: "playlist",
    offset,
    limit,
  });
  const items = (body?.playlists ?? []).map(playlistToCover);
  const total = body?.total ?? items.length;
  return { items, total, hasMore: offset + items.length < total };
};
