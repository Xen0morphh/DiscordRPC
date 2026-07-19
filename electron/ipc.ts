import { BrowserWindow, app, ipcMain } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { promisify } from "node:util";
import DiscordRPC from "discord-rpc";
import type { AppConfig, LyricLine, RpcState, SpotifyTrack } from "./types.js";
import { getLyricsForTrack } from "./lyrics.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SPOTIFY_ICON_URL = "spotify";

const defaultConfig: AppConfig = {
  discordClientId: "",
  discordUserToken: "",
  pollIntervalMs: 3000,
  showAlbumArt: false,
  showLyrics: true,
  lyricsOffsetMs: 0,
  largeImageKey: DEFAULT_SPOTIFY_ICON_URL
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
let rpcConnecting = false;
let lastRpcConnectAttemptTime = 0;
const RPC_RECONNECT_INTERVAL_MS = 20_000; // Rate-limit connection attempts to 20s
let pollTimer: NodeJS.Timeout | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let lastPresenceKey = "";
let lastPresenceTime = 0;
const MIN_PRESENCE_INTERVAL_MS = 1_500;

// Custom status state — queued, non-blocking updater
let lastCustomStatusText = "";
let customStatusInFlight = false;
let pendingCustomStatus: { text: string | null; token: string } | null = null;
let lockoutUntil = 0;
let lastSuccessfulRequestTime = 0;
const MIN_UPDATE_INTERVAL_MS = 4000; // rate limit: maximum 1 request per 4s to avoid Discord 429 lockout

// Lyrics state
let currentTrackId = "";
let currentLyrics: LyricLine[] = [];
let currentLyricsSynced = false;

// Realtime track interpolation state
let lastTrackFetchTime = 0;
let lastBaselineTrack: SpotifyTrack | null = null;

// Last RPC action log (forwarded to UI)
let lastRpcLog = "";

const configPath = () => path.join(app.getPath("userData"), "config.json");

const sanitizeConfig = (input: Partial<AppConfig>): AppConfig => ({
  discordClientId: String(input.discordClientId ?? "").trim(),
  discordUserToken: String(input.discordUserToken ?? "").trim(),
  pollIntervalMs: Math.min(Math.max(Number(input.pollIntervalMs) || 3000, 500), 30000),
  showAlbumArt: false,
  showLyrics: input.showLyrics !== false,
  lyricsOffsetMs: Math.min(Math.max(Number(input.lyricsOffsetMs) || 0, -10000), 10000),
  largeImageKey: String(input.largeImageKey ?? "").trim() || DEFAULT_SPOTIFY_ICON_URL
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
            if (res.statusCode === 429) {
              try {
                const parsed = JSON.parse(data) as { retry_after?: number };
                if (parsed.retry_after) {
                  lockoutUntil = Date.now() + (parsed.retry_after * 1000);
                  console.warn(`[CustomStatus] Rate limited. Lockout set for ${parsed.retry_after}s`);
                }
              } catch {
                lockoutUntil = Date.now() + 10000;
              }
            }
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
    {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1024 * 128,
      cwd: app.getPath("temp")
    }
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

  const imageKey = state.config.largeImageKey || DEFAULT_SPOTIFY_ICON_URL;

  try {
    await rpcClient.setActivity({
      details: track.title.slice(0, 128),
      state: stateText,
      startTimestamp,
      endTimestamp,
      largeImageKey: imageKey,
      largeImageText: track.album.slice(0, 128),
      smallImageKey: imageKey,
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
// Custom Status updater — debounced + non-blocking queued updates
// ---------------------------------------------------------------------------

/** Flush one queued custom status update. If a newer update arrived while
 *  the HTTP request was in flight, it will be sent immediately after. */
const flushCustomStatus = async () => {
  while (pendingCustomStatus) {
    // 1. Handle 429 lockout sleep
    const now = Date.now();
    if (now < lockoutUntil) {
      const waitTime = lockoutUntil - now;
      console.warn(`[CustomStatus] Rate limited. Waiting ${Math.ceil(waitTime / 1000)}s before flushing...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // 2. Handle successful request minimum interval sleep
    const timeSinceLast = Date.now() - lastSuccessfulRequestTime;
    if (timeSinceLast < MIN_UPDATE_INTERVAL_MS) {
      const waitTime = MIN_UPDATE_INTERVAL_MS - timeSinceLast;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Double check if pendingCustomStatus was overwritten during sleep
    if (!pendingCustomStatus) {
      break;
    }

    const { text, token } = pendingCustomStatus;
    pendingCustomStatus = null; // consume
    customStatusInFlight = true;

    const ok = await updateCustomStatus(token, text);
    customStatusInFlight = false;

    if (ok) {
      lastSuccessfulRequestTime = Date.now();
      lastRpcLog = text
        ? `[Status] ✓ Custom status → "🎵 ${text.slice(0, 60)}..."`
        : "[Status] ✓ Custom status dihapus";
      console.log(lastRpcLog);
    } else {
      lastRpcLog = "[Status] ✗ Gagal update custom status — cek token Discord";
      console.error(lastRpcLog);
    }
  }
};

// Debounce timer — waits for lyric to settle before sending to Discord
let customStatusDebounceTimer: NodeJS.Timeout | null = null;
let customStatusDebounceText = ""; // what text is currently being debounced
const CUSTOM_STATUS_DEBOUNCE_MS = 1000; // wait 1s before sending to Discord to handle quick skips

/** Enqueue a custom status update with debounce. The status only fires
 *  after the lyric text has been stable for CUSTOM_STATUS_DEBOUNCE_MS,
 *  preventing rapid back-and-forth flicker on Discord. */
const updateLyricsCustomStatus = (track: SpotifyTrack | null, lyric: string | null) => {
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

  const newText = statusText ?? "";

  // Skip if already sent this exact text
  if (newText === lastCustomStatusText) {
    return;
  }

  // Skip if this exact text is already being debounced (don't reset the timer!)
  if (newText === customStatusDebounceText && customStatusDebounceTimer) {
    return;
  }

  // A genuinely different text arrived — clear any pending debounce
  if (customStatusDebounceTimer) {
    clearTimeout(customStatusDebounceTimer);
    customStatusDebounceTimer = null;
  }

  // If clearing status (music stopped), send immediately
  if (!statusText) {
    customStatusDebounceText = "";
    lastCustomStatusText = newText;
    pendingCustomStatus = { text: null, token };
    if (!customStatusInFlight) {
      void flushCustomStatus();
    }
    return;
  }

  // Debounce: wait for lyric to settle before sending to Discord.
  customStatusDebounceText = newText;
  customStatusDebounceTimer = setTimeout(() => {
    customStatusDebounceTimer = null;
    customStatusDebounceText = "";
    lastCustomStatusText = newText;
    pendingCustomStatus = { text: statusText, token };
    if (!customStatusInFlight) {
      void flushCustomStatus();
    }
  }, CUSTOM_STATUS_DEBOUNCE_MS);
};

// ---------------------------------------------------------------------------
// Lyrics integration into poll cycle
// ---------------------------------------------------------------------------

let fetchedTrackId = "";

const fetchAndCacheLyrics = async (track: SpotifyTrack, getWindow: () => BrowserWindow | null) => {
  if (!state.config.showLyrics) {
    fetchedTrackId = track.id;
    currentTrackId = track.id;
    currentLyrics = [];
    currentLyricsSynced = false;
    setState(getWindow, { lyricsStatus: "disabled", currentLyric: null });
    return;
  }

  // Only refetch when track genuinely changes
  if (track.id === fetchedTrackId) {
    return;
  }

  fetchedTrackId = track.id;
  currentTrackId = track.id;
  lastLyricIndex = -1;
  setState(getWindow, { lyricsStatus: "loading" });

  try {
    const result = await getLyricsForTrack(track.id, track.title, track.artist, track.album, track.durationMs);
    currentLyrics = result.lyrics;
    currentLyricsSynced = result.synced;
    setState(getWindow, { lyricsStatus: result.status });
  } catch {
    currentLyrics = [];
    currentLyricsSynced = false;
    setState(getWindow, { lyricsStatus: "not_found", currentLyric: null });
  }
};

const getCurrentLyricIndex = (lyrics: LyricLine[], progressMs: number): number => {
  if (lyrics.length === 0) return -1;

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

  return result;
};

// Track the last seen lyric index to prevent backwards flickering
let lastLyricIndex = -1;

const resolveLyric = (progressMs: number): string | null => {
  if (!state.config.showLyrics || currentLyrics.length === 0 || !currentLyricsSynced) {
    return null;
  }

  const userOffset = state.config.lyricsOffsetMs || 0;
  const idx = getCurrentLyricIndex(currentLyrics, progressMs + userOffset);
  if (idx < 0) return null;

  // Prevent flickering: if the new index is slightly behind the current one,
  // ignore it unless it's a big jump (which means a genuine seek backwards).
  if (lastLyricIndex >= 0 && idx < lastLyricIndex) {
    const linesBackward = lastLyricIndex - idx;
    if (linesBackward <= 4) {
      // Small jitter — hold the current lyric safely
      return currentLyrics[lastLyricIndex]?.text ?? currentLyrics[idx].text;
    }
  }

  lastLyricIndex = idx;
  return currentLyrics[idx].text;
};

// ---------------------------------------------------------------------------
// Interpolate current progress from baseline (single source of truth)
// ---------------------------------------------------------------------------

const getInterpolatedProgress = (): number => {
  if (!lastBaselineTrack) return 0;
  if (!lastBaselineTrack.isPlaying) return lastBaselineTrack.progressMs;
  const elapsed = Math.max(0, Date.now() - lastTrackFetchTime);
  return Math.min(
    lastBaselineTrack.durationMs || Infinity,
    lastBaselineTrack.progressMs + elapsed
  );
};

// ---------------------------------------------------------------------------
// Polling & Real-time Ticker
// ---------------------------------------------------------------------------

/**
 * tickRealtime — THE SOLE SOURCE OF TRUTH for lyric state, UI, and Discord.
 * Runs every 100ms. Interpolates progress from baseline, resolves lyric,
 * publishes state, and triggers Discord updates.
 */
const tickRealtime = async (getWindow: () => BrowserWindow | null) => {
  if (!state.running || !lastBaselineTrack || !lastBaselineTrack.isPlaying) {
    return;
  }

  const currentProgressMs = getInterpolatedProgress();

  const updatedTrack: SpotifyTrack = {
    ...lastBaselineTrack,
    progressMs: currentProgressMs
  };

  const lyric = resolveLyric(currentProgressMs);

  let updatedState = false;

  if (state.currentLyric !== lyric) {
    state.currentLyric = lyric;
    updatedState = true;
  }

  // Continuously update progressMs for smooth UI progress bar & timer display
  state.lastTrack = updatedTrack;
  updatedState = true;

  if (updatedState) {
    publish(getWindow);
  }

  // Discord updates (custom status is debounced + non-blocking)
  updateLyricsCustomStatus(updatedTrack, lyric);
  await updatePresence(updatedTrack, lyric);
};

/**
 * pollOnce — PURE DATA FETCHER. Only updates the baseline track position
 * and fetches/caches lyrics. Does NOT compute or publish lyric state.
 * tickRealtime handles all output.
 */
const pollOnce = async (getWindow: () => BrowserWindow | null) => {
  const fetchStartTime = Date.now();
  const track = await readLocalSpotifyTrack();
  const fetchEndTime = Date.now();

  // Baseline time set to the start of PowerShell execution to compensate for
  // script execution latency and Windows Media Session snapshot lag.
  const newFetchTime = fetchStartTime;

  if (track) {
    // Track changed OR playback state changed → reset everything and accept new baseline
    if (track.id !== lastBaselineTrack?.id || track.isPlaying !== lastBaselineTrack?.isPlaying) {
      lastLyricIndex = -1;
      lastTrackFetchTime = newFetchTime;
      lastBaselineTrack = track;
    } else {
      // Same track and same playing state — check for backwards time jitter.
      // Compare what we'd interpolate NOW with old vs new baseline:
      const oldInterpolated = getInterpolatedProgress();
      const newInterpolated = track.progressMs + Math.max(0, Date.now() - newFetchTime);
      const diff = newInterpolated - oldInterpolated;

      if (diff < -4000) {
        // Large backward jump (>4s) → genuine seek backwards
        lastTrackFetchTime = newFetchTime;
        lastBaselineTrack = track;
      } else if (diff >= -500) {
        // Forward or tiny jitter → accept new baseline
        lastTrackFetchTime = newFetchTime;
        lastBaselineTrack = track;
      }
      // else: moderate backward jitter (-500ms to -4000ms) → keep old baseline (ignore stale read)
    }

    await fetchAndCacheLyrics(track, getWindow);
  } else {
    lastTrackFetchTime = newFetchTime;
    lastBaselineTrack = track;
    if (currentTrackId) {
      currentTrackId = "";
      currentLyrics = [];
      currentLyricsSynced = false;
      lastLyricIndex = -1;
    }
  }

  // Auto-reconnect RPC if needed and client ID is set (non-blocking, rate-limited)
  if (!rpcClient && state.config.discordClientId && !rpcConnecting) {
    const now = Date.now();
    if (now - lastRpcConnectAttemptTime > RPC_RECONNECT_INTERVAL_MS) {
      rpcConnecting = true;
      lastRpcConnectAttemptTime = now;
      connectDiscord(getWindow)
        .catch((err) => console.warn("[RPC] Reconnect failed:", err instanceof Error ? err.message : String(err)))
        .finally(() => {
          rpcConnecting = false;
        });
    }
  }

  // Clear custom status when music stops
  if (!track?.isPlaying && lastCustomStatusText && state.config.discordUserToken) {
    await updateCustomStatus(state.config.discordUserToken, null);
    lastCustomStatusText = "";
    lastRpcLog = "[Status] Musik berhenti — custom status dihapus";
  }

  const currentProgressMs = (lastBaselineTrack && lastBaselineTrack.isPlaying)
    ? Math.min(
        lastBaselineTrack.durationMs || Infinity,
        lastBaselineTrack.progressMs + Math.max(0, Date.now() - lastTrackFetchTime)
      )
    : (lastBaselineTrack?.progressMs ?? 0);

  const currentTrackWithProgress = lastBaselineTrack
    ? { ...lastBaselineTrack, progressMs: currentProgressMs }
    : track;

  // Minimal state update — only metadata, NOT lyric (tickRealtime handles that)
  setState(getWindow, {
    mediaSessionAvailable: Boolean(track),
    discordConnected: Boolean(rpcClient) || Boolean(state.config.discordUserToken),
    lastTrack: currentTrackWithProgress,
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
  if (tickTimer) {
    clearInterval(tickTimer);
  }

  pollTimer = setInterval(() => {
    void pollOnce(getWindow).catch((error: unknown) => {
      setState(getWindow, {
        error: error instanceof Error ? error.message : String(error),
        message: "Polling media lokal gagal."
      });
    });
  }, state.config.pollIntervalMs);

  // Sub-second high frequency tick for instant real-time lyric transitions (50ms)
  tickTimer = setInterval(() => {
    void tickRealtime(getWindow).catch((err) => {
      console.error("[Realtime] Tick error:", err);
    });
  }, 50);
};

const stopPolling = async (getWindow: () => BrowserWindow | null) => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (customStatusDebounceTimer) {
    clearTimeout(customStatusDebounceTimer);
    customStatusDebounceTimer = null;
  }
  await clearPresence();

  // Clear custom status when stopping
  if (state.config.discordUserToken && lastCustomStatusText) {
    await updateCustomStatus(state.config.discordUserToken, null);
    lastCustomStatusText = "";
  }

  fetchedTrackId = "";
  currentTrackId = "";
  currentLyrics = [];
  currentLyricsSynced = false;
  lastLyricIndex = -1;
  lastBaselineTrack = null;
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
