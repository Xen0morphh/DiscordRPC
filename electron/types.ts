export type AppConfig = {
  spotifyClientId: string;
  discordClientId: string;
  pollIntervalMs: number;
  showAlbumArt: boolean;
  showButtons: boolean;
};

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type SpotifyTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtUrl?: string;
  spotifyUrl?: string;
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
};

export type RpcState = {
  config: AppConfig;
  spotifyConnected: boolean;
  discordConnected: boolean;
  running: boolean;
  authInProgress: boolean;
  lastTrack: SpotifyTrack | null;
  message: string;
  error: string | null;
};
