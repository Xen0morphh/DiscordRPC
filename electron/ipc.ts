import { BrowserWindow, app, ipcMain, shell } from "electron";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import DiscordRPC from "discord-rpc";
import type { AppConfig, RpcState, SpotifyTrack, TokenSet } from "./types.js";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_CURRENTLY_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing";
const REDIRECT_PORT = 4387;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = ["user-read-currently-playing", "user-read-playback-state"];

const defaultConfig: AppConfig = {
  spotifyClientId: "",
  discordClientId: "",
  pollIntervalMs: 5000,
  showAlbumArt: true,
  showButtons: true
};

type PersistedState = {
  config: AppConfig;
  tokens: TokenSet | null;
};

let state: RpcState = {
  config: defaultConfig,
  spotifyConnected: false,
  discordConnected: false,
  running: false,
  authInProgress: false,
  lastTrack: null,
  message: "Isi Spotify Client ID dan Discord Application ID, lalu hubungkan Spotify.",
  error: null
};

let tokens: TokenSet | null = null;
let rpcClient: InstanceType<typeof DiscordRPC.Client> | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let lastPresenceKey = "";

const configPath = () => path.join(app.getPath("userData"), "config.json");

const sanitizeConfig = (input: Partial<AppConfig>): AppConfig => ({
  spotifyClientId: String(input.spotifyClientId ?? "").trim(),
  discordClientId: String(input.discordClientId ?? "").trim(),
  pollIntervalMs: Math.min(Math.max(Number(input.pollIntervalMs) || 5000, 3000), 30000),
  showAlbumArt: Boolean(input.showAlbumArt ?? true),
  showButtons: Boolean(input.showButtons ?? true)
});

const publish = (getWindow: () => BrowserWindow | null) => {
  getWindow()?.webContents.send("rpc:state", state);
};

const setState = (getWindow: () => BrowserWindow | null, patch: Partial<RpcState>) => {
  state = { ...state, ...patch };
  publish(getWindow);
};

const loadPersisted = async () => {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const persisted = JSON.parse(raw) as Partial<PersistedState>;
    state.config = sanitizeConfig({ ...defaultConfig, ...persisted.config });
    tokens = persisted.tokens ?? null;
    state.spotifyConnected = Boolean(tokens?.refreshToken);
    if (state.spotifyConnected) {
      state.message = "Spotify sudah terhubung. Tekan Start untuk mulai update Discord.";
    }
  } catch {
    await savePersisted();
  }
};

const savePersisted = async () => {
  const persisted: PersistedState = {
    config: state.config,
    tokens
  };
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(persisted, null, 2), "utf8");
};

const base64Url = (buffer: Buffer) =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const createPkce = () => {
  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

const exchangeToken = async (body: URLSearchParams): Promise<TokenSet> => {
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    throw new Error(`Spotify token gagal (${response.status})`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens?.refreshToken ?? "",
    expiresAt: Date.now() + data.expires_in * 1000 - 60_000
  };
};

const refreshAccessToken = async () => {
  if (!tokens?.refreshToken) {
    throw new Error("Spotify belum terhubung.");
  }

  if (tokens.expiresAt > Date.now()) {
    return tokens.accessToken;
  }

  tokens = await exchangeToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: state.config.spotifyClientId
    })
  );
  await savePersisted();
  return tokens.accessToken;
};

const waitForAuthCode = () =>
  new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      server.close();
      callback();
    };

    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", REDIRECT_URI);
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      response.writeHead(error ? 400 : 200, { "Content-Type": "text/html" });
      response.end("<html><body><h2>Spotify connected. You can close this window.</h2></body></html>");

      if (error) {
        finish(() => reject(new Error(`Spotify auth ditolak: ${error}`)));
      } else if (!code) {
        finish(() => reject(new Error("Spotify tidak mengirim authorization code.")));
      } else {
        finish(() => resolve(code));
      }
    });

    server.once("error", reject);
    server.listen(REDIRECT_PORT, "127.0.0.1");
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Login Spotify timeout.")));
    }, 120_000).unref();
  });

const fetchCurrentTrack = async (): Promise<SpotifyTrack | null> => {
  const accessToken = await refreshAccessToken();
  const response = await fetch(SPOTIFY_CURRENTLY_PLAYING_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Spotify currently-playing gagal (${response.status})`);
  }

  const data = (await response.json()) as {
    is_playing: boolean;
    progress_ms: number;
    item?: {
      id: string;
      name: string;
      duration_ms: number;
      album: { name: string; images: Array<{ url: string }> };
      artists: Array<{ name: string }>;
      external_urls?: { spotify?: string };
    };
  };

  if (!data.item) {
    return null;
  }

  return {
    id: data.item.id,
    title: data.item.name,
    artist: data.item.artists.map((artist) => artist.name).join(", "),
    album: data.item.album.name,
    albumArtUrl: data.item.album.images[0]?.url,
    spotifyUrl: data.item.external_urls?.spotify,
    progressMs: data.progress_ms ?? 0,
    durationMs: data.item.duration_ms,
    isPlaying: data.is_playing
  };
};

const connectDiscord = async () => {
  if (!state.config.discordClientId) {
    throw new Error("Discord Application ID wajib diisi.");
  }

  if (rpcClient) {
    return rpcClient;
  }

  DiscordRPC.register(state.config.discordClientId);
  rpcClient = new DiscordRPC.Client({ transport: "ipc" });
  await rpcClient.login({ clientId: state.config.discordClientId });
  state.discordConnected = true;
  return rpcClient;
};

const clearPresence = async () => {
  if (rpcClient) {
    await rpcClient.clearActivity().catch(() => undefined);
  }
  lastPresenceKey = "";
};

const updatePresence = async (track: SpotifyTrack | null) => {
  if (!rpcClient) {
    return;
  }

  if (!track || !track.isPlaying) {
    await clearPresence();
    return;
  }

  const presenceKey = `${track.id}:${Math.floor(track.progressMs / 5000)}:${track.isPlaying}`;
  if (presenceKey === lastPresenceKey) {
    return;
  }
  lastPresenceKey = presenceKey;

  const startTimestamp = Date.now() - track.progressMs;
  const endTimestamp = startTimestamp + track.durationMs;
  await rpcClient.setActivity({
    details: track.title.slice(0, 128),
    state: track.artist.slice(0, 128),
    startTimestamp,
    endTimestamp,
    largeImageKey: state.config.showAlbumArt ? track.albumArtUrl ?? "spotify" : "spotify",
    largeImageText: track.album.slice(0, 128),
    smallImageKey: "spotify",
    smallImageText: "Listening on Spotify",
    buttons:
      state.config.showButtons && track.spotifyUrl
        ? [{ label: "Open in Spotify", url: track.spotifyUrl }]
        : undefined,
    instance: false
  });
};

const pollOnce = async (getWindow: () => BrowserWindow | null) => {
  const track = await fetchCurrentTrack();
  await updatePresence(track);
  setState(getWindow, {
    lastTrack: track,
    error: null,
    message: track?.isPlaying
      ? `Discord update: ${track.title} - ${track.artist}`
      : "Tidak ada lagu Spotify yang sedang diputar."
  });
};

const startPolling = async (getWindow: () => BrowserWindow | null) => {
  await connectDiscord();
  setState(getWindow, { running: true, discordConnected: true, error: null, message: "Realtime update aktif." });
  await pollOnce(getWindow);

  if (pollTimer) {
    clearInterval(pollTimer);
  }

  pollTimer = setInterval(() => {
    void pollOnce(getWindow).catch((error: unknown) => {
      setState(getWindow, {
        error: error instanceof Error ? error.message : String(error),
        message: "Polling Spotify gagal."
      });
    });
  }, state.config.pollIntervalMs);
};

const stopPolling = async (getWindow: () => BrowserWindow | null) => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  await clearPresence();
  setState(getWindow, { running: false, message: "Realtime update dihentikan." });
};

export const setupIpc = (getWindow: () => BrowserWindow | null) => {
  void loadPersisted().then(() => publish(getWindow));

  ipcMain.handle("rpc:get-state", () => state);

  ipcMain.handle("rpc:save-config", async (_event, input: Partial<AppConfig>) => {
    state.config = sanitizeConfig(input);
    await savePersisted();
    setState(getWindow, { config: state.config, message: "Konfigurasi disimpan.", error: null });
    return state;
  });

  ipcMain.handle("rpc:connect-spotify", async () => {
    try {
      if (!state.config.spotifyClientId) {
        throw new Error("Spotify Client ID wajib diisi.");
      }

      const { verifier, challenge } = createPkce();
      const params = new URLSearchParams({
        client_id: state.config.spotifyClientId,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        code_challenge_method: "S256",
        code_challenge: challenge,
        scope: SCOPES.join(" ")
      });

      setState(getWindow, { authInProgress: true, error: null, message: "Membuka login Spotify..." });
      const authCodePromise = waitForAuthCode();
      await shell.openExternal(`${SPOTIFY_AUTH_URL}?${params.toString()}`);
      const code = await authCodePromise;
      tokens = await exchangeToken(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: state.config.spotifyClientId,
          code_verifier: verifier
        })
      );
      await savePersisted();
      setState(getWindow, {
        spotifyConnected: true,
        authInProgress: false,
        error: null,
        message: "Spotify terhubung. Tekan Start untuk update Discord."
      });
      return state;
    } catch (error) {
      setState(getWindow, {
        authInProgress: false,
        error: error instanceof Error ? error.message : String(error),
        message: "Gagal menghubungkan Spotify."
      });
      return state;
    }
  });

  ipcMain.handle("rpc:start", async () => {
    try {
      await startPolling(getWindow);
    } catch (error) {
      setState(getWindow, {
        running: false,
        error: error instanceof Error ? error.message : String(error),
        message: "Gagal memulai realtime update."
      });
    }
    return state;
  });

  ipcMain.handle("rpc:stop", async () => {
    await stopPolling(getWindow);
    return state;
  });

  ipcMain.handle("rpc:disconnect-spotify", async () => {
    await stopPolling(getWindow);
    tokens = null;
    await savePersisted();
    setState(getWindow, {
      spotifyConnected: false,
      lastTrack: null,
      message: "Spotify diputuskan.",
      error: null
    });
    return state;
  });
};
