# LLM Auditor

Aplikasi analitik hasil kuis **IT Auditor** lintas divisi, ditenagai **DeepSeek** lewat AI Gateway
EdgeOne Makers yang OpenAI-compatible. Mengubah data kuis menjadi **rekomendasi AI untuk gap
pengetahuan**, **saran topik kuis**, **tren skor per waktu**, **kuis yang dibuat model**, dan alur
persetujuan **Super Admin → Direktur**.

> **Serverless-first**: berjalan di **EdgeOne Makers** — frontend statis + API sebagai **Agent
> Functions** — dengan seluruh state di **EdgeOne Blob**. Tidak ada database SQL, tidak ada server
> yang perlu dirawat. Dependency runtime-nya satu: `@edgeone/pages-blob`; sisanya modul bawaan
> Node (`node:http`, `node:stream`, `node:crypto`, `fetch`).

---

## Daftar Isi

- [Fitur](#fitur)
- [Kebutuhan Sistem](#kebutuhan-sistem)
- [Setup](#setup)
- [Menjalankan Aplikasi](#menjalankan-aplikasi)
- [Deploy ke EdgeOne Makers](#deploy-ke-edgeone-makers)
- [Cara Pakai (per Peran)](#cara-pakai-per-peran)
- [Data Dummy](#data-dummy)
- [Referensi API](#referensi-api)
- [Arsitektur](#arsitektur)
- [Cadangan & Pemulihan](#cadangan--pemulihan)
- [Keamanan](#keamanan)
- [Troubleshooting](#troubleshooting)

---

## Fitur

| # | Fitur | Keterangan |
|---|-------|------------|
| 1 | **AI Recommendation** | Analisis gap pengetahuan per **karyawan** atau **divisi**, lengkap dengan rekomendasi perbaikan, prioritas (Tinggi/Sedang/Rendah), dan penilaian risiko — dihasilkan DeepSeek. |
| 2 | **Rekomendasi Topik Kuis** | Saran kuis prioritas + sub-topik + target skor untuk menutup gap (output JSON terstruktur). |
| 3 | **Acknowledgement (Direktur)** | Super Admin/Auditor mengirim rekomendasi → Direktur **meninjau & acknowledge** dengan catatan. |
| 4 | **Tren Skor per Waktu** | Grafik garis (SVG) rata-rata skor per bulan — mode **Keseluruhan / Per Divisi / Per Topik**, filter rentang waktu, dan garis ambang gap. |
| 5 | **Dashboard Overview** | Statistik ringkas + skor rata-rata per divisi & per topik. |
| 6 | **Kuis (Peserta Audit)** | Peserta melewati **10 topik audit berurutan**, masing-masing **10 soal pilihan ganda** yang dibuat DeepSeek → dijawab & dinilai (maks 100) → skor tercatat sehingga rata-rata & status gap ikut membaik. |
| 7 | **Penyusunan soal terencana** | Sebelum menulis soal, model memecah topik jadi **10 sub-konsep berbeda**, lalu menyusun satu soal per sub-konsep. Cakupan jadi merata dibanding meminta 10 soal sekaligus. Bisa dimatikan di **Pengaturan**. |
| 8 | **Akun & peran** | Registrasi mandiri (selalu jadi Peserta), sesi cookie HttpOnly, throttle login, dan pengelolaan peran/status oleh Super Admin. |

---

## Kebutuhan Sistem

- **Node.js ≥ 20** (versi yang dipakai runtime EdgeOne Makers). Cek: `node --version`.
- **Kunci model**: `MAKERS_MODELS_KEY` dari konsol Makers → **Models → API Key**. Gateway-nya
  menyediakan model DeepSeek bawaan, jadi tidak perlu akun DeepSeek sendiri.
- **Penyimpanan**: EdgeOne Blob. Di dalam Makers kredensialnya disuntik platform; untuk
  menjalankan di luar platform, lihat [Setup](#setup).
- Tidak ada database, tidak ada Docker, tidak ada langkah build.

---

## Setup

```bash
# 1. Masuk ke folder proyek
cd "LLM Auditor"

# 2. Siapkan konfigurasi environment
cp .env.example .env
```

Isi `.env`. Minimal untuk dev lokal:

```ini
# Simpan state sebagai berkas biasa — tanpa kredensial apa pun.
BLOB_LOCAL_DIR=./.blob-data

# Kunci model (tanpa ini, fitur AI mati; sisanya tetap jalan).
MAKERS_MODELS_KEY=
```

### Memilih backend penyimpanan

Aplikasi ini bicara ke satu antarmuka penyimpanan, dengan tiga cara memilih backend-nya:

| Kondisi | Backend | Dipakai untuk |
|---------|---------|---------------|
| `EDGEONE_PROJECT_ID` + `EDGEONE_BLOB_TOKEN` terisi | Blob sungguhan, mode token | `npm run seed` / `npm run backup` terhadap project produksi |
| `BLOB_LOCAL_DIR` terisi | Berkas lokal | Dev & `npm run test:auth` |
| Keduanya kosong | Blob sungguhan, kredensial dari platform | Saat terdeploy di Makers |

Token dibuat di konsol Makers → **Project Settings → API Token**. Kalau keduanya terisi, mode
token yang menang.

### Isi data awal

```bash
npm run seed          # idempoten — tidak mengubah apa pun bila store sudah terisi
npm run seed:reset    # HAPUS semua data aplikasi lalu isi ulang
```

Seed membuat 8 divisi, 10 topik, 32 peserta beserta ~390 attempt kuis, dan tiga akun staf.
Kata sandi awal akun staf diambil dari `SEED_PASSWORD` (default `Auditor#2026`).

---

## Menjalankan Aplikasi

```bash
npm start            # http://localhost:3000
```

atau lewat pembantu yang memeriksa `.env`, dependency, dan port lebih dulu:

```bash
./start.sh
./start.sh --reseed  # reset data dummy sebelum start
```

Masuk dengan salah satu akun bawaan (kata sandi `SEED_PASSWORD`):

| Email | Peran |
|-------|-------|
| `admin@company.co.id` | Super Admin |
| `auditor@company.co.id` | IT Auditor |
| `director@company.co.id` | Direktur |

### Uji regresi

```bash
npm run test:auth
```

Menjalankan server sungguhan di atas direktori Blob sementara lalu memanggil API lewat HTTP:
data awal, login, sesi, analitik, pendaftaran, kontrol peran, throttle, dan logout. Tidak butuh
kredensial apa pun dan tidak menyentuh data Anda.

---

## Deploy ke EdgeOne Makers

Target deploy utama. Frontend disajikan static hosting, `/api/*` berjalan sebagai **Agent
Functions** (`agents/`), dan seluruh state ada di EdgeOne Blob — instance-nya sendiri tidak
menyimpan apa pun.

### 1. Ambil kunci model

Konsol Makers → **Models → API Key** → buat & salin. Itu satu-satunya kunci yang dibutuhkan
fitur AI: gateway menyediakan model DeepSeek bawaan (`@makers/deepseek-v4-flash`).

### 2. Rute API (hanya bila menambah endpoint)

```bash
npm run agents:routes
```

Routing EdgeOne Makers berbasis berkas, jadi tiap endpoint butuh satu berkas di `agents/api/`.
Berkasnya tipis — semuanya meneruskan ke `agents/_api.js`, yang menjembatani context agent ke
router `lib/api.js`. Daftar endpoint ada di `scripts/generate_agent_routes.mjs`.

Tidak ada langkah bundle: mode agent memuat berkas rute sebagai modul Node biasa dengan
`node_modules` terpasang, jadi `import '../lib/api.js'` tetap import relatif dan dependency
runtime cukup didaftarkan di `edgeone.json` → `agents.externalNodeModules`.

> **Jangan memberi berkas di `agents/` ekstensi `.mjs`.** Resolver rute EdgeOne memotong
> ekstensi dengan pola yang tidak memuat `mjs`, sehingga `config.mjs` terdaftar sebagai
> `/api/configmjs` — berkasnya terlihat, path-nya diam-diam salah. Folder ini memakai `.js`
> dengan `agents/package.json` bertanda `"type": "module"`.

### 3. Uji rute agent secara lokal

```bash
npx edgeone login             # sekali saja; atau set EDGEONE_PAGES_API_TOKEN
npm run dev:makers            # http://localhost:8088
curl -s localhost:8088/api/ping
```

`/api/ping` sengaja tidak meng-import apa pun dari `lib/`: kalau ia hidup tapi rute lain mati,
masalahnya ada di graf modul `lib/` atau dependency runtime — bukan di routing.

### 4. Deploy

```bash
npm install -g edgeone
edgeone login
edgeone makers link
edgeone makers deploy
```

Atau lewat konsol: **New project** → pilih repositori ini → branch `edgeone-deploy`. Setelan
build sudah ada di `edgeone.json`:

| Field | Nilai | Sumber |
|-------|-------|--------|
| Node version | `20.18.0` | `nodeVersion` |
| Install command | `npm install --omit=dev` | `installCommand` |
| Output directory | `public` | `outputDirectory` — situs statis tanpa build step |
| Direktori agent | `agents` | `agents.dir` — routing berbasis berkas untuk seluruh `/api/*` |
| Agent timeout | `300` detik | `agents.timeout` (mode agent mengizinkan sampai 3600) |
| Dependency runtime | `@edgeone/pages-blob` | `agents.externalNodeModules` |

### 5. Isi environment variable

Di konsol project, isi **`MAKERS_MODELS_KEY`** (Models → API Key). Itu untuk fitur AI.

Untuk Blob, **coba tanpa kredensial apa pun lebih dulu.** Autentikasi Pages Blob di dalam
Makers seharusnya otomatis: SDK membawa placeholder `{{PAGES_BLOB_DEPLOY_CREDENTIAL}}` yang
disubstitusi builder saat build.

> **Jangan daftarkan `@edgeone/pages-blob` di `agents.externalNodeModules`.** Kalau didaftarkan,
> platform memasangnya apa adanya dari npm, placeholder itu tidak pernah diganti, dan Blob
> menjawab `Missing: token` berapa kali pun di-deploy ulang — meski dokumentasi bilang
> autentikasinya otomatis. Ini pernah memakan beberapa siklus deploy.

Pastikan lewat probe:

```bash
curl -s -H "makers-conversation-id: $(uuidgen)" https://<project>.edgeone.dev/api/ping
```

- `"blobCredentialPatched": true` → autentikasi otomatis aktif, tidak perlu token sama sekali.
- `"blobCredentialPatched": false` → builder tidak menambal SDK. Pakai **mode token** sebagai
  jalan keluar: isi `EDGEONE_PROJECT_ID` (id project, mis. `makers-xxxx`) dan
  `EDGEONE_BLOB_TOKEN` (Project Settings → **API Token**). `lib/blob.js` juga menerima nama
  milik SDK sendiri (`PAGES_PROJECT_ID` / `PAGES_BLOB_DEPLOY_CREDENTIAL`).

Variabel bisa disetel lewat CLI setelah `edgeone makers link`:

```bash
edgeone makers env set MAKERS_MODELS_KEY '…'
edgeone makers env ls
```

Perubahan variabel **baru berlaku setelah deploy ulang**.

Opsional: `MAKERS_MODEL`, `SEED_PASSWORD`, `BLOB_STORE_NAME`, `BLOB_CACHE_TTL_MS`.

### 6. Isi data awal

Store Blob project masih kosong setelah deploy pertama. Dari mesin Anda:

```bash
EDGEONE_PROJECT_ID=makers-xxxx EDGEONE_BLOB_TOKEN=… npm run seed
```

### 7. Verifikasi

```bash
curl -s https://<project>.edgeone.dev/api/ping
curl -s https://<project>.edgeone.dev/api/config
```

Kedua perintah di atas **wajib menyertakan header `makers-conversation-id`**, karena runtime
Agent menolak request tanpa itu dengan `400`:

```bash
curl -s -H "makers-conversation-id: $(uuidgen)" https://<project>.edgeone.dev/api/ping
```

`/api/ping` yang sehat memuat `"runtime": "edgeone-makers-agents"` — itu penanda paling cepat
bahwa kode versi agent benar-benar aktif. `/api/config` yang sehat memuat `"hasKey": true` dan
`"aiProvider": "EdgeOne Makers (DeepSeek)"`.
Login lewat browser; karena EdgeOne mengakhiri TLS dan meneruskan `X-Forwarded-Proto: https`,
cookie sesi otomatis ber-`Secure` tanpa perubahan konfigurasi.

### Batas platform yang perlu diingat

| Batas | Nilai | Dampak |
|-------|-------|--------|
| Durasi agent | `300` detik (maks **3600**) | Membuat kuis memanggil model 2x; jalur normal ±15-40 detik |
| Objek Blob | **25 MB**/objek | Objek terbesar di aplikasi ini beberapa KB |
| Konsistensi Blob | *eventual* ≤60 detik | Modul penyimpanan memakai `consistency: "strong"` untuk semua baca — lihat [Arsitektur](#arsitektur) |
| Eksekusi agent | 200 rb/bulan (free tier) | Satu kali muat halaman memakai beberapa eksekusi |
| Header wajib | `makers-conversation-id` | 6-36 karakter `[0-9a-zA-Z-_.]`; tanpa itu **semua** rute menjawab 400. Frontend membuat & menyimpannya di `localStorage` |
| Versi Node | runtime agent memakai **v24** | `nodeVersion` di `edgeone.json` tidak mengubah ini |

---

## Cara Pakai (per Peran)

Peran melekat pada akun yang dipakai untuk masuk (bukan dipilih di layar login). Menu sidebar
menyesuaikan peran tersebut; endpoint API juga memeriksanya di sisi server.

### 🛡️ Super Admin — akses penuh
1. **Overview** — statistik & skor rata-rata per divisi/topik.
2. **Knowledge Gaps** — pilih *Karyawan* atau *Divisi* → **Tampilkan Gap**.
   - **🧠 AI Recommendation** → rekomendasi perbaikan + prioritas + risiko.
   - **📚 Rekomendasi Topik Kuis** → daftar kuis prioritas untuk menutup gap.
   - **📤 Kirim ke Direktur untuk Acknowledge** → masuk antrean Direktur.
3. **Tren Skor** — pilih mode & rentang waktu.
4. **Pengaturan** — toggle penyusunan soal terencana.
5. **Akun** — ubah peran & status akun lain, cabut sesi.

### 🔎 IT Auditor
Sama seperti Super Admin kecuali tab Pengaturan dan pengelolaan akun.

### ✅ Direktur
1. Tab **Acknowledgement** → daftar rekomendasi yang dikirim.
2. Baca isi, tambahkan catatan (opsional).
3. **✅ Acknowledge** → status berubah beserta nama & waktu.

### 👤 Peserta Audit
1. **Daftar** (nama, email kantor, divisi, kata sandi) → langsung masuk sebagai peserta.
2. Tab **Kuis Anda** menampilkan seluruh **10 topik** berurutan beserta status & skor terbaik.
3. **▶ Mulai Kuis** → DeepSeek merencanakan sub-konsep lalu menyusun **10 soal**, masing-masing
   10 poin (maks 100).
4. Jawab semua → **Kumpulkan Jawaban** → skor, jawaban benar/salah, dan penjelasan.
5. Skor tercatat → rata-rata & status gap langsung diperbarui.

### Alur lengkap (end-to-end)
```
Rekomendasi: Super Admin/Auditor → AI Recommendation → Kirim → Direktur → ✅ Acknowledge
Kuis:        Peserta → pilih topik → DeepSeek susun 10 soal → jawab & nilai → skor ter-update
```

---

## Data Dummy

Seed deterministik (PRNG ber-seed) sehingga hasilnya bisa diulang persis:

- **8 divisi**, **10 topik** audit TI, **32 peserta**, **3 akun staf**.
- **±390 attempt kuis** tersebar 6 bulan terakhir.
- Tiap divisi punya **dua topik yang sengaja lemah**, sehingga gap yang muncul realistis
  (mis. divisi IT lemah di *Data Privacy & Protection* dan *ISO 27001 Compliance*).

Ambang gap: skor **< 70**. Skor seorang peserta pada satu topik adalah nilai **TERBAIK**-nya,
sehingga mengulang kuis hanya menaikkan nilai.

---

## Referensi API

Seluruh endpoint mengembalikan JSON dan (kecuali yang ditandai publik) menuntut cookie sesi.

| Method | Path | Peran | Keterangan |
|--------|------|-------|------------|
| GET | `/api/ping` | publik | Probe runtime tanpa dependency |
| GET | `/api/auth/divisions` | publik | Daftar divisi untuk formulir daftar |
| POST | `/api/auth/register` | publik | Daftar akun peserta |
| POST | `/api/auth/login` | publik | Masuk; memasang cookie `sid` |
| POST | `/api/auth/logout` | sesi | Keluar |
| GET | `/api/auth/me` | sesi | Profil sesi berjalan |
| POST | `/api/auth/password` | sesi | Ganti kata sandi |
| GET | `/api/config` | sesi | Profil + model + ambang gap |
| GET | `/api/overview` | staf | Statistik ringkas |
| GET | `/api/employees` · `/api/divisions` · `/api/topics` | staf | Data referensi |
| GET | `/api/gaps/employee?id=` · `/api/gaps/division?id=` | staf | Analitik gap |
| GET | `/api/trend` | staf | Tren skor bulanan |
| POST | `/api/ai/recommendation` | staf | Rekomendasi gap (DeepSeek) |
| POST | `/api/ai/quiz-topics` | staf | Rekomendasi topik kuis (JSON) |
| GET/POST | `/api/recommendations` | staf | Daftar / kirim rekomendasi |
| POST | `/api/recommendations/:id/acknowledge` | direktur | Acknowledge |
| GET | `/api/participant/curriculum` | sesi | Kurikulum 10 topik peserta |
| POST | `/api/quiz/generate` · `/api/quiz/submit` | sesi | Buat & kumpulkan kuis |
| GET/POST | `/api/settings` | super admin | Toggle penyusunan terencana |
| GET | `/api/admin/users` | super admin | Daftar akun |
| POST | `/api/admin/users/:id/role` · `/status` | super admin | Ubah peran / status |

```bash
# Simpan cookie sesi lebih dulu, lalu pakai untuk endpoint ber-peran
curl -s -c ck.txt -X POST localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@company.co.id","password":"Auditor#2026"}'
curl -s -b ck.txt localhost:3000/api/overview
```

---

## Arsitektur

| Berkas | Peran |
|--------|-------|
| `server.js` | Entri **dev lokal**: HTTP server Node built-in + static files; memanggil router yang sama dengan produksi |
| `agents/_api.js` | Jembatan privat Agent Functions: context agent → req/res Node → `lib/api.js`, dengan watchdog |
| `agents/api/**.js` | Satu berkas tipis per endpoint (routing berbasis berkas), semuanya meneruskan ke `_api.js` |
| `scripts/generate_agent_routes.mjs` | Daftar endpoint + generator berkas rute (`npm run agents:routes`) |
| `lib/api.js` | Router JSON API bebas framework — seluruh rute `/api/*`, dipakai bersama kedua entri |
| `lib/blob.js` | Lapisan penyimpanan EdgeOne Blob: tulis bersyarat, baca *strong*, fan-out terbatas, cache proses |
| `lib/blob_local.js` | Backend berkas lokal dengan antarmuka sama — untuk dev & uji tanpa kredensial |
| `lib/db.js` | Lapisan data: seed, analitik gap, akun, sesi, kuis — seluruhnya di atas `lib/blob.js` |
| `lib/auth.js` | Autentikasi: scrypt, sesi + cookie HttpOnly, throttle login, bootstrap akun staf |
| `lib/ai.js` | Wrapper Chat Completions (DeepSeek via AI Gateway Makers) + rekomendasi + generator kuis |
| `edgeone.json` | Konfigurasi Makers: versi Node, output statis, blok `agents` |

### Kenapa Blob, dan apa konsekuensinya

Makers hanya menyediakan **KV dan Blob** — tidak ada SQL maupun vector store. Memindahkan state
ke Blob berarti kehilangan mesin kueri, index, dan transaksi. Tiga keputusan yang menjaga
aplikasi tetap benar:

1. **Satu entitas = satu kunci.** Tidak ada koleksi besar yang dibaca-ubah-tulis. Blob tidak
   punya penguncian, jadi dua penulis pada blob yang sama akan saling menimpa diam-diam.
   Penulisan yang sering (submit kuis, sesi, throttle login) selalu menyentuh kunci milik satu
   pengguna saja.
2. **`onlyIfNew` untuk keunikan.** Tulis bersyarat adalah satu-satunya operasi atomik yang ada,
   dan dipakai untuk alamat email serta alokasi id — bukan cek-lalu-tulis.
3. **`consistency: "strong"` untuk semua baca.** Mode *eventual* bisa tertinggal sampai 60
   detik; itu berarti pengguna yang baru login membaca sesi basi lalu langsung terlempar
   "sesi berakhir".

Konsekuensi yang diterima: agregat (analitik gap) harus mengumpulkan puluhan objek sekaligus.
Karena mode Agent memakai **Session mode** — instance bertahan antar-request — `lib/blob.js`
menyimpan cache berumur pendek dalam proses (`BLOB_CACHE_TTL_MS`, default 15 detik).

### Yang dibuang saat pindah ke Blob

- **SQL Agent** — fiturnya menyusun SQL lalu mengeksekusinya. Tanpa mesin kueri tidak ada yang
  bisa dieksekusi.
- **RAG / PDF importer** — butuh pencarian vektor (pgvector) dan endpoint embeddings; Blob tidak
  punya yang pertama, AI Gateway Makers tidak punya yang kedua.
- **Docker & deployment VM** — target deploy tunggal kini EdgeOne Makers.

---

## Cadangan & Pemulihan

Berbeda dari Postgres terkelola, **Blob tidak punya point-in-time restore**. Sekali sebuah kunci
ditimpa atau dihapus, isinya hilang — jadi cadangan yang Anda pegang sendiri jadi lebih penting,
bukan kurang.

```bash
npm run backup                       # -> auditor-blob-YYYY-MM-DD.json
npm run restore auditor-blob-….json  # tulis balik seluruh kunci
```

Berkas hasilnya memuat hash kata sandi dan token sesi ter-hash. Simpan dengan izin ketat
(skripnya sudah menulis dengan mode `600`) dan jangan commit — `.gitignore` sudah menutupnya.

---

## Keamanan

- **Kata sandi** di-hash dengan `scrypt` (N=16384, r=8, p=1) + salt acak 16 byte; verifikasi
  memakai `timingSafeEqual`.
- **Sesi** berupa token acak 32 byte yang **disimpan ter-hash** (SHA-256); cookie `HttpOnly`,
  `SameSite=Lax`, dan `Secure` otomatis di HTTPS.
- **Throttle login**: 8 percobaan gagal per 10 menit per alamat email, dihitung di penyimpanan
  (bukan memori proses) agar tetap berlaku di lingkungan serverless.
- **Peran diperiksa di server** pada setiap endpoint — menu sidebar hanya kosmetik.
- **Registrasi selalu menghasilkan peran `employee`**; peran istimewa hanya diberikan Super Admin.
- Halaman sebelum login tidak menyebut nama peran atau cakupan aksesnya.
- `accountById()` tidak pernah mengembalikan `password_hash`.

---

## Troubleshooting

| Gejala | Penyebab & solusi |
|--------|-------------------|
| `Backend Blob belum dipilih` | Set `BLOB_LOCAL_DIR` di `.env` untuk dev lokal, atau `EDGEONE_PROJECT_ID` + `EDGEONE_BLOB_TOKEN` untuk Blob sungguhan. |
| `Blob tidak terautentikasi` | Berjalan di luar Makers tanpa token. Buat token di konsol → **Project Settings → API Token**. |
| `MAKERS_MODELS_KEY belum disetel` | Fitur AI butuh kunci model. Ambil di konsol Makers → **Models → API Key**. Sisa aplikasi tetap jalan tanpanya. |
| Login berhasil lalu langsung "sesi berakhir" | Umumnya cookie `Secure` di HTTP. Kosongkan `COOKIE_SECURE` agar terdeteksi otomatis, atau set `0` untuk dev lokal. |
| `/api/*` 404 setelah deploy | Berkas rute tidak terdaftar. Jalankan `npm run agents:routes`, pastikan ekstensinya `.js` (bukan `.mjs`), lalu deploy ulang. |
| Analitik terasa lambat | Naikkan `BLOB_CACHE_TTL_MS`. Agregat membaca puluhan objek; cache proses menahan hasilnya antar-request. |
| Kuis gagal dengan timeout | Naikkan `agents.timeout` di `edgeone.json` (maks 3600), atau matikan toggle penyusunan terencana di tab Pengaturan. |
| Data demo hilang / ingin diulang | `npm run seed:reset` — menghapus seluruh data aplikasi lalu mengisi ulang. |
