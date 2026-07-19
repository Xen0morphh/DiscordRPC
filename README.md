# Spotify Discord RPC with Realtime Lyrics

Aplikasi desktop berbasis Electron + React + TypeScript untuk menampilkan lagu Spotify yang sedang diputar di status Discord Anda secara realtime, lengkap dengan sinkronisasi lirik (lyrics) secara otomatis ke custom status Discord.

Aplikasi ini **tidak memerlukan Spotify Web API, tidak memerlukan login, dan tidak membutuhkan akun Spotify Premium**. Informasi lagu dibaca langsung secara aman dari Media Session lokal Windows.

---

> [!WARNING]
> **Catatan Mengenai Rate Limit Discord (HTTP 429)**
> 
> Karena aplikasi ini meng-update custom status Anda secara realtime (setiap lirik lagu berubah), Anda sewaktu-waktu akan terkena pembatasan sementara (**Rate Limit**) dari server Discord. 
> 
> Jika ini terjadi, aplikasi secara cerdas akan **menahan sementara (hold/freeze)** update status Anda selama waktu *cool-down* yang diminta oleh Discord (biasanya 20-40 detik) agar akun Anda tetap aman dari cap spam. Status akan otomatis berjalan kembali secara realtime setelah masa tunggu selesai.

---

## Fitur Utama

- 🎵 **Realtime Discord Rich Presence**: Menampilkan judul lagu, artis, album, dan progress bar.
- 💬 **Auto-sync Lyrics ke Custom Status**: Secara otomatis mencari lirik lagu dan meng-update-nya ke custom status Discord (misal: `"🎵 Lirik Lagu..."`).
- ⚡ **Zero Setup & Tanpa Login**: Tidak membutuhkan Spotify Developer API, client ID, client secret, ataupun login akun Spotify.
- ⚙️ **Konfigurasi Fleksibel**: Atur interval polling lirik, offset waktu lirik (jika lirik terlalu cepat/lambat), dan nyalakan/matikan sinkronisasi lirik sesuai keinginan.
- 🛠️ **Windows Setup Installer**: Installer resmi agar aplikasi terpasang di sistem Windows Anda lengkap dengan shortcut desktop dan start menu.

---

## Cara Install & Menjalankan (Pengguna)

Jika Anda ingin memakai aplikasi yang sudah di-build:

1. **Unduh & Jalankan Installer**: Unduh file `.zip` (yang berisi installer `.exe`) dari halaman release GitHub, lalu ekstrak dan jalankan file setup di dalamnya.
2. **Proses Instalasi Otomatis**: Setelah dijalankan, installer akan memasang aplikasi secara otomatis ke folder aman (`%LOCALAPPDATA%`) tanpa perlu konfigurasi manual, kemudian aplikasi akan langsung terbuka. Shortcut akan dibuat di Desktop dan Start Menu.
3. **Jalankan Aplikasi**: Aplikasi siap digunakan dan akan terbuka otomatis. Jika ingin membuka kembali di lain waktu, gunakan shortcut di Desktop/Start Menu. Aplikasi ini juga akan berjalan otomatis setiap kali komputer dinyalakan.
4. **Persiapan**:
   - Pastikan aplikasi Discord desktop Anda aktif.
   - Buka Spotify desktop dan putar lagu.
5. **Konfigurasi di Aplikasi**:
   - Masukkan token akun Discord Anda (untuk sinkronisasi lirik ke custom status, opsional).
   - Masukkan Discord Application ID (untuk Rich Presence 'Playing...', opsional).
6. **Mulai Sinkronisasi**: Klik tombol **Start** di aplikasi. Status Anda akan mulai di-update secara otomatis.

---

<<<<<<< HEAD
NOTE: UNTUK LYRICS KE STATUS HARUS TOKEN DISCORD ID
caranya adalah ke local storage dari inspect discordnya
thanks guys!

## Catatan
=======
## Panduan Development & Build Manual
>>>>>>> ce97cf5 (update and optimization)

Jika Anda ingin menjalankan aplikasi dari source code atau mem-package ulang:

### 1. Install Dependency
Pastikan Anda sudah menginstall [Node.js](https://nodejs.org/). Jalankan perintah berikut di root folder project:
```bash
npm install
```

### 2. Jalankan Mode Development (Dev Server)
Untuk menguji aplikasi secara langsung:
```bash
npm run dev
```

### 3. Build & Package ke Installer (.exe)
Untuk membuat file setup installer Windows mandiri ke folder `release/`:
```bash
npm run package
```

---

## Catatan Penting
- **Keamanan Token**: Token Discord Anda hanya disimpan secara lokal di dalam folder data aplikasi dan dikirim langsung ke Discord Gateway untuk meng-update status. Tidak ada data yang dikirim ke server pihak ketiga.
- **Media Session**: Mode lokal ini menggunakan Windows Global System Media Transport Controls (GSMTC), sehingga aplikasi ini dikhususkan untuk sistem operasi Windows.
