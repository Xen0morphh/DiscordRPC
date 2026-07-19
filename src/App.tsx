import { Activity, CheckCircle2, CircleSlash, Loader2, Mic2, MicOff, Pause, Play, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppConfig, RpcState } from "./vite-env";

const emptyConfig: AppConfig = {
  discordClientId: "",
  discordUserToken: "",
  pollIntervalMs: 3000,
  showAlbumArt: false,
  showLyrics: true
};

const initialState: RpcState = {
  config: emptyConfig,
  mediaSessionAvailable: false,
  discordConnected: false,
  running: false,
  lastTrack: null,
  currentLyric: null,
  lyricsStatus: "disabled",
  message: "Memuat konfigurasi...",
  error: null
};

const formatTime = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const lyricsStatusLabel = (status: string): string => {
  switch (status) {
    case "loading": return "Mencari lyrics…";
    case "synced": return "🎵 Synced lyrics";
    case "plain": return "📝 Plain lyrics (tanpa timestamp)";
    case "not_found": return "Lyrics tidak ditemukan";
    case "disabled": return "Lyrics dinonaktifkan";
    default: return "";
  }
};

export const App = () => {
  const [state, setState] = useState<RpcState>(initialState);
  const [form, setForm] = useState<AppConfig>(emptyConfig);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lyricFade, setLyricFade] = useState(false);
  const api = window.spotifyRpc;

  useEffect(() => {
    if (!api) {
      setState({
        ...initialState,
        message: "Jalankan lewat Electron dengan npm run dev. Halaman localhost di browser biasa tidak punya akses Discord RPC."
      });
      return undefined;
    }

    void api.getState().then((nextState) => {
      setState(nextState);
      setForm(nextState.config);
    });

    return api.onState((nextState) => {
      setState(nextState);
      setForm(nextState.config);
    });
  }, [api]);

  // Trigger fade animation when lyric changes
  const prevLyricRef = useMemo(() => ({ current: "" }), []);
  useEffect(() => {
    const newLyric = state.currentLyric ?? "";
    if (newLyric !== prevLyricRef.current) {
      prevLyricRef.current = newLyric;
      setLyricFade(true);
      const timeout = setTimeout(() => setLyricFade(false), 350);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [state.currentLyric, prevLyricRef]);

  const progressPercent = useMemo(() => {
    if (!state.lastTrack?.durationMs) {
      return 0;
    }
    return Math.min(100, (state.lastTrack.progressMs / state.lastTrack.durationMs) * 100);
  }, [state.lastTrack]);

  const runAction = async (name: string, action: () => Promise<RpcState>) => {
    if (!api) {
      setState((currentState) => ({
        ...currentState,
        error: "Aplikasi harus dijalankan lewat Electron, bukan browser biasa."
      }));
      return;
    }

    setBusyAction(name);
    try {
      const nextState = await action();
      setState(nextState);
      setForm(nextState.config);
    } finally {
      setBusyAction(null);
    }
  };

  const saveConfig = () => runAction("save", () => api!.saveConfig(form));
  const start = () => runAction("start", () => api!.start());
  const stop = () => runAction("stop", () => api!.stop());

  const isBusy = Boolean(busyAction);

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Spotify to Discord</p>
          <h1>Realtime Lyrics Status</h1>
        </div>
        <div className={`status-pill ${state.running ? "active" : ""}`}>
          <Activity size={18} />
          {state.running ? "Live" : "Idle"}
        </div>
      </section>

      <section className="workspace">
        <aside className="settings-panel">
          <div className="section-title">
            <h2>Konfigurasi</h2>
            <button className="icon-button" onClick={saveConfig} disabled={isBusy || !api} title="Simpan konfigurasi">
              {busyAction === "save" ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
            </button>
          </div>

          <label>
            🔑 Discord User Token
            <input
              type="password"
              value={form.discordUserToken}
              onChange={(event) => setForm({ ...form, discordUserToken: event.target.value })}
              placeholder="Token untuk update custom status"
            />
            <span className="field-hint">Lyrics muncul di custom status (area 'Rawrr')</span>
          </label>

          <label>
            Discord Application ID <span className="optional-badge">Opsional</span>
            <input
              value={form.discordClientId}
              onChange={(event) => setForm({ ...form, discordClientId: event.target.value })}
              placeholder="Untuk Rich Presence (Playing...)"
            />
          </label>

          <label>
            Polling interval
            <select
              value={form.pollIntervalMs}
              onChange={(event) => setForm({ ...form, pollIntervalMs: Number(event.target.value) })}
            >
              <option value={1000}>1 detik</option>
              <option value={2000}>2 detik</option>
              <option value={3000}>3 detik</option>
              <option value={5000}>5 detik</option>
              <option value={10000}>10 detik</option>
              <option value={15000}>15 detik</option>
            </select>
          </label>

          <div className="toggle-row">
            <span>Show Lyrics di Discord</span>
            <input
              type="checkbox"
              checked={form.showLyrics}
              onChange={(event) => setForm({ ...form, showLyrics: event.target.checked })}
            />
          </div>

          <div className="connection-grid">
            <div>
              {state.mediaSessionAvailable ? <CheckCircle2 size={18} /> : <CircleSlash size={18} />}
              Media lokal
            </div>
            <div>
              {state.discordConnected ? <CheckCircle2 size={18} /> : <CircleSlash size={18} />}
              Discord
            </div>
          </div>
        </aside>

        <section className="player-panel">
          <div className="section-title">
            <h2>Sekarang Diputar</h2>
            <div className="actions">
              {state.running ? (
                <button className="danger" onClick={stop} disabled={isBusy || !api}>
                  <Pause size={18} />
                  Stop
                </button>
              ) : (
                <button className="primary" onClick={start} disabled={isBusy || !api}>
                  {busyAction === "start" ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                  Start
                </button>
              )}
            </div>
          </div>

          <div className="now-playing">
            <div className="album-placeholder">
              <Activity size={44} />
            </div>

            <div className="track-info">
              <p className="track-status">{state.lastTrack?.isPlaying ? "Playing" : "No active playback"}</p>
              <h3>{state.lastTrack?.title ?? "Belum ada lagu terdeteksi"}</h3>
              <p>{state.lastTrack?.artist ?? "Putar lagu di Spotify desktop lalu tekan Start."}</p>
              <span>{state.lastTrack?.album ?? "Tanpa Spotify Web API, tanpa login Spotify, tanpa premium."}</span>
            </div>
          </div>

          <div className="progress-wrap">
            <div className="progress-meta">
              <span>{formatTime(state.lastTrack?.progressMs ?? 0)}</span>
              <span>{formatTime(state.lastTrack?.durationMs ?? 0)}</span>
            </div>
            <div className="progress-track">
              <div style={{ width: `${progressPercent}%` }} />
            </div>
          </div>

          {/* Lyrics Section */}
          <div className="lyrics-section">
            <div className="lyrics-header">
              <div className="lyrics-title">
                {form.showLyrics ? <Mic2 size={18} /> : <MicOff size={18} />}
                <span>Lyrics</span>
              </div>
              <span className={`lyrics-badge ${state.lyricsStatus}`}>
                {lyricsStatusLabel(state.lyricsStatus)}
              </span>
            </div>

            <div className="lyrics-display">
              {state.lyricsStatus === "loading" && (
                <div className="lyrics-loading">
                  <Loader2 className="spin" size={22} />
                  <span>Mencari lyrics…</span>
                </div>
              )}

              {(state.lyricsStatus === "synced" || state.lyricsStatus === "plain") && state.currentLyric && (
                <p className={`lyric-line ${lyricFade ? "fade-in" : ""}`}>
                  {state.currentLyric}
                </p>
              )}

              {(state.lyricsStatus === "synced" || state.lyricsStatus === "plain") && !state.currentLyric && state.lastTrack?.isPlaying && (
                <p className="lyric-line waiting">♪ . . .</p>
              )}

              {state.lyricsStatus === "not_found" && (
                <p className="lyric-line not-found">Lyrics tidak tersedia untuk lagu ini</p>
              )}

              {state.lyricsStatus === "disabled" && (
                <p className="lyric-line not-found">Aktifkan "Show Lyrics" di settings</p>
              )}

              {!state.lastTrack?.isPlaying && state.lyricsStatus !== "loading" && state.lyricsStatus !== "disabled" && (
                <p className="lyric-line not-found">Putar lagu untuk melihat lyrics</p>
              )}
            </div>
          </div>

          <div className={`message-box ${state.error ? "error" : ""}`}>
            <strong>{state.error ? "Error" : "Status"}</strong>
            <span>{state.error ?? state.message}</span>
          </div>
        </section>
      </section>
    </main>
  );
};
