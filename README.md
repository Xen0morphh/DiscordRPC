# Spotify Discord RPC

Aplikasi Electron untuk meng-update Discord Rich Presence secara realtime berdasarkan lagu yang sedang diputar di Spotify desktop.

Mode ini tidak memakai Spotify Web API, tidak membutuhkan Spotify Client ID, dan tidak membutuhkan akun Spotify Premium. Metadata lagu dibaca dari media session lokal Windows.

## Cara pakai

1. Install dependency:

   ```bash
   npm install
   ```

2. Buat Discord application di Discord Developer Portal.

   Salin Application ID. Kalau ingin memakai asset fallback, tambahkan asset bernama `spotify` di bagian Rich Presence assets.

3. Jalankan Spotify desktop dan putar lagu.

4. Jalankan aplikasi:

   ```bash
   npm run dev
   ```

5. Isi Discord Application ID di aplikasi, lalu klik Save.

6. Klik Start. Status Discord akan mengikuti lagu yang sedang diputar.

## Catatan

- Tidak ada token Spotify yang disimpan karena aplikasi tidak login ke Spotify.
- Polling default berjalan tiap 3 detik dan bisa diubah dari UI.
- Discord harus sedang berjalan di komputer yang sama agar Rich Presence bisa tersambung melalui IPC.
- Mode lokal ini memakai Windows Global System Media Transport Controls, jadi target utamanya Windows.
