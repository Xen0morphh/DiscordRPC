/// <reference types="vite/client" />

export type AppConfig = {
  spotifyClientId: string;
  discordClientId: string;
  pollIntervalMs: number;
  showAlbumArt: boolean;
  showButtons: boolean;
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

type SpotifyRpcBridge = {
  getState: () => Promise<RpcState>;
  saveConfig: (config: AppConfig) => Promise<RpcState>;
  connectSpotify: () => Promise<RpcState>;
  start: () => Promise<RpcState>;
  stop: () => Promise<RpcState>;
  disconnectSpotify: () => Promise<RpcState>;
  onState: (callback: (state: RpcState) => void) => () => void;
};

declare global {
  interface Window {
    spotifyRpc: SpotifyRpcBridge;
  }
}
