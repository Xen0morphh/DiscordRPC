# Spotify Discord RPC

Aplikasi Electron untuk meng-update Discord Rich Presence secara realtime berdasarkan lagu yang sedang diputar di Spotify.

## Cara pakai

1. Install dependency:

   ```bash
   npm install
   ```

2. Buat Spotify app di Spotify Developer Dashboard.

   Tambahkan redirect URI berikut:

   ```text
   http://127.0.0.1:4387/callback
   ```

3. Buat Discord application di Discord Developer Portal.

   Salin Application ID. Kalau ingin memakai asset fallback, tambahkan asset bernama `spotify` di bagian Rich Presence assets.

4. Jalankan aplikasi:

   ```bash
   npm run dev
   ```

5. Isi Spotify Client ID dan Discord Application ID di aplikasi, klik Save, lalu Connect Spotify.

6. Setelah login Spotify berhasil, klik Start. Status Discord akan mengikuti lagu yang sedang diputar.

## Catatan

- Spotify token disimpan di folder user data aplikasi Electron, bukan di repo.
- Polling default berjalan tiap 5 detik dan bisa diubah dari UI.
- Discord harus sedang berjalan di komputer yang sama agar Rich Presence bisa tersambung melalui IPC.
