import { BrowserWindow, app, ipcMain } from "electron";
import { execFile, spawn, ChildProcess } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { promisify } from "node:util";
import DiscordRPC from "discord-rpc";
import type { AppConfig, LyricLine, RpcState, SpotifyTrack } from "./types.js";
import { getLyricsForTrack } from "./lyrics.js";
import { t } from "./translations.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SPOTIFY_ICON_URL = "spotify";

const defaultConfig: AppConfig = {
  discordClientId: "",
  discordUserToken: "",
  pollIntervalMs: 3000,
  showAlbumArt: false,
  showLyrics: true,
  lyricsOffsetMs: 0,
  largeImageKey: DEFAULT_SPOTIFY_ICON_URL,
  language: "en",
  discordStatusMode: "safe"
};

type PersistedState = {
  config: AppConfig;
};

let state: RpcState;

const tState = (key: Parameters<typeof t>[0], variables?: Parameters<typeof t>[2]) => {
  return t(key, state?.config?.language || "en", variables);
};

state = {
  config: defaultConfig,
  mediaSessionAvailable: false,
  discordConnected: false,
  running: false,
  lastTrack: null,
  currentLyric: null,
  lyricsStatus: "disabled",
  message: tState("msgInitialPrompt"),
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
const getMinUpdateIntervalMs = () => {
  return state?.config?.discordStatusMode === "aesthetic" ? 3000 : 5000;
};

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
  pollIntervalMs: Math.min(Math.max(Number(input.pollIntervalMs) || 3000, 100), 30000),
  showAlbumArt: false,
  showLyrics: input.showLyrics !== false,
  lyricsOffsetMs: Math.min(Math.max(Number(input.lyricsOffsetMs) || 0, -10000), 10000),
  largeImageKey: String(input.largeImageKey ?? "").trim() || DEFAULT_SPOTIFY_ICON_URL,
  language: String(input.language || "en").trim(),
  discordStatusMode: String(input.discordStatusMode || "safe").trim()
});

const publish = (getWindow: () => BrowserWindow | null) => {
  const win = getWindow();
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    try {
      win.webContents.send("rpc:state", state);
    } catch (e) {
      console.warn("[IPC] Failed to send state to window:", e);
    }
  }
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

while ($line = [Console]::ReadLine()) {
  try {
    $manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $managerType
    $sessions = @($manager.GetSessions())
    $session = $sessions | Where-Object { $_.SourceAppUserModelId -like '*Spotify*' } | Select-Object -First 1
    if ($null -eq $session) {
      Write-Output '{"found":false}'
    } else {
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
      } | ConvertTo-Json -Compress | Write-Output
    }
  } catch {
    Write-Output '{"found":false}'
  }
}
`;

let powershellProcess: ChildProcess | null = null;
let powershellReader: readline.Interface | null = null;
let pendingQueryPromise: {
  resolve: (value: SpotifyTrack | null) => void;
  reject: (err: Error) => void;
} | null = null;

const killPowershellProcess = () => {
  if (powershellProcess) {
    try {
      powershellProcess.kill();
    } catch (e) {
      console.error("[PowerShell] Error killing process:", e);
    }
    powershellProcess = null;
  }
  if (powershellReader) {
    try {
      powershellReader.close();
    } catch (e) {}
    powershellReader = null;
  }
  if (pendingQueryPromise) {
    pendingQueryPromise.resolve(null);
    pendingQueryPromise = null;
  }
};

const ensurePowershellProcess = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (powershellProcess && powershellReader) {
      resolve();
      return;
    }

    try {
      console.log("[PowerShell] Spawning persistent PowerShell process...");
      const ps = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", mediaSessionScript],
        {
          windowsHide: true,
          cwd: app.getPath("temp")
        }
      );

      powershellProcess = ps;

      ps.on("error", (err) => {
        console.error("[PowerShell] Process error:", err);
        killPowershellProcess();
      });

      ps.on("exit", (code, signal) => {
        console.warn(`[PowerShell] Process exited with code ${code}, signal ${signal}`);
        killPowershellProcess();
      });

      const reader = readline.createInterface({
        input: ps.stdout!,
        terminal: false
      });
      powershellReader = reader;

      ps.stderr!.on("data", (data) => {
        console.error("[PowerShell stderr]:", data.toString());
      });

      let initResolved = false;
      const initTimeout = setTimeout(() => {
        if (!initResolved) {
          console.error("[PowerShell] Initialization timed out");
          killPowershellProcess();
          reject(new Error("PowerShell initialization timed out"));
        }
      }, 8000);

      reader.on("line", (line) => {
        if (!initResolved) {
          initResolved = true;
          clearTimeout(initTimeout);
          console.log("[PowerShell] Persistent process initialized successfully.");
          resolve();
          return;
        }

        if (pendingQueryPromise) {
          const res = pendingQueryPromise.resolve;
          pendingQueryPromise = null;
          res(parseSpotifyJson(line));
        }
      });

      // Trigger first output to verify it is up and running
      ps.stdin!.write("QUERY\n");

    } catch (err) {
      console.error("[PowerShell] Failed to spawn:", err);
      killPowershellProcess();
      reject(err);
    }
  });
};

const parseSpotifyJson = (line: string): SpotifyTrack | null => {
  try {
    const data = JSON.parse(line.trim() || "{}") as {
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
  } catch (e) {
    console.error("[PowerShell] JSON parse error:", e);
    return null;
  }
};

const readLocalSpotifyTrack = async (): Promise<SpotifyTrack | null> => {
  if (process.platform !== "win32") {
    throw new Error(tState("msgWinMediaSessionRequired"));
  }

  try {
    await ensurePowershellProcess();
  } catch (err) {
    console.error("[PowerShell] ensurePowershellProcess failed:", err);
    return null;
  }

  const proc = powershellProcess;
  const input = powershellProcess?.stdin;
  if (!proc || !input) {
    return null;
  }

  return new Promise<SpotifyTrack | null>((resolve) => {
    if (pendingQueryPromise) {
      pendingQueryPromise.resolve(null);
    }

    const queryTimeout = setTimeout(() => {
      console.warn("[PowerShell] Query timed out");
      if (pendingQueryPromise) {
        pendingQueryPromise.resolve(null);
        pendingQueryPromise = null;
      }
      killPowershellProcess();
    }, 4000);

    pendingQueryPromise = {
      resolve: (track) => {
        clearTimeout(queryTimeout);
        resolve(track);
      },
      reject: () => {
        clearTimeout(queryTimeout);
        resolve(null);
      }
    };

    input.write("QUERY\n");
  });
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
const flushCustomStatus = async (getWindow: () => BrowserWindow | null) => {
  while (pendingCustomStatus) {
    // 1. Handle 429 lockout sleep
    const now = Date.now();
    if (now < lockoutUntil) {
      const waitTime = lockoutUntil - now;
      const seconds = Math.ceil(waitTime / 1000);
      lastRpcLog = `[Status] ✗ Discord rate limit — waiting ${seconds}s`;
      console.warn(`[CustomStatus] Rate limited. Waiting ${seconds}s before flushing...`);
      setState(getWindow, { error: lastRpcLog });
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // 2. Handle successful request minimum interval sleep
    const timeSinceLast = Date.now() - lastSuccessfulRequestTime;
    const minInterval = getMinUpdateIntervalMs();
    if (timeSinceLast < minInterval) {
      const waitTime = minInterval - timeSinceLast;
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
        ? tState("msgCustomStatusUpdateSuccess", { text: text.slice(0, 60) })
        : tState("msgCustomStatusCleared");
      console.log(lastRpcLog);
      setState(getWindow, { message: lastRpcLog, error: null });
    } else {
      const currentNow = Date.now();
      if (currentNow < lockoutUntil) {
        const seconds = Math.ceil((lockoutUntil - currentNow) / 1000);
        lastRpcLog = `[Status] ✗ Rate limited by Discord — frozen for ${seconds}s`;
      } else {
        lastRpcLog = tState("msgCustomStatusUpdateFailed");
      }
      console.error(lastRpcLog);
      setState(getWindow, { error: lastRpcLog });
    }
  }
};

// Debounce timer — waits for lyric to settle before sending to Discord
let customStatusDebounceTimer: NodeJS.Timeout | null = null;
let customStatusDebounceText = ""; // what text is currently being debounced
const getCustomStatusDebounceMs = () => {
  return state?.config?.discordStatusMode === "aesthetic" ? 1000 : 2500;
};

/** Enqueue a custom status update with debounce. The status only fires
 *  after the lyric text has been stable for getCustomStatusDebounceMs(),
 *  preventing rapid back-and-forth flicker on Discord. */
const updateLyricsCustomStatus = (track: SpotifyTrack | null, lyric: string | null, getWindow: () => BrowserWindow | null) => {
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
      void flushCustomStatus(getWindow);
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
      void flushCustomStatus(getWindow);
    }
  }, getCustomStatusDebounceMs());
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

  // Discord updates (custom status is debounced + non-blocking)
  updateLyricsCustomStatus(updatedTrack, lyric, getWindow);
  void updatePresence(updatedTrack, lyric).catch((err) => {
    console.error("[RPC] updatePresence error:", err);
  });

  if (updatedState) {
    // Only update lastTrack and publish state to UI on lyric change
    state.lastTrack = updatedTrack;
    publish(getWindow);
  }
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

  let baselineUpdated = false;

  if (track) {
    // Track changed OR playback state changed → reset everything and accept new baseline
    if (track.id !== lastBaselineTrack?.id || track.isPlaying !== lastBaselineTrack?.isPlaying) {
      lastLyricIndex = -1;
      lastTrackFetchTime = newFetchTime;
      lastBaselineTrack = track;
      baselineUpdated = true;
    } else {
      // Same track and same playing state.
      // Compare what we'd interpolate NOW with the new reading:
      const oldInterpolated = getInterpolatedProgress();
      const newInterpolated = track.progressMs + Math.max(0, Date.now() - newFetchTime);
      const diff = newInterpolated - oldInterpolated;

      // Only accept the new baseline if it represents a significant seek/drift (>3.0s)
      if (Math.abs(diff) > 3000) {
        lastTrackFetchTime = newFetchTime;
        lastBaselineTrack = track;
        baselineUpdated = true;
      }
      // Otherwise: keep the current baseline running to avoid any backward jitter or stuttering.
    }

    await fetchAndCacheLyrics(track, getWindow);
  } else {
    if (lastBaselineTrack !== null) {
      lastTrackFetchTime = newFetchTime;
      lastBaselineTrack = null;
      baselineUpdated = true;
    }
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
    lastRpcLog = tState("msgMusicStoppedStatusCleared");
  }

  const mediaSessionAvailable = Boolean(track);
  const discordConnected = Boolean(rpcClient) || Boolean(state.config.discordUserToken);

  const trackChanged = track?.id !== state.lastTrack?.id;
  const playStateChanged = track?.isPlaying !== state.lastTrack?.isPlaying;
  const sessionAvailabilityChanged = mediaSessionAvailable !== state.mediaSessionAvailable;
  const connectionChanged = discordConnected !== state.discordConnected;

  const currentProgressMs = (lastBaselineTrack && lastBaselineTrack.isPlaying)
    ? Math.min(
        lastBaselineTrack.durationMs || Infinity,
        lastBaselineTrack.progressMs + Math.max(0, Date.now() - lastTrackFetchTime)
      )
    : (lastBaselineTrack?.progressMs ?? 0);

  const currentTrackWithProgress = lastBaselineTrack
    ? { ...lastBaselineTrack, progressMs: currentProgressMs }
    : null;

  // Only publish if something meaningful changed or seek baseline updated.
  if (trackChanged || playStateChanged || sessionAvailabilityChanged || connectionChanged || baselineUpdated) {
    setState(getWindow, {
      mediaSessionAvailable,
      discordConnected,
      lastTrack: currentTrackWithProgress,
      error: null,
      message: track?.isPlaying
        ? lastRpcLog || tState("msgUpdateTrack", { title: track.title, artist: track.artist })
        : tState("msgNoSpotifyPlayback")
    });
  }
};

const runPollCycle = (getWindow: () => BrowserWindow | null) => {
  if (!state.running) return;

  void pollOnce(getWindow)
    .catch((error: unknown) => {
      setState(getWindow, {
        error: error instanceof Error ? error.message : String(error),
        message: tState("msgLocalMediaPollFailed")
      });
    })
    .finally(() => {
      if (state.running) {
        pollTimer = setTimeout(() => runPollCycle(getWindow), state.config.pollIntervalMs);
      }
    });
};

const startPolling = async (getWindow: () => BrowserWindow | null) => {
  const hasToken = Boolean(state.config.discordUserToken);
  const hasClientId = Boolean(state.config.discordClientId);

  if (!hasToken && !hasClientId) {
    throw new Error(tState("msgTokenOrClientIdRequired"));
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
    message: hasToken ? tState("msgCustomStatusLyricsActive") : tState("msgRichPresenceActive")
  });

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  // Start polling cycle (non-overlapping setTimeout loop)
  runPollCycle(getWindow);

  // Sub-second high frequency tick for instant real-time lyric transitions (50ms)
  tickTimer = setInterval(() => {
    void tickRealtime(getWindow).catch((err) => {
      console.error("[Realtime] Tick error:", err);
    });
  }, 50);
};

const stopPolling = async (getWindow: () => BrowserWindow | null) => {
  killPowershellProcess();

  if (pollTimer) {
    clearTimeout(pollTimer);
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
  if (state.config.discordUserToken) {
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
    message: tState("msgRealtimeUpdateStopped")
  });
};

export const setupIpc = (getWindow: () => BrowserWindow | null) => {
  void loadPersisted().then(() => publish(getWindow));

  let isQuitting = false;
  app.on("will-quit", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      isQuitting = true;
      console.log("[Quit] Cleaning up Discord presence and custom status before exit...");
      stopPolling(getWindow)
        .catch((err) => console.error("[Quit] Cleanup failed:", err))
        .finally(() => {
          app.quit();
        });
    }
  });

  ipcMain.handle("rpc:get-state", () => state);

  ipcMain.handle("rpc:save-config", async (_event, input: Partial<AppConfig>) => {
    state.config = sanitizeConfig(input);
    await savePersisted();
    setState(getWindow, { config: state.config, message: tState("msgConfigSaved"), error: null });
    return state;
  });

  ipcMain.handle("rpc:start", async () => {
    try {
      await startPolling(getWindow);
    } catch (error) {
      setState(getWindow, {
        running: false,
        error: error instanceof Error ? error.message : String(error),
        message: tState("msgStartFailed")
      });
    }
    return state;
  });

  ipcMain.handle("rpc:stop", async () => {
    await stopPolling(getWindow);
    return state;
  });
};
