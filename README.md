# LLM Auditor

Aplikasi analitik hasil kuis **IT Auditor** lintas divisi, ditenagai **Groq** (open-source LLM API).
Mengubah data kuis menjadi **rekomendasi AI untuk gap pengetahuan**, **saran topik kuis**, **SQL Agent**
bahasa-natural, **tren skor per waktu**, dan alur persetujuan **Super Admin → Direktur**.

> **Zero-dependency**: hanya butuh Node.js (≥ 22.5). Tidak ada `npm install` — seluruh aplikasi
> berjalan di atas modul bawaan Node (`node:http`, `node:sqlite`, `node:zlib`, `fetch`).
> Untuk RAG, ekstensi **`sqlite-vec`** sudah disertakan (`lib/vendor/vec0.dylib`, macOS arm64);
> bila tidak tersedia di platform Anda, app otomatis memakai fallback cosine murni-JS.
> **Embedding RAG memakai Google Gemini** (`gemini-embedding-001`, 3072-dim) lewat `fetch` —
> butuh **`GEMINI_API_KEY`**. Tidak ada model lokal atau fallback leksikal: tanpa key, fitur
> RAG (impor PDF & retrieval) tidak aktif.

---

## Daftar Isi
1. [Fitur](#fitur)
2. [Kebutuhan Sistem](#kebutuhan-sistem)
3. [Setup](#setup)
4. [Menjalankan Aplikasi](#menjalankan-aplikasi)
5. [Deploy dengan Docker (Portable)](#deploy-dengan-docker-portable)
6. [Cara Pakai (per Peran)](#cara-pakai-per-peran)
7. [Data Dummy](#data-dummy)
8. [Referensi API](#referensi-api)
9. [Arsitektur](#arsitektur)
10. [Keamanan](#keamanan)
11. [Troubleshooting](#troubleshooting)

> Panduan pengembangan lanjutan: lihat **[DEVELOPER.md](DEVELOPER.md)**.

---

## Fitur

| # | Fitur | Keterangan |
|---|-------|------------|
| 1 | **AI Recommendation** | Analisis gap pengetahuan per **karyawan** atau **divisi**, lengkap dengan rekomendasi perbaikan, prioritas (Tinggi/Sedang/Rendah), dan penilaian risiko — dihasilkan oleh Groq. |
| 2 | **Rekomendasi Topik Kuis** | Saran kuis prioritas + sub-topik + target skor untuk menutup gap (output JSON terstruktur). |
| 3 | **SQL Agent (Super Admin)** | Tanya dalam bahasa natural → AI menyusun query **SQL read-only**, dieksekusi, hasil ditampilkan sebagai tabel. |
| 4 | **Acknowledgement (Direktur)** | Super Admin/Auditor mengirim rekomendasi → Direktur **meninjau & acknowledge** dengan catatan. |
| 5 | **Tren Skor per Waktu** | Grafik garis (SVG) rata-rata skor per bulan — mode **Keseluruhan / Per Divisi / Per Topik**, **filter rentang waktu (3/6/12 bulan / Semua)**, dan garis ambang gap. |
| 6 | **Dashboard Overview** | Statistik ringkas + skor rata-rata per divisi & per topik. |
| 7 | **Kuis Perbaikan (Peserta Audit)** | Peserta login → melihat **gap pengetahuan dirinya** (topik di bawah rata-rata, dideteksi via SQL view) → Groq men-*generate* **10 soal pilihan ganda** per topik (sesuai topik & area) → dijawab & dinilai (**maks 100**) → **skor di-insert ke `quiz_attempts`** sehingga rata-rata/gap membaik otomatis. |
| 8 | **PDF Importer → RAG (sqlite-vec)** | Di tab **Pengaturan** (Super Admin), unggah PDF → teks diekstrak, dipotong dengan **parser hierarki hukum** (BAB/Pasal/Seksi/Poin, default), di-*embed* oleh **Gemini `gemini-embedding-001`** (3072-dim), lalu disimpan ke **SQLite + `sqlite-vec`** sebagai basis pengetahuan. Butuh `GEMINI_API_KEY`. |
| 9 | **Kuis berbasis ReAct + RAG (per soal)** | Saat membuat kuis, agen **ReAct** (Reason + Act) **merencanakan sub-konsep**, lalu memanggil `search_knowledge` **terpisah untuk SETIAP soal** menarik materi paling relevan dari PDF (RAG via sqlite-vec), baru menyusun tiap soal yang *grounded* pada materinya. Setiap soal menampilkan **sumber PDF-nya**; bila materi tipis, soal disusun dari pengetahuan umum dan **ditandai** (blend). Jejak penalaran (Thought/Action/Observation) + rasio `grounded` ditampilkan di UI. |

---

## Kebutuhan Sistem

Pilih salah satu:

- **Native** — **Node.js ≥ 22.5** untuk `node:sqlite`; untuk RAG dengan ekstensi `sqlite-vec`
  butuh **Node ≥ 23.5** (dukungan `loadExtension`). Cek versi: `node --version`.
- **Docker** — cukup Docker (dependency Node + ekstensi `sqlite-vec` dibungkus). RAG memanggil
  Gemini API saat runtime, jadi kontainer **butuh `GEMINI_API_KEY`** (bukan image offline). Lihat
  [Deploy dengan Docker](#deploy-dengan-docker-portable).

Lainnya:
- Koneksi internet untuk memanggil **Groq API** (fitur AI) dan **Gemini API** (embedding RAG).
- **API key Groq** — gratis di <https://console.groq.com/keys>.
- **API key Gemini** (untuk RAG/PDF importer) — gratis di <https://aistudio.google.com/apikey>.

---

## Setup

```bash
# 1. Masuk ke folder proyek
cd "LLM Auditor"

# 2. Siapkan konfigurasi environment
cp .env.example .env
```

Edit `.env` dan isi key Anda:

```ini
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxx   # key dari console.groq.com
GROQ_MODEL=llama-3.3-70b-versatile          # boleh diganti, mis. openai/gpt-oss-120b
PORT=3000

# Embedding RAG (impor PDF & retrieval) — Gemini only:
GEMINI_API_KEY=AIza_xxxxxxxxxxxxxxxxxxxxxxxx # key dari aistudio.google.com/apikey
GEMINI_EMBED_MODEL=gemini-embedding-001     # default; 3072-dim
```

> Database `data/auditor.db` dibuat & diisi data dummy **otomatis** saat server pertama kali
> dijalankan (folder `data/` dibuat otomatis; override lokasi via `DB_PATH`).
>
> **Embedding RAG (untuk fitur PDF Importer)** memakai **Gemini `gemini-embedding-001`** — tidak
> ada model lokal yang perlu diunduh atau dikonversi. Cukup isi `GEMINI_API_KEY` di `.env`
> (atau via tab **Pengaturan → Konfigurasi Embedding** di UI). Tanpa key, app tetap berjalan
> untuk semua fitur Groq, tetapi impor PDF & pencarian RAG **nonaktif** (tidak ada fallback lokal).

---

## Menjalankan Aplikasi

**Cara termudah** — pakai skrip start (otomatis cek Node, siapkan `.env`, lalu start & buka browser):

```bash
./start.sh
```

Opsi skrip:

| Perintah | Fungsi |
|----------|--------|
| `./start.sh` | jalankan aplikasi (siapkan `.env` bila perlu) lalu buka browser |
| `./start.sh --reseed` | reset/isi ulang data dummy sebelum start |
| `./start.sh --no-open` | jangan buka browser otomatis |
| `./start.sh --check` | hanya pra-pemeriksaan (tidak menjalankan server) |
| `./start.sh --help` | tampilkan bantuan |

Atau jalankan langsung tanpa skrip:

```bash
node server.js
```

Output:

```
  LLM Auditor running:  http://localhost:3000
  Groq model:           llama-3.3-70b-versatile
  Groq key loaded:      yes
  RAG embedder:         gemini:gemini-embedding-001 (dim 3072)
  RAG vector store:     sqlite-vec (vec0)
```

> Bila `GEMINI_API_KEY` belum disetel, server tetap menyala (ada peringatan `RAG init warning`)
> namun impor PDF & retrieval RAG tidak aktif sampai key diisi.

Buka **<http://localhost:3000>** di browser. Layar pertama adalah **Masuk / Daftar**:

- **Daftar** — siapa pun dapat membuat akun sendiri; akun baru selalu berperan **Peserta Audit**.
  Panel kiri menampilkan *register kontrol pendaftaran* yang tercentang mengikuti isian formulir.
- **Masuk** — akun staf bawaan disiapkan otomatis saat server pertama kali dijalankan, dengan
  kata sandi awal **`Auditor#2026`** (ubah lewat `SEED_PASSWORD` di `.env` sebelum run pertama):

  | Email | Peran |
  |-------|-------|
  | `admin@company.co.id` | Super Admin |
  | `auditor@company.co.id` | IT Auditor |
  | `director@company.co.id` | Direktur |

  Kata sandi awal juga dicetak di konsol server saat pertama kali disiapkan. **Ganti kata sandi**
  setelah masuk lewat tab **Akun**. Peran akun lain dinaikkan Super Admin di **Akun → Akun Terdaftar & Peran**.

**Uji regresi autentikasi** (42 pemeriksaan; memakai salinan database, tanpa API key):

```bash
npm run test:auth
```

**Reset / isi ulang data dummy** (menghapus rekomendasi & meng-generate ulang data kuis):

```bash
npm run seed
```

> **Tentang `data/auditor.db` yang ikut di repo.** Snapshot demo ini sengaja dilacak agar repo
> bisa langsung dijalankan lengkap dengan 391 hasil kuis dan indeks RAG 452 chunk dari tiga
> dokumen POJK. Isinya data dummy; akun staf di dalamnya memakai kata sandi awal yang memang
> sudah tertulis di README ini, jadi **anggap ketiga akun itu publik** dan ganti kata sandinya
> pada instalasi yang Anda pakai sungguhan.
>
> Konsekuensinya: **jangan commit ulang database ini setelah Anda menyetel kata sandi asli** —
> hash-nya akan ikut terpublikasi dan permanen di histori git. Untuk pemakaian nyata, biarkan
> `data/` dibuat ulang secara lokal (`npm run seed`) atau arahkan `DB_PATH` ke luar repo.

### Ingest massal PDF hukum (CLI)

Untuk memuat **PDF hukum berukuran besar** ke basis pengetahuan RAG tanpa lewat UI, tersedia
skrip Python `scripts/ingest_legal_pdf.py` (memakai **pypdf** untuk ekstraksi teks dan **Gemini**
untuk embedding — model & dimensi sama persis dengan app Node, menulis ke tabel
`pdf_documents`/`pdf_chunks`/`vec_pdf_chunks` yang sama):

```bash
pip install pypdf google-genai sqlite-vec          # sekali
export GEMINI_API_KEY=AIza_xxxxxxxx

npm run ingest-legal -- /path/to/regulasi.pdf       # via npm (perhatikan `--`)
# atau langsung:
python3 scripts/ingest_legal_pdf.py /path/to/regulasi.pdf
```

Skrip mem-parse hierarki **BAB → Seksi (A./B.) → Poin (1./2.) → Sub-poin (a./b.)**, menambahkan
*breadcrumb* sebagai konteks tiap chunk, lalu meng-embed dengan `gemini-embedding-001`.
Server Node membaca hasilnya langsung (skrip men-set `embed_meta` ke `gemini:…` sehingga tidak
ada re-embed saat server restart).

> **Rate limit Gemini (free tier): ~100 embed/menit.** Skrip sudah memberi jeda antar-panggilan
> dan commit tiap 20 chunk. Untuk dokumen sangat besar, pertimbangkan tier berbayar agar tidak
> kena `429`.

---

## Deploy dengan Docker (Portable)

Image Docker membungkus seluruh **dependency Node** dan ekstensi **`sqlite-vec`** (`vec0.so`,
diunduh untuk arsitektur Linux target). Embedding RAG memakai **Gemini API**, jadi image **bukan
offline**: kontainer melakukan panggilan jaringan saat runtime dan perlu dua key —
**`GROQ_API_KEY`** (fitur AI Groq) dan **`GEMINI_API_KEY`** (embedding RAG / impor PDF). Tidak ada
model lokal yang ikut di-build.

### Cara tercepat — Docker Compose

> Berkas Docker ada di folder **`docker/`** (`Dockerfile`, `docker-compose.yml`,
> `Dockerfile.dockerignore`). Jalankan perintah **dari root repo** — konteks build = root.
> Cara termudah: `npm run docker:up` / `npm run docker:down`.

```bash
# 1) Siapkan key (sekali)
cp .env.example .env          # lalu isi GROQ_API_KEY dan GEMINI_API_KEY

# 2) Build + jalankan (dari root repo)
docker compose -f docker/docker-compose.yml --env-file .env up --build -d
#    atau: npm run docker:up

# 3) Buka aplikasi
open http://localhost:3000    # atau kunjungi di browser

# Lihat log / hentikan
docker compose -f docker/docker-compose.yml logs -f
docker compose -f docker/docker-compose.yml down   # atau: npm run docker:down
```

### Tanpa Compose

```bash
docker build -f docker/Dockerfile -t llm-auditor .   # atau: npm run docker:build
docker run --rm -p 3000:3000 \
  -e GROQ_API_KEY=gsk_xxxxxxxx \
  -e GEMINI_API_KEY=AIza_xxxxxxxx \
  -v auditor-data:/app/data \
  llm-auditor
```

### Build lintas-arsitektur

`TARGETARCH` dideteksi otomatis (`amd64`/`arm64`). Untuk membangun image arsitektur lain:

```bash
docker buildx build -f docker/Dockerfile --platform linux/amd64 -t llm-auditor:amd64 .
docker buildx build -f docker/Dockerfile --platform linux/arm64 -t llm-auditor:arm64 .
```

### Catatan

| Hal | Keterangan |
|-----|------------|
| **Persistensi** | DB + basis pengetahuan RAG disimpan di volume `auditor-data` (mount `/app/data`). `DB_PATH=/app/data/auditor.db`. |
| **Embedding** | Memakai **Gemini API** saat runtime — berikan `GEMINI_API_KEY` (env atau via `.env`). Tanpa key, fitur RAG nonaktif; fitur Groq lain tetap jalan. Tidak ada model lokal di image. |
| **sqlite-vec** | Saat build, biner `vec0.so` Linux diunduh sesuai arsitektur; `SQLITE_VEC_PATH=/app/lib/vendor/vec0.so`. |
| **Keamanan** | Kontainer berjalan sebagai user non-root `node`. `.env`, `data/` & `*.db` lokal **tidak** ikut ke image (lihat `docker/Dockerfile.dockerignore`). |
| **Healthcheck** | Tersedia probe ke `/api/config`. |

---

## Cara Pakai (per Peran)

Peran melekat pada akun yang dipakai untuk masuk (bukan dipilih di layar login).
Menu sidebar menyesuaikan peran tersebut; endpoint API juga memeriksanya di sisi server.

### 🛡️ Super Admin — akses penuh
1. **Overview** — lihat statistik & skor rata-rata per divisi/topik.
2. **Knowledge Gaps** — pilih *Karyawan* atau *Divisi* → **Tampilkan Gap**.
   - Klik **🧠 AI Recommendation** → rekomendasi perbaikan + prioritas + risiko.
   - Klik **📚 Rekomendasi Topik Kuis** → daftar kuis prioritas untuk menutup gap.
   - Klik **📤 Kirim ke Direktur untuk Acknowledge** → rekomendasi masuk antrean Direktur.
3. **Tren Skor** — pilih mode (Keseluruhan/Per Divisi/Per Topik) & rentang waktu.
4. **SQL Agent** — ketik pertanyaan (mis. *"divisi dengan gap pengetahuan terbanyak"*) → AI
   membuat SQL `SELECT`, dieksekusi, hasil tampil sebagai tabel + query yang dipakai.
   Pertanyaan tentang **gap** dijawab akurat karena memakai *view* analitik (lihat di bawah).
5. **Pengaturan** — **PDF Importer (RAG)**: seret/unggah PDF → jadi pengetahuan tambahan soal.
   Lihat status `sqlite-vec`, daftar dokumen, **Uji Pencarian** (retrieval), panel
   **Konfigurasi Embedding (Gemini)** (isi `GEMINI_API_KEY`/model + toggle parser hierarki hukum),
   dan toggle **ReAct + RAG** untuk pembuatan kuis.

### 🔎 IT Auditor
Sama seperti Super Admin **kecuali SQL Agent**. Bisa menjalankan AI Recommendation,
Rekomendasi Topik Kuis, dan mengirim rekomendasi ke Direktur.

### ✅ Direktur
1. Buka tab **Acknowledgement** → daftar rekomendasi yang dikirim.
2. Baca isi (expand *"Lihat isi rekomendasi"*), tambahkan catatan (opsional).
3. Klik **✅ Acknowledge** → status berubah menjadi *Acknowledged* beserta nama & waktu.

### 👤 Peserta Audit
1. **Daftar** akun (nama, email kantor, divisi, kata sandi) → langsung masuk sebagai peserta,
   atau **Masuk** dengan akun peserta yang sudah ada.
2. Tab **Kuis Perbaikan** menampilkan **gap pengetahuan Anda** — topik dengan skor di bawah
   rata-rata pribadi (dideteksi via SQL view; query bisa dilihat di *"Lihat query SQL pendeteksi gap"*).
3. Klik **▶ Mulai Kuis** pada sebuah topik → agen **ReAct** merencanakan sub-konsep, menarik
   materi PDF **per soal** (RAG), lalu **Groq** membuat **10 soal** pilihan ganda yang
   *grounded* (sesuai topik & area), setiap soal 10 poin (maks 100). Tiap soal menampilkan
   **sumber PDF-nya** (atau tanda *pengetahuan umum* bila materi tipis), plus badge
   **📚 N/10 soal berbasis PDF** + jejak penalaran ReAct.
4. Jawab semua → **Kumpulkan Jawaban** → lihat skor, jawaban benar/salah, dan penjelasan.
5. Skor otomatis **disimpan ke `quiz_attempts`** → rata-rata & status gap Anda langsung diperbarui.

### Alur lengkap (end-to-end)
```
Fitur 3:  Super Admin/Auditor → AI Recommendation → "Kirim ke Direktur" → Direktur → ✅ Acknowledge
Fitur 7:  Peserta → gap (SQL view) → Groq generate 10 soal → jawab & nilai → skor ter-update
```

---

## Data Dummy

- **8 divisi**: Finance, IT, HR, Operations, Marketing, Legal & Compliance, Internal Audit, Procurement.
- **10 topik audit IT**: Access Control & IAM, Network Security, Data Privacy & Protection,
  Incident Response, Change Management, Business Continuity & DRP, ISO 27001 Compliance,
  IT Risk Management, Application Controls, Audit Logging & Monitoring.
- **32 karyawan** + akun khusus (Super Admin, Direktur Utama, Lead IT Auditor).
- **±390 hasil kuis** tersebar ~6 bulan terakhir.
- Data **deterministik** (seeded PRNG) → hasil selalu sama. Gap dirancang realistis per divisi
  (mis. *Finance* lemah di *Network Security*, *IT* lemah di *Data Privacy* & *ISO 27001*).
- Database: file `data/auditor.db` (SQLite via `node:sqlite`). **Ambang gap** = skor rata-rata `< 70`.

### View analitik (untuk SQL Agent)

Logika "gap" (rata-rata skor `< 70`) **dibakukan ke dalam VIEW** SQLite agar SQL Agent menjawab
pertanyaan gap dengan benar (kolom `is_gap = 1` menandai gap):

| View | Granularitas |
|------|--------------|
| `v_employee_topic` | rata-rata skor per **karyawan × topik** (+ `is_gap`) |
| `v_division_topic` | rata-rata skor per **divisi × topik** (+ `is_gap`) |
| `v_division_score` | rata-rata skor keseluruhan **per divisi** |
| `v_topic_score` | rata-rata skor keseluruhan **per topik** (+ `is_gap`) |
| `v_employee_score` | rata-rata skor + `gap_topics` (jumlah topik ber-gap) **per karyawan** |

> Catatan: gap muncul di level *divisi×topik* dan *karyawan×topik*. Di level **topik global**
> umumnya tidak ada gap karena divisi yang kuat menutupi yang lemah — ini perilaku data yang benar.

---

## Referensi API

Semua endpoint mengembalikan JSON. Kecuali endpoint `/api/auth/*` pra-login, **semua endpoint
membutuhkan sesi login** (cookie `sid`, HttpOnly) dan mengembalikan `401` bila tidak ada sesi.
Peran diambil dari akun pada sesi tersebut — tidak ada lagi header `x-role`.

| Method | Endpoint | Akses | Keterangan |
|--------|----------|-------|------------|
| GET | `/api/auth/divisions` | publik | Daftar divisi untuk formulir pendaftaran |
| POST | `/api/auth/register` | publik | Body `{name, email, password, division_id}` → buat akun peserta + sesi |
| POST | `/api/auth/login` | publik | Body `{email, password}` → sesi (maks 8 percobaan gagal / 10 menit) |
| GET | `/api/auth/me` | login | Akun pada sesi berjalan |
| POST | `/api/auth/logout` | login | Akhiri sesi |
| POST | `/api/auth/password` | login | Body `{current_password, new_password}` |
| GET | `/api/admin/users` | `super_admin` | Daftar akun terdaftar + peran & status |
| POST | `/api/admin/users/:id/role` | `super_admin` | Body `{role}` — `employee`/`auditor`/`director`/`super_admin` |
| POST | `/api/admin/users/:id/status` | `super_admin` | Body `{status}` — `active`/`disabled` (sesi akun langsung dicabut) |
| GET | `/api/overview` | staf | Statistik + rata-rata per divisi/topik |
| GET | `/api/divisions` · `/api/topics` · `/api/employees` | login | Data referensi (`/api/employees`: staf) |
| GET | `/api/gaps/employee?id=` | staf | Gap per karyawan |
| GET | `/api/gaps/division?id=` | staf | Gap per divisi |
| GET | `/api/trend?division=&topic=&months=` | staf | Tren skor bulanan (lihat di bawah) |
| POST | `/api/ai/recommendation` | staf | **Fitur 1** — body `{scope_type, scope_ref}` |
| POST | `/api/ai/quiz-topics` | staf | **Fitur 2** — body `{scope_type, scope_ref}` |
| POST | `/api/sql-agent` | `super_admin` | **Fitur 3** — body `{question}` |
| GET | `/api/recommendations?status=` | staf | Daftar rekomendasi |
| POST | `/api/recommendations` | `super_admin`/`auditor` | Kirim rekomendasi |
| POST | `/api/recommendations/:id/acknowledge` | `director` | Acknowledge |
| GET | `/api/participant/curriculum?id=` | login | **Fitur 7** — daftar 10 topik + status (SQL view) + query-nya. Peserta selalu mendapat datanya sendiri; `id=` hanya berlaku untuk staf. |
| POST | `/api/quiz/generate` | login | **Fitur 7/9** — body `{topic_id}` → 10 soal (ReAct+RAG) untuk akun pada sesi. Respons memuat `method`, `grounded`, `trace`, `sources`. |
| POST | `/api/quiz/submit` | peserta | **Fitur 7** — body `{session_id, answers:[idx,…]}` → nilai + update skor |
| GET | `/api/settings` | login | Toggle `quizUseReact`/`quizUseRag` + status RAG |
| POST | `/api/settings` | `super_admin` | Ubah toggle ReAct/RAG |
| GET | `/api/pdf/documents` | login | **Fitur 8** — daftar dokumen PDF + status RAG |
| POST | `/api/pdf/import` | `super_admin` | **Fitur 8** — unggah PDF (body biner `application/pdf`, header `X-Filename`) |
| DELETE | `/api/pdf/documents/:id` | `super_admin` | **Fitur 8** — hapus dokumen dari basis pengetahuan |
| POST | `/api/pdf/search` | `super_admin` | **Fitur 8** — body `{query}` → potongan teks paling relevan (uji retrieval) |

**`/api/trend`** parameter (semua opsional):
- `division=<id>` atau `topic=<id>` → seri terfilter + baseline keseluruhan.
- `months=3|6|12` → batasi ke N bulan kalender terakhir (tanpa param = semua data).

Contoh:
```bash
curl -b sid.txt "http://localhost:3000/api/trend?division=2&months=3"
# Simpan cookie sesi lebih dulu, lalu pakai untuk endpoint ber-peran
curl -c sid.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@company.co.id","password":"Auditor#2026"}'

curl -b sid.txt -X POST http://localhost:3000/api/sql-agent \
  -H "Content-Type: application/json" \
  -d '{"question":"5 karyawan dengan skor rata-rata terendah"}'
```

---

## Arsitektur

| Berkas | Peran |
|--------|-------|
| `server.js` | HTTP server (Node built-in), routing API, static files, loader `.env`, filter rentang waktu, endpoint PDF/settings |
| `lib/db.js` | Skema + seed data dummy (deterministik) + helper analitik gap & tren + `app_settings` |
| `lib/groq.js` | Wrapper Groq Chat Completions + fitur AI (rekomendasi, topik kuis, SQL Agent) + **generator kuis ReAct + RAG** |
| `lib/vec.js` | Basis pengetahuan RAG: chunking (**parser hierarki hukum** default + chunker paragraf generik) + index **sqlite-vec** (KNN) + reindex saat backend embedding berubah, fallback cosine JS |
| `lib/embedder.js` | Embedder **Gemini-only** (`gemini-embedding-001`, 3072-dim) via `fetch`; butuh `GEMINI_API_KEY`, tanpa fallback lokal |
| `lib/pdf.js` | Ekstraktor teks PDF zero-dependency (FlateDecode via `node:zlib`) |
| `lib/vendor/vec0.dylib` | Ekstensi `sqlite-vec` (macOS arm64) untuk dev native; di Docker diganti `vec0.so` Linux |
| `scripts/ingest_legal_pdf.py` | Ingest CLI massal PDF hukum (pypdf + Gemini) → menulis ke tabel RAG yang sama; `npm run ingest-legal` |
| `scripts/test_auth.js` | Uji regresi autentikasi (42 pemeriksaan) di atas salinan DB; `npm run test:auth` |
| `docker/` | Berkas Docker: `Dockerfile`, `docker-compose.yml`, `Dockerfile.dockerignore`. Image portabel (sqlite-vec; app zero-dependency); embedding RAG via Gemini API saat runtime. Konteks build = root |
| `data/` | DB runtime SQLite (`data/auditor.db` + WAL) — auto-dibuat, di-gitignore; mirror volume Docker `/app/data` |
| `lib/auth.js` | Autentikasi: hash scrypt, validasi pendaftaran, sesi + cookie, throttle login, bootstrap akun staf |
| `public/index.html` | Struktur layar **Masuk/Daftar**, dashboard, tab **Pengaturan** & **Akun** |
| `public/auth.css` | Tampilan layar Masuk/Daftar (register kontrol "kertas kerja" + stempel) |
| `public/app.js` | Logika frontend (fetch API, render tabel/markdown, **chart SVG tren**, PDF importer, jejak ReAct) |
| `public/styles.css` | Tema dashboard |
| `.claude/launch.json` | Konfigurasi preview dev-server (opsional) |

### RAG & ReAct (Fitur 8 & 9)

- **Embedding via Gemini** (`lib/embedder.js`): Groq tidak punya endpoint embeddings, jadi
  vektor dihitung lewat **Google Gemini API** — **`gemini-embedding-001`** (3072-dim), dipanggil
  via `fetch` (`taskType` `RETRIEVAL_DOCUMENT` untuk chunk, `RETRIEVAL_QUERY` untuk query).
  Butuh **`GEMINI_API_KEY`** (dari `.env` atau panel **Konfigurasi Embedding** di UI; nilai DB
  menang atas env). **Tidak ada fallback lokal/leksikal**: tanpa key, embedder gagal dan fitur RAG
  nonaktif. Vektor di-L2-normalize sehingga jarak L2 (default vec0) setara peringkat cosine. Bila
  nama/dimensi backend berubah dari yang tersimpan (`embed_meta`), `lib/vec.js` otomatis
  **reindex** (embed ulang semua chunk dari teks, dengan jeda agar tidak kena rate limit).
- **Chunking hukum (default)**: saat impor PDF, `lib/vec.js` memakai **parser hierarki hukum**
  (`parseHierarchyChunks`: BAB → Pasal → Seksi `A./B.` → Poin `1./2.` → Sub-poin `a./b.`) yang
  memberi *breadcrumb* konteks pada tiap chunk. Bila toggle parser dimatikan, dipakai chunker
  paragraf generik. Untuk ingest massal di luar UI, lihat
  [Ingest massal PDF hukum (CLI)](#ingest-massal-pdf-hukum-cli) (`scripts/ingest_legal_pdf.py`).
- **sqlite-vec**: potongan teks diindeks ke virtual table `vec0` dan dicari via KNN. Karena
  vektor sudah dinormalisasi, peringkat jarak L2 setara cosine. Bila ekstensi gagal dimuat,
  `lib/vec.js` otomatis beralih ke perhitungan cosine murni di JavaScript (hasil tetap benar).
- **ReAct**: `generateQuizReAct()` menjalankan loop Thought → Action (`search_knowledge`) →
  Observation hingga materi cukup, lalu menyusun soal yang *grounded* pada konteks PDF.
  Toggle ReAct/RAG tersedia di tab **Pengaturan**.

Alur data: `Browser → /api/* → server.js → lib/db.js (SQLite)` dan
`server.js → lib/groq.js → Groq API` untuk fitur AI. Grafik tren digambar sebagai **SVG murni**
di sisi klien (tanpa library chart/CDN), sehingga tetap berfungsi offline.

---

## Keamanan

- **SQL Agent read-only**: query hasil LLM divalidasi — hanya **satu** statement `SELECT`
  (atau CTE `WITH … SELECT`), memblokir kata kunci tulis (`INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/...`),
  dan otomatis ditambah `LIMIT 200`. (Lihat `sanitizeSql()` di `lib/groq.js`.)
- **Auto-repair**: bila query yang dihasilkan gagal dieksekusi, error dikirim balik ke LLM
  **satu kali** untuk diperbaiki sebelum hasil ditampilkan (ditandai badge *"diperbaiki otomatis"*).
- **Autentikasi nyata**: kata sandi di-hash **scrypt** (`node:crypto`, salt acak per akun,
  perbandingan *timing-safe*); sesi berupa token acak 32 byte yang disimpan **ter-hash** di tabel
  `sessions` dan dikirim sebagai cookie **HttpOnly · SameSite=Lax** (berlaku 7 hari).
  Login dibatasi **8 percobaan gagal per email / 10 menit**.
- **Kontrol akses berbasis peran di sisi server**: peran dibaca dari sesi, bukan dari input klien
  (mengembalikan `401` tanpa sesi, `403` bila peran tidak sesuai). Peserta hanya bisa membuka
  kurikulum & sesi kuis miliknya sendiri — `employee_id` diambil dari sesi, bukan dari body request.
- **Pendaftaran mandiri hanya menghasilkan peran `employee` (Peserta Audit)**; kenaikan peran
  dilakukan Super Admin. Menonaktifkan akun langsung mencabut seluruh sesinya.
- **Cookie sesi menyesuaikan protokol**: atribut `Secure` dipasang otomatis saat request datang
  lewat HTTPS — dideteksi dari header `X-Forwarded-Proto` (reverse proxy) atau koneksi TLS
  langsung. Di `http://localhost` atribut itu sengaja tidak dipasang, karena browser menolak
  mengirim balik cookie `Secure` lewat HTTP sehingga login lokal akan mati. Paksa nilainya
  dengan `COOKIE_SECURE=1` (atau `0`) di `.env` bila arsitektur Anda tidak terdeteksi otomatis.
- **API key di `.env`** — sudah tercantum di `.gitignore`. **Jangan commit `.env`** ke repo publik.
  Jika key pernah terekspos, **rotate** di <https://console.groq.com/keys>.

> Untuk deployment nyata: jalankan di belakang HTTPS (cookie akan otomatis ber-`Secure`; pastikan
> reverse proxy meneruskan `X-Forwarded-Proto`), ganti kata sandi akun staf bawaan setelah run
> pertama, dan set `SEED_PASSWORD` sendiri sebelum server dijalankan pertama kali.

---

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| `Groq key loaded: NO` | Pastikan `GROQ_API_KEY` ada di `.env` dan server di-restart. |
| Fitur AI error `Groq API 401` | Key salah/dicabut — buat key baru di console Groq. |
| Fitur AI error `Groq API 429` | Rate limit tercapai — tunggu sebentar atau ganti model. |
| `require('node:sqlite')` error | Versi Node < 22.5 — perbarui Node.js. |
| Data ingin direset | `npm run seed` (atau hapus folder `data/`, lalu jalankan ulang). |
| Port 3000 dipakai | Ubah `PORT` di `.env`. |
| `RAG init warning: GEMINI_API_KEY tidak disetel` | Impor PDF & retrieval RAG butuh Gemini — isi `GEMINI_API_KEY` di `.env` atau panel **Pengaturan → Konfigurasi Embedding**, lalu restart. |
| Impor PDF error `Gemini 429` | Rate limit Gemini (free tier ~100 embed/menit) tercapai — tunggu sebentar, impor dokumen lebih kecil, atau pakai tier berbayar. |
| `sqlite-vec tidak dimuat` di log | Native non-macOS-arm64 / Node < 23.5: set `SQLITE_VEC_PATH` ke `vec0.{so,dylib,dll}` yang sesuai, atau pakai Docker. App tetap jalan via fallback cosine JS. |
| Data kuis/PDF hilang setelah `npm run docker:down` | Pastikan volume `auditor-data` tidak dihapus (`docker compose -f docker/docker-compose.yml down -v` menghapus volume). |
