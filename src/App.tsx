import { Activity, CheckCircle2, CircleSlash, Loader2, Mic2, MicOff, Pause, Play, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppConfig, RpcState, SpotifyTrack } from "./vite-env";
import { t } from "./utils/translations";

const emptyConfig: AppConfig = {
  discordClientId: "",
  discordUserToken: "",
  pollIntervalMs: 3000,
  showAlbumArt: false,
  showLyrics: true,
  lyricsOffsetMs: 0,
  largeImageKey: "",
  language: "en",
  discordStatusMode: "safe"
};

const initialState: RpcState = {
  config: emptyConfig,
  mediaSessionAvailable: false,
  discordConnected: false,
  running: false,
  lastTrack: null,
  currentLyric: null,
  lyricsStatus: "disabled",
  message: t("msgLoadConfig", "en"),
  error: null
};

const formatTime = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const lyricsStatusLabel = (status: string, lang: string): string => {
  switch (status) {
    case "loading": return t("statusLoading", lang);
    case "synced": return t("statusSynced", lang);
    case "plain": return t("statusPlain", lang);
    case "not_found": return t("statusNotFound", lang);
    case "disabled": return t("statusDisabled", lang);
    default: return "";
  }
};

const languagesList = [
  { code: "en", label: "English" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "ja", label: "日本語 (Japanese)" },
  { code: "zh", label: "简体中文 (Chinese)" },
  { code: "ko", label: "한국어 (Korean)" },
  { code: "de", label: "Deutsch (German)" },
  { code: "ru", label: "Русский (Russian)" },
  { code: "es", label: "Español (Spanish)" },
  { code: "fr", label: "Français (French)" },
  { code: "it", label: "Italiano (Italian)" },
  { code: "ar", label: "العربية (Arabic)" }
];

const getLanguageLabel = (code: string): string => {
  const matched = languagesList.find(lang => lang.code === code);
  return matched ? matched.label : "English";
};

const XenomorphIcon = ({ size = 20 }: { size?: number }) => (
  <img
    src="/xenomorph-logo.png"
    alt="Xenomorph"
    style={{
      width: `${size}px`,
      height: `${size}px`,
      display: "inline-block",
      verticalAlign: "middle",
      borderRadius: "50%",
      objectFit: "contain"
    }}
  />
);

export const App = () => {
  const [state, setState] = useState<RpcState>(initialState);
  const [form, setForm] = useState<AppConfig>(emptyConfig);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const api = window.spotifyRpc;

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const lang = state.config.language || "en";
  const tApp = (key: Parameters<typeof t>[0], variables?: Parameters<typeof t>[2]) => t(key, lang, variables);

  useEffect(() => {
    if (!api) {
      setState({
        ...initialState,
        message: t("msgDevServerRequired", "en")
      });
      return undefined;
    }

    void api.getState().then((nextState) => {
      setState(nextState);
      setForm(nextState.config);
    });

    return api.onState((nextState) => {
      setState(nextState);
    });
  }, [api]);

  const localProgressRef = useRef(0);
  const baselineProgressRef = useRef(0);
  const baselineTimeRef = useRef(0);
  const lastTrackRef = useRef<SpotifyTrack | null>(null);
  const isPlayingRef = useRef(false);
  const durationRef = useRef(0);

  const progressTextRef = useRef<HTMLSpanElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);

  // Sync baseline from backend state — only on track change, play state change, or seek
  useEffect(() => {
    if (!state.lastTrack) {
      localProgressRef.current = 0;
      baselineProgressRef.current = 0;
      baselineTimeRef.current = 0;
      lastTrackRef.current = null;
      isPlayingRef.current = false;
      durationRef.current = 0;
      if (progressTextRef.current) progressTextRef.current.textContent = "0:00";
      if (progressBarRef.current) progressBarRef.current.style.width = "0%";
      return;
    }

    const prev = lastTrackRef.current;
    const isDifferentTrack = !prev || prev.id !== state.lastTrack.id;
    const playStateChanged = !prev || prev.isPlaying !== state.lastTrack.isPlaying;
    const localVal = localProgressRef.current;
    const isSeek = Math.abs(localVal - state.lastTrack.progressMs) > 3000;

    // Always keep refs in sync
    isPlayingRef.current = state.lastTrack.isPlaying;
    durationRef.current = state.lastTrack.durationMs;

    if (isDifferentTrack || playStateChanged || isSeek || localVal === 0) {
      localProgressRef.current = state.lastTrack.progressMs;
      baselineProgressRef.current = state.lastTrack.progressMs;
      baselineTimeRef.current = performance.now();
      lastTrackRef.current = state.lastTrack;
    }
  }, [state.lastTrack]);

  // Single persistent rAF loop — starts once on mount, never restarts
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      if (isPlayingRef.current && durationRef.current > 0) {
        const elapsed = performance.now() - baselineTimeRef.current;
        const current = Math.min(durationRef.current, baselineProgressRef.current + elapsed);
        localProgressRef.current = current;

        if (progressTextRef.current) {
          progressTextRef.current.textContent = formatTime(current);
        }
        if (progressBarRef.current) {
          progressBarRef.current.style.width = `${Math.min(100, (current / durationRef.current) * 100)}%`;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []); // empty deps = mount once, never restart

  const runAction = async (name: string, action: () => Promise<RpcState>) => {
    if (!api) {
      setState((currentState) => ({
        ...currentState,
        error: t("msgElectronRequired", lang)
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

  const changeLanguage = async (newLang: string) => {
    const nextForm = { ...form, language: newLang };
    setForm(nextForm);
    if (api) {
      await runAction("save", () => api.saveConfig(nextForm));
    }
  };

  return (
    <main className="app-shell" dir={lang === "ar" ? "rtl" : "ltr"}>
      <section className="topbar">
        <div>
          <p className="eyebrow">{tApp("eyebrow")}</p>
          <h1>{tApp("appTitle")}</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {/* Custom Dropdown */}
          <div className="custom-dropdown" ref={dropdownRef} style={{ position: "relative" }}>
            <button
              className="dropdown-trigger"
              onClick={() => setDropdownOpen(!dropdownOpen)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                width: "160px",
                minHeight: "38px",
                padding: "0 14px",
                background: "rgba(255, 255, 255, 0.04)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                borderRadius: "8px",
                color: "#e2e8f0",
                cursor: "pointer",
                transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                fontSize: "0.88rem",
                fontWeight: "500",
                boxShadow: "0 2px 8px rgba(0,0,0,0.16)",
                outline: "none"
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.08)";
                e.currentTarget.style.borderColor = "rgba(69, 223, 169, 0.4)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.04)";
                e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.08)";
              }}
            >
              <span>{getLanguageLabel(form.language || "en")}</span>
              <span
                style={{
                  display: "inline-block",
                  transform: dropdownOpen ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                  fontSize: "0.75rem",
                  opacity: 0.7
                }}
              >
                ▼
              </span>
            </button>

            {dropdownOpen && (
              <div
                className="dropdown-menu-list"
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: lang === "ar" ? "auto" : "0",
                  left: lang === "ar" ? "0" : "auto",
                  width: "200px",
                  maxHeight: "260px",
                  overflowY: "auto",
                  background: "#181a20",
                  border: "1px solid rgba(255, 255, 255, 0.1)",
                  borderRadius: "8px",
                  boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)",
                  zIndex: 100,
                  padding: "4px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                  animation: "dropdownFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)"
                }}
              >
                {languagesList.map((item) => (
                  <button
                    key={item.code}
                    onClick={() => {
                      void changeLanguage(item.code);
                      setDropdownOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-start",
                      width: "100%",
                      minHeight: "36px",
                      padding: "0 12px",
                      background: form.language === item.code ? "rgba(69, 223, 169, 0.12)" : "transparent",
                      border: "0",
                      borderRadius: "6px",
                      color: form.language === item.code ? "#45dfa9" : "#cbd5e1",
                      cursor: "pointer",
                      fontSize: "0.85rem",
                      fontWeight: form.language === item.code ? "600" : "400",
                      transition: "all 0.15s ease",
                      textAlign: "left"
                    }}
                    onMouseEnter={(e) => {
                      if (form.language !== item.code) {
                        e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)";
                        e.currentTarget.style.color = "#ffffff";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (form.language !== item.code) {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = "#cbd5e1";
                      }
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={`status-pill ${state.running ? "active" : ""}`}>
            <Activity size={18} />
            {state.running ? tApp("live") : tApp("idle")}
          </div>
        </div>
      </section>

      <section className="workspace">
        <aside className="settings-panel">
          <div className="section-title">
            <h2>{tApp("configuration")}</h2>
            <button className="icon-button" onClick={saveConfig} disabled={isBusy || !api} title={tApp("saveConfig")}>
              {busyAction === "save" ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
            </button>
          </div>

          <label>
            {tApp("discordUserToken")}
            <input
              type="password"
              value={form.discordUserToken}
              onChange={(event) => setForm({ ...form, discordUserToken: event.target.value })}
              placeholder={tApp("discordTokenPlaceholder")}
            />
            <span className="field-hint">{tApp("discordTokenHint")}</span>
          </label>

          <label>
            {tApp("discordClientId")} <span className="optional-badge">{tApp("optional")}</span>
            <input
              value={form.discordClientId}
              onChange={(event) => setForm({ ...form, discordClientId: event.target.value })}
              placeholder={tApp("discordClientIdPlaceholder")}
            />
          </label>

          <label>
            {tApp("pollingInterval")}
            <select
              value={form.pollIntervalMs}
              onChange={(event) => setForm({ ...form, pollIntervalMs: Number(event.target.value) })}
            >
              <option value={100}>{tApp("secondsRealtime")}</option>
              <option value={500}>{tApp("secondsFast")}</option>
              <option value={1000}>{tApp("secondsShort", { s: 1 })}</option>
              <option value={2000}>{tApp("secondsShort", { s: 2 })}</option>
              <option value={3000}>{tApp("secondsShort", { s: 3 })}</option>
              <option value={5000}>{tApp("secondsShort", { s: 5 })}</option>
              <option value={10000}>{tApp("secondsShort", { s: 10 })}</option>
              <option value={15000}>{tApp("secondsShort", { s: 15 })}</option>
            </select>
          </label>

          <label>
            {tApp("discordStatusMode")}
            <select
              value={form.discordStatusMode || "safe"}
              onChange={(event) => setForm({ ...form, discordStatusMode: event.target.value })}
            >
              <option value="safe">{tApp("discordStatusModeSafe")}</option>
              <option value="aesthetic">{tApp("discordStatusModeAesthetic")}</option>
            </select>
            <span className="field-hint" style={{ color: form.discordStatusMode === "aesthetic" ? "#ff6b6b" : undefined }}>
              {tApp("discordStatusModeHint")}
            </span>
          </label>

          <label>
            {tApp("lyricsOffset")}
            <input
              type="number"
              step={100}
              value={form.lyricsOffsetMs ?? 0}
              onChange={(event) => setForm({ ...form, lyricsOffsetMs: Number(event.target.value) || 0 })}
              placeholder="0"
            />
            <span className="field-hint">{tApp("lyricsOffsetHint")}</span>
          </label>

          <div className="toggle-row">
            <span>{tApp("showLyrics")}</span>
            <input
              type="checkbox"
              checked={form.showLyrics}
              onChange={(event) => setForm({ ...form, showLyrics: event.target.checked })}
            />
          </div>

          <div className="connection-grid">
            <div>
              {state.mediaSessionAvailable ? <CheckCircle2 size={18} /> : <CircleSlash size={18} />}
              {tApp("mediaLocal")}
            </div>
            <div>
              {state.discordConnected ? <CheckCircle2 size={18} /> : <CircleSlash size={18} />}
              {tApp("discord")}
            </div>
          </div>
        </aside>

        <section className="player-panel">
          <div className="section-title">
            <h2>{tApp("nowPlaying")}</h2>
            <div className="actions">
              {state.running ? (
                <button className="danger" onClick={stop} disabled={isBusy || !api}>
                  <Pause size={18} />
                  {tApp("stop")}
                </button>
              ) : (
                <button className="primary" onClick={start} disabled={isBusy || !api}>
                  {busyAction === "start" ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                  {tApp("start")}
                </button>
              )}
            </div>
          </div>

          <div className="now-playing">
            <div className="album-placeholder">
              <Activity size={44} />
            </div>

            <div className="track-info">
              <p className="track-status">{state.lastTrack?.isPlaying ? tApp("playing") : tApp("noPlayback")}</p>
              <h3>{state.lastTrack?.title ?? tApp("noTrackDetected")}</h3>
              <p>{state.lastTrack?.artist ?? tApp("playbackGuide")}</p>
              <span>{state.lastTrack?.album ?? tApp("noApiHint")}</span>
            </div>
          </div>

          <div className="progress-wrap">
            <div className="progress-meta">
              <span ref={progressTextRef}>{formatTime(state.lastTrack?.progressMs ?? 0)}</span>
              <span>{formatTime(state.lastTrack?.durationMs ?? 0)}</span>
            </div>
            <div className="progress-track">
              <div
                ref={progressBarRef}
                style={{
                  width: `${
                    state.lastTrack?.durationMs
                      ? Math.min(100, (state.lastTrack.progressMs / state.lastTrack.durationMs) * 100)
                      : 0
                  }%`
                }}
              />
            </div>
          </div>

          {/* Lyrics Section */}
          <div className="lyrics-section">
            <div className="lyrics-header">
              <div className="lyrics-title">
                {form.showLyrics ? <Mic2 size={18} /> : <MicOff size={18} />}
                <span>{tApp("lyrics")}</span>
              </div>
              <span className={`lyrics-badge ${state.lyricsStatus}`}>
                {lyricsStatusLabel(state.lyricsStatus, lang)}
              </span>
            </div>

            <div className="lyrics-display">
              {state.lyricsStatus === "loading" && (
                <div className="lyrics-loading">
                  <Loader2 className="spin" size={22} />
                  <span>{tApp("statusLoading")}</span>
                </div>
              )}

              {state.lyricsStatus === "synced" && state.currentLyric && (
                <p key={state.currentLyric} className="lyric-line fade-in">
                  {state.currentLyric}
                </p>
              )}

              {state.lyricsStatus === "synced" && !state.currentLyric && state.lastTrack?.isPlaying && (
                <p className="lyric-line waiting">♪ . . .</p>
              )}

              {state.lyricsStatus === "plain" && (
                <div className="lyric-line plain-lyrics-info">
                  <p style={{ margin: 0, fontWeight: "500" }}>{tApp("plainLyricsInfo")}</p>
                  <p style={{ margin: "4px 0 0", fontSize: "0.85em", opacity: 0.7 }}>
                    {tApp("plainLyricsDiscordStatus")} {state.lastTrack?.title} — {state.lastTrack?.artist}
                  </p>
                </div>
              )}

              {state.lyricsStatus === "not_found" && (
                <p className="lyric-line not-found">{tApp("lyricsNotAvailable")}</p>
              )}

              {state.lyricsStatus === "disabled" && (
                <p className="lyric-line not-found">{tApp("enableLyricsHint")}</p>
              )}
            </div>
          </div>

          <div className={`message-box ${state.error ? "error" : ""}`}>
            <strong>{state.error ? tApp("errorLabel") : tApp("statusLabel")}</strong>
            <span>{state.error ?? state.message}</span>
          </div>
        </section>
      </section>
      <footer className="footer-credit" style={{
        textAlign: "center",
        paddingTop: "24px",
        fontSize: "0.82rem",
        opacity: 0.55,
        color: "#94a3b8",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: "6px"
      }}>
        Made by <XenomorphIcon size={20} /> Xenomorph
      </footer>
    </main>
  );
};
