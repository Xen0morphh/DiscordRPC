import { BrowserWindow, app, ipcMain } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { promisify } from "node:util";
import DiscordRPC from "discord-rpc";
import type { AppConfig, LyricLine, RpcState, SpotifyTrack } from "./types.js";
import { getCurrentLyric, getLyricsForTrack } from "./lyrics.js";

const execFileAsync = promisify(execFile);

const defaultConfig: AppConfig = {
  discordClientId: "",
  discordUserToken: "",
  pollIntervalMs: 3000,
  showAlbumArt: false,
  showLyrics: true
};

type PersistedState = {
  config: AppConfig;
};

let state: RpcState = {
  config: defaultConfig,
  mediaSessionAvailable: false,
  discordConnected: false,
  running: false,
  lastTrack: null,
  currentLyric: null,
  lyricsStatus: "disabled",
  message: "Isi Discord Token & buka Spotify desktop, lalu tekan Start.",
  error: null
};

let rpcClient: InstanceType<typeof DiscordRPC.Client> | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let lastPresenceKey = "";
let lastPresenceTime = 0;
const MIN_PRESENCE_INTERVAL_MS = 5_000;

// Custom status state
let lastCustomStatusText = "";
let lastCustomStatusTime = 0;
const MIN_CUSTOM_STATUS_INTERVAL_MS = 5_000;

// Lyrics state
let currentTrackId = "";
let currentLyrics: LyricLine[] = [];
let currentLyricsSynced = false;

// Last RPC action log (forwarded to UI)
let lastRpcLog = "";

const configPath = () => path.join(app.getPath("userData"), "config.json");

const sanitizeConfig = (input: Partial<AppConfig>): AppConfig => ({
  discordClientId: String(input.discordClientId ?? "").trim(),
  discordUserToken: String(input.discordUserToken ?? "").trim(),
  pollIntervalMs: Math.min(Math.max(Number(input.pollIntervalMs) || 3000, 1000), 30000),
  showAlbumArt: false,
  showLyrics: input.showLyrics !== false
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
  } catch {
    await savePersisted();
  }
};

const savePersisted = async () => {
  const persisted: PersistedState = {
    config: state.config
  };
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(persisted, null, 2), "utf8");
};

// ---------------------------------------------------------------------------
// Discord Custom Status via REST API
// ---------------------------------------------------------------------------

const updateCustomStatus = (token: string, text: string | null): Promise<boolean> =>
  new Promise((resolve) => {
    const body = JSON.stringify({
      custom_status: text
        ? { text: text.slice(0, 128), emoji_name: "🎵" }
        : null
    });

    const req = https.request(
      "https://discord.com/api/v9/users/@me/settings",
      {
        method: "PATCH",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "DiscordRPC-SpotifyLyrics/1.0"
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve(true);
          } else {
            console.error(`[CustomStatus] API error ${res.statusCode}: ${data.slice(0, 200)}`);
            resolve(false);
          }
        });
      }
    );

    req.on("error", (err) => {
      console.error("[CustomStatus] Request failed:", err.message);
      resolve(false);
    });

    req.setTimeout(8000, () => {
      req.destroy();
      resolve(false);
    });

    req.write(body);
    req.end();
  });

// ---------------------------------------------------------------------------
// Windows Media Session reader
// ---------------------------------------------------------------------------

const mediaSessionScript = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.IsGenericMethod -and
  $_.GetParameters().Count -eq 1
})[0]

function Await-WinRt($Operation, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $task = $asTask.Invoke($null, @($Operation))
  $task.Wait() | Out-Null
  return $task.Result
}

$manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $managerType
$sessions = @($manager.GetSessions())
$session = $sessions | Where-Object { $_.SourceAppUserModelId -like '*Spotify*' } | Select-Object -First 1
if ($null -eq $session) {
  @{ found = $false } | ConvertTo-Json -Compress
  exit 0
}

$props = Await-WinRt ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$timeline = $session.GetTimelineProperties()
$playback = $session.GetPlaybackInfo()
$status = $playback.PlaybackStatus.ToString()

@{
  found = $true
  title = [string]$props.Title
  artist = [string]$props.Artist
  album = [string]$props.AlbumTitle
  source = [string]$session.SourceAppUserModelId
  status = [string]$status
  progressMs = [int64]$timeline.Position.TotalMilliseconds
  durationMs = [int64]$timeline.EndTime.TotalMilliseconds
} | ConvertTo-Json -Compress
`;

const readLocalSpotifyTrack = async (): Promise<SpotifyTrack | null> => {
  if (process.platform !== "win32") {
    throw new Error("Mode tanpa Web API saat ini memakai Windows media session, jadi hanya tersedia di Windows.");
  }

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", mediaSessionScript],
    { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 128 }
  );

  const data = JSON.parse(stdout.trim() || "{}") as {
    found?: boolean;
    title?: string;
    artist?: string;
    album?: string;
    source?: string;
    status?: string;
    progressMs?: number;
    durationMs?: number;
  };

  if (!data.found || !data.title) {
    return null;
  }

  return {
    id: `${data.source ?? "local"}:${data.title}:${data.artist ?? ""}`,
    title: data.title,
    artist: data.artist || "Unknown Artist",
    album: data.album || "Spotify",
    progressMs: Math.max(0, data.progressMs ?? 0),
    durationMs: Math.max(0, data.durationMs ?? 0),
    isPlaying: data.status === "Playing",
    source: data.source ?? "Local media session"
  };
};

// ---------------------------------------------------------------------------
// Discord RPC (Rich Presence) — optional, if client ID provided
// ---------------------------------------------------------------------------

const connectDiscord = async (getWindow?: () => BrowserWindow | null) => {
  if (!state.config.discordClientId) {
    return null; // No client ID — skip RPC, use custom status only
  }

  if (rpcClient) {
    return rpcClient;
  }

  DiscordRPC.register(state.config.discordClientId);
  const client = new DiscordRPC.Client({ transport: "ipc" });

  (client as any).transport?.on?.("close", () => {
    console.warn("[RPC] Discord IPC connection closed unexpectedly");
    rpcClient = null;
    state.discordConnected = false;
    if (getWindow) {
      getWindow()?.webContents.send("rpc:state", state);
    }
  });

  await client.login({ clientId: state.config.discordClientId });
  rpcClient = client;
  state.discordConnected = true;
  console.log("[RPC] Connected to Discord successfully");
  return rpcClient;
};

const clearPresence = async () => {
  if (rpcClient) {
    await rpcClient.clearActivity().catch(() => undefined);
  }
  lastPresenceKey = "";
};

const updatePresence = async (track: SpotifyTrack | null, lyric: string | null) => {
  if (!rpcClient) {
    return; // No RPC client — skip (custom status will handle it)
  }

  if (!track || !track.isPlaying) {
    await clearPresence();
    return;
  }

  const stateText = (state.config.showLyrics && lyric) ? lyric.slice(0, 128) : track.artist.slice(0, 128);

  const presenceKey = `${track.id}:${track.isPlaying}:${stateText}`;
  const now = Date.now();

  if (presenceKey === lastPresenceKey) {
    return;
  }

  const timeSinceLast = now - lastPresenceTime;
  if (lastPresenceTime > 0 && timeSinceLast < MIN_PRESENCE_INTERVAL_MS) {
    return;
  }

  lastPresenceKey = presenceKey;
  lastPresenceTime = now;

  const startTimestamp = Math.floor((Date.now() - track.progressMs) / 1000);
  const endTimestamp = track.durationMs > 0 ? startTimestamp + Math.floor(track.durationMs / 1000) : undefined;

  try {
    await rpcClient.setActivity({
      details: track.title.slice(0, 128),
      state: stateText,
      startTimestamp,
      endTimestamp,
      largeImageKey: "spotify",
      largeImageText: track.album.slice(0, 128),
      smallImageKey: "spotify",
      smallImageText: "Listening on Spotify",
      instance: false
    });
  } catch (err) {
    console.error("[RPC] setActivity FAILED:", err);
    rpcClient = null;
    state.discordConnected = false;
    lastPresenceKey = "";
  }
};

// ---------------------------------------------------------------------------
// Custom Status updater — updates "Rawrr" area with lyrics
// ---------------------------------------------------------------------------

const updateLyricsCustomStatus = async (track: SpotifyTrack | null, lyric: string | null) => {
  const token = state.config.discordUserToken;
  if (!token) {
    return; // No token — skip custom status
  }

  // Build status text
  let statusText: string | null = null;
  if (track?.isPlaying && state.config.showLyrics && lyric) {
    statusText = lyric;
  } else if (track?.isPlaying) {
    statusText = `${track.title} — ${track.artist}`;
  }

  // Skip if text hasn't changed
  const newText = statusText ?? "";
  if (newText === lastCustomStatusText) {
    return;
  }

  // Throttle
  const now = Date.now();
  const timeSinceLast = now - lastCustomStatusTime;
  if (lastCustomStatusTime > 0 && timeSinceLast < MIN_CUSTOM_STATUS_INTERVAL_MS) {
    const waitSec = Math.ceil((MIN_CUSTOM_STATUS_INTERVAL_MS - timeSinceLast) / 1000);
    lastRpcLog = `[Status] ⏳ Throttled — update dalam ${waitSec}s | "${newText.slice(0, 40)}..."`;
    return;
  }

  lastCustomStatusText = newText;
  lastCustomStatusTime = now;

  const ok = await updateCustomStatus(token, statusText);
  if (ok) {
    lastRpcLog = statusText
      ? `[Status] ✓ Custom status → "🎵 ${statusText.slice(0, 60)}..."`
      : "[Status] ✓ Custom status dihapus";
    console.log(lastRpcLog);
  } else {
    lastRpcLog = "[Status] ✗ Gagal update custom status — cek token Discord";
    console.error(lastRpcLog);
  }
};

// ---------------------------------------------------------------------------
// Lyrics integration into poll cycle
// ---------------------------------------------------------------------------

const fetchAndCacheLyrics = async (track: SpotifyTrack, getWindow: () => BrowserWindow | null) => {
  if (!state.config.showLyrics) {
    currentTrackId = track.id;
    currentLyrics = [];
    currentLyricsSynced = false;
    setState(getWindow, { lyricsStatus: "disabled", currentLyric: null });
    return;
  }

  // Only refetch when track changes
  if (track.id === currentTrackId && currentLyrics.length > 0) {
    return;
  }

  currentTrackId = track.id;
  setState(getWindow, { lyricsStatus: "loading", currentLyric: null });

  try {
    const result = await getLyricsForTrack(track.id, track.title, track.artist, track.album, track.durationMs);
    currentLyrics = result.lyrics;
    currentLyricsSynced = result.synced;
    setState(getWindow, { lyricsStatus: result.status });
  } catch {
    currentLyrics = [];
    currentLyricsSynced = false;
    setState(getWindow, { lyricsStatus: "not_found" });
  }
};

const resolveLyric = (track: SpotifyTrack, offsetMs = 0): string | null => {
  if (!state.config.showLyrics || currentLyrics.length === 0) {
    return null;
  }
  return getCurrentLyric(currentLyrics, track.progressMs + offsetMs);
};

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

const pollOnce = async (getWindow: () => BrowserWindow | null) => {
  const track = await readLocalSpotifyTrack();

  let lyric: string | null = null;
  let discordLyric: string | null = null;

  if (track) {
    await fetchAndCacheLyrics(track, getWindow);
    lyric = resolveLyric(track, 0); // Akurat untuk UI app
    discordLyric = resolveLyric(track, 1500); // Trik: offset +1.5 detik untuk menutupi latency/rate limit Discord
  } else {
    if (currentTrackId) {
      currentTrackId = "";
      currentLyrics = [];
      currentLyricsSynced = false;
    }
  }

  // Auto-reconnect RPC if needed and client ID is set
  if (!rpcClient && state.config.discordClientId) {
    try {
      await connectDiscord(getWindow);
    } catch (err) {
      console.warn("[RPC] Reconnect failed:", err);
    }
  }

  // Update Rich Presence (if client ID provided)
  await updatePresence(track, discordLyric);

  // Update Custom Status (if user token provided) — this is the "Rawrr" area
  await updateLyricsCustomStatus(track, discordLyric);

  // Clear custom status when music stops
  if (!track?.isPlaying && lastCustomStatusText && state.config.discordUserToken) {
    await updateCustomStatus(state.config.discordUserToken, null);
    lastCustomStatusText = "";
    lastRpcLog = "[Status] Musik berhenti — custom status dihapus";
  }

  setState(getWindow, {
    mediaSessionAvailable: Boolean(track),
    discordConnected: Boolean(rpcClient) || Boolean(state.config.discordUserToken),
    lastTrack: track,
    currentLyric: lyric,
    error: null,
    message: track?.isPlaying
      ? lastRpcLog || `Update: ${track.title} — ${track.artist}`
      : "Tidak ada lagu Spotify yang sedang diputar."
  });
};

const startPolling = async (getWindow: () => BrowserWindow | null) => {
  const hasToken = Boolean(state.config.discordUserToken);
  const hasClientId = Boolean(state.config.discordClientId);

  if (!hasToken && !hasClientId) {
    throw new Error("Isi minimal Discord User Token (untuk custom status) atau Discord Application ID (untuk Rich Presence).");
  }

  // Connect RPC if client ID is provided
  if (hasClientId) {
    try {
      await connectDiscord(getWindow);
    } catch (err) {
      console.warn("[RPC] Could not connect RPC:", err);
      // Don't throw — we can still use custom status
    }
  }

  setState(getWindow, {
    running: true,
    discordConnected: Boolean(rpcClient) || hasToken,
    error: null,
    message: hasToken ? "Custom status lyrics aktif!" : "Rich Presence aktif."
  });

  await pollOnce(getWindow);

  if (pollTimer) {
    clearInterval(pollTimer);
  }

  pollTimer = setInterval(() => {
    void pollOnce(getWindow).catch((error: unknown) => {
      setState(getWindow, {
        error: error instanceof Error ? error.message : String(error),
        message: "Polling media lokal gagal."
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

  // Clear custom status when stopping
  if (state.config.discordUserToken && lastCustomStatusText) {
    await updateCustomStatus(state.config.discordUserToken, null);
    lastCustomStatusText = "";
  }

  currentTrackId = "";
  currentLyrics = [];
  currentLyricsSynced = false;
  setState(getWindow, {
    running: false,
    currentLyric: null,
    lyricsStatus: state.config.showLyrics ? "synced" : "disabled",
    message: "Realtime update dihentikan."
  });
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

  ipcMain.handle("rpc:start", async () => {
    try {
      await startPolling(getWindow);
    } catch (error) {
      setState(getWindow, {
        running: false,
        error: error instanceof Error ? error.message : String(error),
        message: "Gagal memulai."
      });
    }
    return state;
  });

  ipcMain.handle("rpc:stop", async () => {
    await stopPolling(getWindow);
    return state;
  });
};
