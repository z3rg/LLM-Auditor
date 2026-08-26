# Panduan Developer — LLM Auditor

Dokumen ini untuk orang yang akan **mengubah kode**. Untuk memasang & memakai aplikasinya,
lihat `README.md`.

> Catatan riwayat: aplikasi ini pernah berjalan di atas SQLite, lalu Postgres (Neon) + pgvector.
> Versi sekarang menyimpan seluruh state di **EdgeOne Blob**, dan fitur yang bergantung pada
> mesin kueri (SQL Agent) serta pencarian vektor (RAG/PDF importer) sudah dibuang. `dokumentasi.md`
> mendokumentasikan arsitektur ReAct + RAG yang lama dan **tidak lagi menggambarkan kode ini**.

---

## 1. Filosofi & Stack

- **Backend nyaris tanpa dependency**: satu paket runtime saja — `@edgeone/pages-blob`.
  Selebihnya modul bawaan Node (`node:http`, `node:stream`, `node:crypto`, `fetch`). Tidak ada
  framework web, ORM, bundler, atau SDK vendor.
- **Frontend tanpa build step**: HTML + CSS + satu file `app.js` vanilla. Tidak ada React/Vite.
- **Data**: EdgeOne Blob (object store). Tidak ada database, tidak ada state di filesystem —
  runtime EdgeOne bersifat ephemeral.
- **LLM**: **AI Gateway EdgeOne Makers** (OpenAI-compatible Chat Completions) via `fetch`,
  model bawaan `@makers/deepseek-v4-flash`. Provider tunggal — lihat `PROVIDER` di `lib/ai.js`.

> Prinsip saat menambah fitur: jangan menambah dependency kalau modul bawaan cukup, jangan
> pernah menyimpan state di disk, dan **jangan pernah membaca-mengubah-menulis satu blob yang
> dipakai banyak penulis** — lihat §5.

---

## 2. Peta Berkas

```
server.js              Entri DEV LOKAL: HTTP server + static files
agents/                EdgeOne Makers Agent Functions - entri PRODUKSI seluruh /api/*
  package.json         {"type":"module"} - menandai HANYA folder ini ESM; root tetap commonjs
  _api.js              Jembatan privat (awalan "_" = bukan rute): context agent -> lib/api.js
  api/**.js            Satu berkas per endpoint, dihasilkan npm run agents:routes
  api/ping.js          Probe tanpa import: menguji runtime agent terpisah dari graf lib/
edgeone.json           Konfigurasi Makers: nodeVersion, outputDirectory, blok agents
lib/
  api.js               Router JSON API bebas framework (dipakai server.js DAN agent)
  auth.js              Autentikasi: scrypt, sesi + cookie HttpOnly, throttle, bootstrap staf
  blob.js              Lapisan penyimpanan Blob: tulis bersyarat, baca strong, cache proses
  blob_local.js        Backend berkas lokal dengan antarmuka sama (dev & uji)
  db.js                Lapisan data: seed, analitik gap, akun, sesi, kuis
  ai.js                Chat Completions (DeepSeek via Gateway) + rekomendasi + generator kuis
  env.js               Pemuat .env mini untuk dev lokal
scripts/
  seed_blob.js         Isi data awal (npm run seed / seed:reset)
  blob_backup.js       Dump & restore seluruh store (npm run backup / restore)
  test_auth.js         Uji regresi end-to-end (npm run test:auth)
  generate_agent_routes.mjs  Daftar endpoint + generator berkas rute
public/                Frontend statis: index.html, app.js, styles.css, auth.css
```

---

## 3. Setup Dev Lokal

```bash
cp .env.example .env     # isi BLOB_LOCAL_DIR + MAKERS_MODELS_KEY
npm install
npm run seed
npm start                # http://localhost:3000
```

`BLOB_LOCAL_DIR` membuat aplikasi memakai `lib/blob_local.js` — berkas biasa di disk, tanpa
kredensial apa pun. Untuk menunjuk Blob sungguhan dari mesin Anda, set `EDGEONE_PROJECT_ID` +
`EDGEONE_BLOB_TOKEN` dan kosongkan `BLOB_LOCAL_DIR`.

---

## 4. Alur Data

```
Browser ──/api/*──> lib/api.js ──> lib/db.js ──> lib/blob.js ──HTTP──> EdgeOne Blob
       (server.js lokal /            └──> lib/ai.js ──fetch──> AI Gateway Makers (DeepSeek)
        agents/ di EdgeOne)
```

- **Autentikasi**: cookie sesi `sid` (HttpOnly, SameSite=Lax, 7 hari; `Secure` ditambahkan
  otomatis saat `isSecureRequest()` mendeteksi HTTPS — `X-Forwarded-Proto` dari reverse proxy,
  koneksi TLS langsung, atau paksaan `COOKIE_SECURE`). Token acak 32 byte, disimpan
  **ter-hash SHA-256**; kata sandi di-hash **scrypt** dengan salt per akun.
  `auth.currentUser(req)` me-resolve akun dari cookie di awal `api()` — seluruh endpoint di luar
  `/api/auth/*` menolak request tanpa sesi dengan `401`.
- **Kontrol akses**: peran dibaca dari akun pada sesi (`employee|auditor|director|super_admin`),
  bukan dari header/body klien. Endpoint Super Admin memakai `isSuper(user)`, dan endpoint
  peserta selalu memakai `user.id` — klien tidak bisa menyamar sebagai peserta lain
  (`/api/quiz/submit` juga memverifikasi kepemilikan sesi kuis).
- **Pendaftaran**: `POST /api/auth/register` selalu membuat akun `role='employee'`. Kenaikan
  peran & penonaktifan lewat `/api/admin/users/:id/{role,status}` (Super Admin); menonaktifkan
  akun langsung menghapus seluruh sesinya.
- **Quiz pipeline**: `/api/quiz/generate` → `ai.generateQuizPlanned()` (rencanakan sub-konsep →
  satu soal per sub-konsep) → disimpan ke `quiz-sessions/` (kunci jawaban di-strip sebelum
  dikirim ke klien) → `/api/quiz/submit` menilai & menambah attempt.

---

## 5. Model Data (EdgeOne Blob)

Blob adalah object store: tidak ada kueri, index, join, maupun transaksi. Tata kuncinya karena
itu yang menanggung beban kebenaran.

| Kunci | Isi |
|-------|-----|
| `divisions.json` · `topics.json` | Data referensi, ditulis sekali saat seed |
| `users/<id>.json` | Akun + `password_hash` + `status` |
| `users-by-email/<hash>.json` | Indeks unik e-mail → id, ditulis `onlyIfNew` |
| `attempts/<employeeId>.json` | Seluruh attempt milik SATU peserta |
| `sessions/<tokenHash>.json` | Sesi login |
| `sessions-by-user/<empId>/<expiresAtMs>-<tokenHash>.json` | Penanda kosong |
| `login-attempts/<hash>.json` | Penghitung throttle |
| `recommendations/<id>.json` · `quiz-sessions/<id>.json` | Satu objek per entitas |
| `settings/<key>.json` · `meta/seed.json` | Konfigurasi & penanda seed |

### Tiga aturan yang tidak boleh dilanggar

1. **Satu entitas = satu kunci.** Blob tidak punya penguncian; dua penulis pada blob yang sama
   saling menimpa **diam-diam**. Karena itu attempt dikelompokkan per peserta, bukan dalam satu
   koleksi global — dua peserta tidak pernah menulis kunci yang sama.
2. **Keunikan hanya lewat `onlyIfNew`.** Cek-lalu-tulis punya jendela balapan; tulis bersyarat
   tidak. Dipakai untuk e-mail dan alokasi id (`createUser()` menaikkan id lalu mengulang bila
   kuncinya sudah ada).
3. **Semua baca `consistency: "strong"`.** Mode *eventual* bisa tertinggal sampai 60 detik —
   pengguna yang baru login akan membaca sesi basi lalu terlempar "sesi berakhir".

### Kedaluwarsa sesi ada di NAMA kunci

`sessions-by-user/<empId>/<expiresAtMs>-<tokenHash>.json` sengaja menaruh waktu kedaluwarsa di
nama kunci, sehingga `countActiveSessions()` cukup memanggil `list()` dan menyaring nama —
tanpa membaca satu objek pun. Ini yang membuat kolom "sesi aktif" di tab Akun murah.

### Agregasi & cache

Analitik gap membaca puluhan objek sekaligus (`getManyJSON` dengan paralelisme terbatas 12,
karena SDK punya `RateLimitedError`). Mode Agent EdgeOne memakai **Session mode** sehingga
instance bertahan antar-request — `lib/blob.js` memanfaatkannya dengan cache berumur pendek
dalam proses (`BLOB_CACHE_TTL_MS`, default 15 detik). Setiap mutasi memanggil
`blob.invalidate(prefix)`.

Semantik analitik dijaga identik dengan view SQL lama:
skor peserta per topik = **MAX**, gap = skor < `GAP_THRESHOLD` (70), rata-rata divisi per topik =
rata-rata dari nilai terbaik tiap peserta. `overviewStats()` **sengaja berbeda** — di sana
rata-rata dihitung dari seluruh attempt, persis seperti view lama. Jangan "diseragamkan".

---

## 6. Header `makers-conversation-id`

Runtime Agent **menolak setiap request** yang tidak membawa header ini:

```
400 {"error":"Invalid makers-conversation-id: header is missing.
              Required: 6-36 characters, allowed: [0-9a-zA-Z-_.]"}
```

Ini bukan opsi. Mode Agent adalah **Session mode**: header itu yang menentukan request mana
dilayani instance mana. `public/app.js` membuat satu id per browser lewat `conversationId()`
dan menyimpannya di `localStorage`, sehingga satu pengguna tetap mendarat di instance yang sama
dan cache dalam proses di `lib/blob.js` benar-benar terpakai.

Konsekuensi untuk pengujian manual: `curl` ke API terdeploy juga harus menyertakannya.

---

## 7. Routing Agent Functions

Routing EdgeOne berbasis berkas. Resolvernya (disalin dari CLI):

```
relatif ke functionRoot → potong ekstensi /\.(js|ts|cjs|jsx|tsx)$/ → buang /index
→ [[x]]→/:x*  ·  [x]$→/:x?  ·  [x]→/:x  → bersihkan /[^\w/:*\-?]/g
```

Konsekuensi yang mahal ditemukan:

- **Jangan pakai `.mjs`.** Ekstensi itu tidak ada di pola pemotong, jadi `config.mjs` terdaftar
  sebagai `/api/configmjs`. Pemindai berkasnya *menerima* `.mjs`, jadi berkasnya terlihat tapi
  path-nya salah — kegagalan yang sunyi. Folder `agents/` memakai `.js` + `agents/package.json`
  bertanda `"type": "module"`.
- Berkas berawalan `_` bukan rute.
- Path yang juga menjadi awalan path lain harus ditulis `index.js` (generator mengurus ini).

---

## 8. Resep "Cara Menambah …"

### Menambah endpoint API
1. Tambahkan cabang di fungsi `api()` di `lib/api.js` (cek `req.method` + `p`, gunakan
   `sendJson`). Body JSON dibaca dengan `readBody(req)`. Objek `user` sudah tersedia; tambahkan
   `isSuper(user)` / `isStaff(user)` bila perlu.
2. Tambahkan path-nya ke daftar `routes` di `scripts/generate_agent_routes.mjs`.
3. `npm run agents:routes`.
4. Dokumentasikan di tabel API `README.md`.

Langkah 2-3 tidak boleh dilewat: tanpa berkas rute, endpointnya hidup di dev lokal tapi **404 di
EdgeOne**.

### Menambah jenis data baru
Pilih kunci yang membuat setiap penulis menyentuh kunci berbeda. Kalau terpaksa ada
baca-ubah-tulis, pastikan hanya satu aktor yang bisa menulisnya (mis. blob milik satu peserta).

### Menambah tab UI
Tambahkan `<a class="nav-item" data-tab="…" data-roles="…">` di sidebar `public/index.html`,
lalu `<section class="tab hidden" id="tab-…">`. Muat datanya di `app.js` mengikuti pola
`loadOverview()` / `loadSettings()`.

---

## 9. Referensi Variabel Lingkungan

| Variabel | Wajib | Keterangan |
|----------|-------|------------|
| `MAKERS_MODELS_KEY` | untuk fitur AI | Kunci AI Gateway Makers |
| `MAKERS_MODEL` | tidak | Default `@makers/deepseek-v4-flash` |
| `BLOB_LOCAL_DIR` | dev | Backend berkas lokal |
| `EDGEONE_PROJECT_ID` + `EDGEONE_BLOB_TOKEN` | luar platform | Blob sungguhan lewat token |
| `BLOB_STORE_NAME` | tidak | Default `auditor`; `[a-zA-Z0-9_-]{1,64}` |
| `BLOB_CACHE_TTL_MS` | tidak | Default 15000 |
| `SEED_PASSWORD` | tidak | Kata sandi awal akun staf; default `Auditor#2026` |
| `COOKIE_SECURE` | tidak | `1`/`0` memaksa atribut `Secure`; kosong = deteksi otomatis |
| `PORT` | tidak | Default 3000 (dev lokal) |
| `FUNCTION_WATCHDOG_MS` | tidak | Batas watchdog jembatan agent; default 280000 |

**Di konsol Makers isi ketiganya**: `MAKERS_MODELS_KEY`, `EDGEONE_PROJECT_ID`, dan
`EDGEONE_BLOB_TOKEN`. Kredensial Blob TIDAK disuntik otomatis untuk Agent Functions yang
mendaftarkan SDK-nya di `externalNodeModules` — placeholder
`{{PAGES_BLOB_DEPLOY_CREDENTIAL}}` di dalam paket npm tidak pernah disubstitusi, dan Blob
menjawab `Missing: token`. `lib/blob.js` juga menerima nama milik SDK sendiri
(`PAGES_PROJECT_ID` / `PAGES_BLOB_DEPLOY_CREDENTIAL`).

---

## 10. Verifikasi

### Uji otomatis — `npm run test:auth`

Menjalankan `server.js` sungguhan di atas direktori Blob sementara (dibuat & dihapus sendiri),
lalu memanggil API lewat HTTP: data awal, login & kata sandi salah, sesi, analitik, pendaftaran
+ e-mail ganda, kontrol peran, penangguhan mencabut sesi, throttle, dan logout. Tidak butuh
kredensial dan tidak menyentuh data Anda.

### Verifikasi rute agent

```bash
npm run dev:makers            # butuh `npx edgeone login` sekali
curl -s localhost:8088/api/ping
```

`/api/ping` tidak meng-import apa pun dari `lib/`. Kalau ia hidup tapi rute lain mati,
masalahnya ada di graf modul `lib/` atau dependency runtime — bukan di routing.

### Yang belum terotomasi

- Pemanggilan model sungguhan (butuh `MAKERS_MODELS_KEY`): generate & submit kuis,
  AI Recommendation, rekomendasi topik kuis.
- Perilaku UI di browser (tab, grafik tren, alur acknowledge).
- Perilaku Blob sungguhan di bawah konkurensi nyata — uji lokal memakai berkas, yang
  read-after-write-nya selalu kuat.

---

## 11. Ide Pengembangan Lanjutan

- **Ekspor terjadwal**: `npm run backup` lewat cron/Actions — Blob tidak punya point-in-time
  restore, jadi ini satu-satunya jaring pengaman.
- **Indeks agregat**: bila peserta tumbuh jauh melampaui puluhan, fan-out analitik akan terasa.
  Simpan ringkasan per divisi yang diperbarui saat submit, dengan penulis tunggal per kunci.
- **Kuis adaptif**: pilih sub-konsep berdasarkan soal yang sebelumnya dijawab salah.
- **Riwayat rekomendasi**: simpan versi sebelumnya agar perubahan saran bisa dilacak.
