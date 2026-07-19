export type AppConfig = {
  discordClientId: string;
  discordUserToken: string;
  pollIntervalMs: number;
  showAlbumArt: boolean;
  showLyrics: boolean;
  lyricsOffsetMs: number;
  largeImageKey: string;
};

export type SpotifyTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
  source: string;
};

export type LyricLine = {
  timeMs: number;
  text: string;
};

export type RpcState = {
  config: AppConfig;
  mediaSessionAvailable: boolean;
  discordConnected: boolean;
  running: boolean;
  lastTrack: SpotifyTrack | null;
  currentLyric: string | null;
  lyricsStatus: string;
  message: string;
  error: string | null;
};
