# Spotify Discord RPC with Realtime Lyrics

A Windows desktop application built with Electron, React, and TypeScript to show your currently playing Spotify track on Discord in real-time, including auto-syncing lyrics directly to your Discord custom status.

This application **does not require the Spotify Web API, does not require a Spotify login, and does not require a Spotify Premium account**. It reads track information securely directly from the local Windows Media Session.

[**Download Latest Release**](https://github.com/Xen0morphh/DiscordRPC/releases)

---


> ANY WAY THIS HOW TO GET YOUR TOKEN

'''https://youtu.be/OYHVqdLGMTo'''

> [!WARNING]
> **A Note on Discord Rate Limits (HTTP 429)**
> 
> Because this application updates your custom status in real-time as lyrics change, you may occasionally experience temporary rate limits from Discord's servers. 
> 
> When this happens, the app will intelligently **hold/freeze** status updates during the cooldown period requested by Discord (typically 20-40 seconds) to keep your account safe from spam flags. Status updates will automatically resume once the cooldown period ends.

---

## Key Features

- 🎵 **Realtime Discord Rich Presence**: Displays track title, artist, album, and progress bar on your Discord profile.
- 💬 **Auto-sync Lyrics to Custom Status**: Automatically searches for lyrics (via LRCLIB) and updates your Discord custom status (e.g., `"🎵 Lyric text..."`).
- ⚡ **Zero Setup & No Login**: No Spotify Developer API keys, client ID, client secret, or Spotify account login required.
- ⚙️ **Flexible Configuration**: Adjust polling interval, set a custom lyrics offset (if lyrics are too fast/slow), and toggle lyrics sync on/off as desired.
- 🛠️ **Windows Setup Installer**: NSIS installer packages the app with a desktop shortcut, start menu shortcut, and custom directory selection.

---

## How to Install & Run (Users)

1. **Download & Run the Installer**: Head to [GitHub Releases](https://github.com/Xen0morphh/DiscordRPC/releases) (or tags) and download the latest `.zip` containing the setup `.exe`. Extract and run the installer.
2. **Select Installation Directory**: You can choose where to install the application. It will set up the files and create shortcuts on your Desktop and Start Menu.
3. **Run the App**: The application will open automatically. It is configured to run at startup so you don't have to launch it manually every time.
4. **Preparation**:
   - Ensure the Discord desktop app is running.
   - Open the Spotify desktop app and play a song.
5. **Configuration**:
   - Paste your Discord User Token (required for custom status sync, optional).
   - Enter your Discord Application ID (required for Rich Presence 'Playing...', optional).
6. **Start Syncing**: Click the **Start** button in the app. Your Discord status will begin updating automatically!

> [!TIP]
> **How to get your Discord Token:**
> You can retrieve your token by opening Discord in your web browser (or dev tools in the desktop app), opening Inspect Element -> Application -> Local Storage -> `https://discord.com`, and searching for the `token` key. Keep this token private!

---

## Development Guide & Manual Build

If you want to run the application from source code or package it manually:

### 1. Install Dependencies
Ensure you have [Node.js](https://nodejs.org/) installed. Run the following command in the project root folder:
```bash
npm install
```

### 2. Run in Development Mode
To test the application locally:
```bash
npm run dev
```

### 3. Build & Package to Installer (.exe)
To package the app into a standalone Windows installer setup inside the `release/` folder:
```bash
npm run package
```

---

## Important Notes

- **Token Security**: Your Discord token is stored strictly locally in your application's user data directory (`%APPDATA%`) and is sent directly to the Discord Gateway to update your status. No data is sent to any third-party servers.
- **Media Session**: This local mode utilizes Windows Global System Media Transport Controls (GSMTC) and is exclusive to the Windows operating system.
