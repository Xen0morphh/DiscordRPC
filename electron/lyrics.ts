import https from "node:https";
import type { LyricLine } from "./types.js";

// ---------------------------------------------------------------------------
// LRCLIB API — free, open-source synced lyrics (no API key needed)
// ---------------------------------------------------------------------------

type LrcLibResult = {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  syncedLyrics: string | null;
  plainLyrics: string | null;
};

/** Simple HTTPS GET that returns parsed JSON. */
const fetchJson = <T>(url: string): Promise<T | null> =>
  new Promise((resolve) => {
    const request = https.get(url, { headers: { "User-Agent": "DiscordRPC-SpotifyLyrics/1.0" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => {
        try { resolve(JSON.parse(body) as T); }
        catch { resolve(null); }
      });
    });
    request.on("error", () => resolve(null));
    request.setTimeout(8000, () => { request.destroy(); resolve(null); });
  });

// ---------------------------------------------------------------------------
// LRC parser — "[mm:ss.xx] text" → LyricLine[]
// ---------------------------------------------------------------------------

const LRC_LINE_RE = /^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]\s?(.*)/;

export const parseLrc = (lrc: string): LyricLine[] => {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split("\n")) {
    const match = LRC_LINE_RE.exec(raw.trim());
    if (!match) continue;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const centiseconds = match[3] ? parseInt(match[3].padEnd(3, "0").slice(0, 3), 10) : 0;
    const timeMs = minutes * 60_000 + seconds * 1_000 + centiseconds;
    const text = match[4].trim();
    if (text) {
      lines.push({ timeMs, text });
    }
  }
  lines.sort((a, b) => a.timeMs - b.timeMs);
  return lines;
};

// ---------------------------------------------------------------------------
// Fetch lyrics from LRCLIB
// ---------------------------------------------------------------------------

export const fetchLyrics = async (
  title: string,
  artist: string,
  album: string,
  durationSec: number
): Promise<{ lyrics: LyricLine[]; synced: boolean } | null> => {
  // Try exact match first (with duration for better accuracy)
  const baseParams = `track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
  const exactUrl = `https://lrclib.net/api/get?${baseParams}&album_name=${encodeURIComponent(album)}&duration=${Math.round(durationSec)}`;

  let result = await fetchJson<LrcLibResult>(exactUrl);

  // Fallback: search endpoint (more lenient matching)
  if (!result) {
    const searchUrl = `https://lrclib.net/api/search?${baseParams}`;
    const results = await fetchJson<LrcLibResult[]>(searchUrl);
    if (results && results.length > 0) {
      // Prefer result with synced lyrics
      result = results.find((r) => r.syncedLyrics) ?? results[0];
    }
  }

  if (!result) {
    return null;
  }

  // Prefer synced lyrics
  if (result.syncedLyrics) {
    const parsed = parseLrc(result.syncedLyrics);
    if (parsed.length > 0) {
      return { lyrics: parsed, synced: true };
    }
  }

  // Fallback to plain lyrics (no timestamps — we'll show them statically)
  if (result.plainLyrics) {
    const plainLines = result.plainLyrics
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text, index) => ({ timeMs: index * 5000, text })); // approximate timing
    if (plainLines.length > 0) {
      return { lyrics: plainLines, synced: false };
    }
  }

  return null;
};

// ---------------------------------------------------------------------------
// Lookup current lyric line via binary search
// ---------------------------------------------------------------------------

export const getCurrentLyric = (lyrics: LyricLine[], progressMs: number): string | null => {
  if (lyrics.length === 0) return null;

  // Binary search for the last line whose timeMs <= progressMs
  let lo = 0;
  let hi = lyrics.length - 1;
  let result = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lyrics[mid].timeMs <= progressMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (result < 0) return null;
  return lyrics[result].text;
};

// ---------------------------------------------------------------------------
// Lyrics cache (per track ID)
// ---------------------------------------------------------------------------

type CachedLyrics = {
  lyrics: LyricLine[];
  synced: boolean;
  status: "synced" | "plain" | "not_found";
};

const cache = new Map<string, CachedLyrics>();
const MAX_CACHE_SIZE = 50;

export const getLyricsForTrack = async (
  trackId: string,
  title: string,
  artist: string,
  album: string,
  durationMs: number
): Promise<CachedLyrics> => {
  const cached = cache.get(trackId);
  if (cached) return cached;

  const result = await fetchLyrics(title, artist, album, durationMs / 1000);

  let entry: CachedLyrics;
  if (!result) {
    entry = { lyrics: [], synced: false, status: "not_found" };
  } else if (result.synced) {
    entry = { lyrics: result.lyrics, synced: true, status: "synced" };
  } else {
    entry = { lyrics: result.lyrics, synced: false, status: "plain" };
  }

  // Evict oldest entries if cache is full
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }

  cache.set(trackId, entry);
  return entry;
};
