import { Activity, CheckCircle2, CircleSlash, ExternalLink, Loader2, Pause, Play, Save, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppConfig, RpcState } from "./vite-env";

const emptyConfig: AppConfig = {
  spotifyClientId: "",
  discordClientId: "",
  pollIntervalMs: 5000,
  showAlbumArt: true,
  showButtons: true
};

const initialState: RpcState = {
  config: emptyConfig,
  spotifyConnected: false,
  discordConnected: false,
  running: false,
  authInProgress: false,
  lastTrack: null,
  message: "Memuat konfigurasi...",
  error: null
};

const formatTime = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export const App = () => {
  const [state, setState] = useState<RpcState>(initialState);
  const [form, setForm] = useState<AppConfig>(emptyConfig);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    void window.spotifyRpc.getState().then((nextState) => {
      setState(nextState);
      setForm(nextState.config);
    });

    return window.spotifyRpc.onState((nextState) => {
      setState(nextState);
      setForm(nextState.config);
    });
  }, []);

  const progressPercent = useMemo(() => {
    if (!state.lastTrack?.durationMs) {
      return 0;
    }
    return Math.min(100, (state.lastTrack.progressMs / state.lastTrack.durationMs) * 100);
  }, [state.lastTrack]);

  const runAction = async (name: string, action: () => Promise<RpcState>) => {
    setBusyAction(name);
    try {
      const nextState = await action();
      setState(nextState);
      setForm(nextState.config);
    } finally {
      setBusyAction(null);
    }
  };

  const saveConfig = () => runAction("save", () => window.spotifyRpc.saveConfig(form));
  const connectSpotify = () => runAction("connect", () => window.spotifyRpc.connectSpotify());
  const start = () => runAction("start", () => window.spotifyRpc.start());
  const stop = () => runAction("stop", () => window.spotifyRpc.stop());
  const disconnect = () => runAction("disconnect", () => window.spotifyRpc.disconnectSpotify());

  const isBusy = Boolean(busyAction) || state.authInProgress;

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Spotify to Discord</p>
          <h1>Realtime Rich Presence</h1>
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
            <button className="icon-button" onClick={saveConfig} disabled={isBusy} title="Simpan konfigurasi">
              {busyAction === "save" ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
            </button>
          </div>

          <label>
            Spotify Client ID
            <input
              value={form.spotifyClientId}
              onChange={(event) => setForm({ ...form, spotifyClientId: event.target.value })}
              placeholder="Dari Spotify Developer Dashboard"
            />
          </label>

          <label>
            Discord Application ID
            <input
              value={form.discordClientId}
              onChange={(event) => setForm({ ...form, discordClientId: event.target.value })}
              placeholder="Dari Discord Developer Portal"
            />
          </label>

          <label>
            Polling interval
            <select
              value={form.pollIntervalMs}
              onChange={(event) => setForm({ ...form, pollIntervalMs: Number(event.target.value) })}
            >
              <option value={3000}>3 detik</option>
              <option value={5000}>5 detik</option>
              <option value={10000}>10 detik</option>
              <option value={15000}>15 detik</option>
            </select>
          </label>

          <div className="toggle-row">
            <span>Tampilkan album art</span>
            <input
              type="checkbox"
              checked={form.showAlbumArt}
              onChange={(event) => setForm({ ...form, showAlbumArt: event.target.checked })}
            />
          </div>

          <div className="toggle-row">
            <span>Tampilkan tombol Spotify</span>
            <input
              type="checkbox"
              checked={form.showButtons}
              onChange={(event) => setForm({ ...form, showButtons: event.target.checked })}
            />
          </div>

          <div className="connection-grid">
            <div>
              {state.spotifyConnected ? <CheckCircle2 size={18} /> : <CircleSlash size={18} />}
              Spotify
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
              <button onClick={connectSpotify} disabled={isBusy}>
                {state.authInProgress || busyAction === "connect" ? <Loader2 className="spin" size={18} /> : <ExternalLink size={18} />}
                Connect Spotify
              </button>
              {state.running ? (
                <button className="danger" onClick={stop} disabled={isBusy}>
                  <Pause size={18} />
                  Stop
                </button>
              ) : (
                <button className="primary" onClick={start} disabled={isBusy || !state.spotifyConnected}>
                  <Play size={18} />
                  Start
                </button>
              )}
            </div>
          </div>

          <div className="now-playing">
            {state.lastTrack?.albumArtUrl ? (
              <img src={state.lastTrack.albumArtUrl} alt="" />
            ) : (
              <div className="album-placeholder">
                <Activity size={44} />
              </div>
            )}

            <div className="track-info">
              <p className="track-status">{state.lastTrack?.isPlaying ? "Playing" : "No active playback"}</p>
              <h3>{state.lastTrack?.title ?? "Belum ada lagu terdeteksi"}</h3>
              <p>{state.lastTrack?.artist ?? "Putar lagu di Spotify lalu tekan Start."}</p>
              <span>{state.lastTrack?.album ?? "Status Discord akan ikut berubah otomatis."}</span>
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

          <div className={`message-box ${state.error ? "error" : ""}`}>
            <strong>{state.error ? "Error" : "Status"}</strong>
            <span>{state.error ?? state.message}</span>
          </div>

          <button className="link-button" onClick={disconnect} disabled={isBusy || !state.spotifyConnected}>
            <Unplug size={16} />
            Disconnect Spotify
          </button>
        </section>
      </section>
    </main>
  );
};
