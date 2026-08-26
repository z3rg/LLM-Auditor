# LLM Auditor

Aplikasi analitik hasil kuis **IT Auditor** lintas divisi, ditenagai **Groq** (open-source LLM API).
Mengubah data kuis menjadi **rekomendasi AI untuk gap pengetahuan**, **saran topik kuis**, **SQL Agent**
bahasa-natural, **tren skor per waktu**, dan alur persetujuan **Super Admin → Direktur**.

> **Serverless-first**: berjalan di **EdgeOne Makers** — frontend statis + API sebagai Cloud
> Function — dengan seluruh state di **Postgres (Neon) + pgvector**. Dependency runtime-nya dua:
> `express` dan driver HTTP `@neondatabase/serverless`; sisanya modul bawaan Node
> (`node:http`, `node:crypto`, `node:zlib`, `fetch`).
> **Embedding RAG memakai Google Gemini** (`gemini-embedding-001`, 3072-dim) lewat `fetch` —
> butuh **`GEMINI_API_KEY`**. Tidak ada model lokal atau fallback leksikal: tanpa key, fitur
> RAG (impor PDF & retrieval) tidak aktif.

---

## Daftar Isi
1. [Fitur](#fitur)
2. [Kebutuhan Sistem](#kebutuhan-sistem)
3. [Setup](#setup)
4. [Menjalankan Aplikasi](#menjalankan-aplikasi)
5. [Deploy ke EdgeOne Makers](#deploy-ke-edgeone-makers)
6. [Deploy dengan Docker (Portable)](#deploy-dengan-docker-portable)
7. [Cara Pakai (per Peran)](#cara-pakai-per-peran)
8. [Data Dummy](#data-dummy)
9. [Referensi API](#referensi-api)
10. [Arsitektur](#arsitektur)
11. [Keamanan](#keamanan)
12. [Troubleshooting](#troubleshooting)

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
| 8 | **PDF Importer → RAG (pgvector)** | Di tab **Pengaturan** (Super Admin), unggah PDF → teks diekstrak, dipotong dengan **parser hierarki hukum** (BAB/Pasal/Seksi/Poin, default), di-*embed* oleh **Gemini `gemini-embedding-001`** (3072-dim), lalu disimpan ke **Postgres + `pgvector`** sebagai basis pengetahuan. Butuh `GEMINI_API_KEY`. |
| 9 | **Kuis berbasis ReAct + RAG (per soal)** | Saat membuat kuis, agen **ReAct** (Reason + Act) **merencanakan sub-konsep**, lalu memanggil `search_knowledge` **terpisah untuk SETIAP soal** menarik materi paling relevan dari PDF (RAG via pgvector), baru menyusun tiap soal yang *grounded* pada materinya. Setiap soal menampilkan **sumber PDF-nya**; bila materi tipis, soal disusun dari pengetahuan umum dan **ditandai** (blend). Jejak penalaran (Thought/Action/Observation) + rasio `grounded` ditampilkan di UI. |

---

## Kebutuhan Sistem

Wajib:

- **Node.js ≥ 20** (versi yang dipakai runtime EdgeOne Cloud Functions). Cek: `node --version`.
- **Database Postgres + pgvector di [Neon](https://neon.tech)** — tier gratis cukup. Driver yang
  dipakai berbicara lewat endpoint HTTP Neon, jadi `DATABASE_URL` harus URL Neon; Postgres di
  localhost tidak akan terhubung.
- Koneksi internet untuk memanggil **Groq API** (fitur AI) dan **Gemini API** (embedding RAG).
- **API key Groq** — gratis di <https://console.groq.com/keys>.
- **API key Gemini** (untuk RAG/PDF importer) — gratis di <https://aistudio.google.com/apikey>.

Opsional:
- **Docker**, bila ingin menjalankannya sebagai kontainer di VM alih-alih di EdgeOne. Lihat
  [Deploy dengan Docker](#deploy-dengan-docker-portable).
- **Node ≥ 22.5** bila ingin menjalankan `npm run db:migrate` — skrip migrasi itu membaca
  snapshot SQLite lama lewat `node:sqlite`. Aplikasinya sendiri tidak.

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

Lalu pasang dependency dan siapkan database sekali saja:

```bash
npm install        # express + driver Neon
npm run db:setup   # terapkan db/schema.sql, isi data dummy, siapkan akun staf
```

> **Kenapa ini langkah terpisah?** Di versi SQLite, skema & data dibuat otomatis saat modul
> database dimuat. Itu tidak cocok untuk serverless — setiap cold start akan menjalankan DDL —
> jadi penyiapan sekarang eksplisit dan hanya sekali.
>
> Sudah punya data demo di `data/auditor.db`? Pindahkan seluruh isinya (termasuk 452 chunk RAG,
> tanpa memanggil Gemini) dengan `npm run db:migrate`.
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
  Database:             Postgres (Neon)
  RAG embedder:         gemini:gemini-embedding-001 (dim 3072)
  RAG vector store:     pgvector (cosine) — 452 chunk
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

> **Tentang `data/auditor.db` yang ikut di repo.** Sejak port ke Postgres, berkas ini bukan lagi
> database yang dipakai aplikasi — ia hanya **sumber migrasi**: snapshot demo berisi 391 hasil
> kuis dan indeks RAG 452 chunk dari tiga dokumen POJK, yang dipindahkan sekali dengan
> `npm run db:migrate`. Aplikasi tidak pernah membukanya lagi, sehingga jebakan lama (menjalankan
> app diam-diam mengotori snapshot yang dilacak git) hilang dengan sendirinya.
>
> Akun staf di dalamnya memakai kata sandi awal yang tertulis di README ini, jadi **anggap ketiga
> akun itu publik** dan ganti kata sandinya pada instalasi yang Anda pakai sungguhan.

### Ingest massal PDF hukum (CLI)

Untuk memuat **PDF hukum berukuran besar** ke basis pengetahuan RAG tanpa lewat UI, tersedia
skrip Python `scripts/ingest_legal_pdf.py` (memakai **pypdf** untuk ekstraksi teks dan **Gemini**
untuk embedding — model & dimensi sama persis dengan app Node, menulis ke tabel
`pdf_documents`/`pdf_chunks` yang sama):

```bash
pip install pypdf google-genai "psycopg[binary]"   # sekali
export GEMINI_API_KEY=AIza_xxxxxxxx
export DATABASE_URL='postgresql://…'               # database yang sama dengan app

npm run ingest-legal -- /path/to/regulasi.pdf       # via npm (perhatikan `--`)
# atau langsung:
python3 scripts/ingest_legal_pdf.py /path/to/regulasi.pdf
```

Skrip mem-parse hierarki **BAB → Seksi (A./B.) → Poin (1./2.) → Sub-poin (a./b.)**, menambahkan
*breadcrumb* sebagai konteks tiap chunk, lalu meng-embed dengan `gemini-embedding-001`.
Skemanya dimiliki `db/schema.sql`, jadi jalankan `npm run db:setup` lebih dulu.
Server Node membaca hasilnya langsung (skrip men-set `embed_meta` ke `gemini:…` sehingga tidak
ada re-embed saat server restart).

> **Rate limit Gemini (free tier): ~100 embed/menit.** Skrip sudah memberi jeda antar-panggilan. Untuk dokumen sangat besar, pertimbangkan tier berbayar agar tidak
> kena `429`.

---

## Deploy ke EdgeOne Makers

Target deploy utama. Frontend disajikan static hosting, `/api/*` berjalan sebagai Cloud Function,
dan seluruh state ada di Neon — instance-nya sendiri tidak menyimpan apa pun.

### 1. Siapkan database

```bash
DATABASE_URL='postgresql://…neon.tech/neondb?sslmode=require' npm run db:setup
# opsional, bawa data demo + 452 chunk RAG:
DATABASE_URL='…' npm run db:migrate
```

### 2. Hubungkan repo

Buka <https://console.tencentcloud.com/edgeone/makers> → **New project** → pilih repositori ini →
branch yang ingin dideploy. Konfigurasi build sudah ada di `edgeone.json`, jadi biarkan
terdeteksi otomatis:

| Field | Nilai |
|-------|-------|
| Node version | `22.11.0` |
| Install command | `npm install` |
| Output directory | `public` |
| Cloud function timeout | `120` detik (`cloudFunctions.nodejs.maxDuration`) |

### 3. Isi environment variable

Di **Project settings → Environment variables**:

| Variabel | Keterangan |
|----------|------------|
| `DATABASE_URL` | Connection string Neon — wajib |
| `GROQ_API_KEY` | Fitur AI Groq |
| `GROQ_MODEL` | Opsional, default `llama-3.3-70b-versatile` |
| `GEMINI_API_KEY` | Embedding RAG / impor PDF |
| `GEMINI_EMBED_MODEL` | Opsional, default `gemini-embedding-001` |
| `SEED_PASSWORD` | Hanya dibaca saat `npm run db:setup`, bukan saat runtime |

### 4. Deploy & verifikasi

```bash
curl -s https://<project>.edgeone.app/api/config
```

Balasan yang sehat memuat `"hasKey": true` dan objek `rag`. Login lewat browser; karena EdgeOne
mengakhiri TLS dan meneruskan `X-Forwarded-Proto: https`, cookie sesi otomatis ber-`Secure`
tanpa perubahan konfigurasi.

### Batas platform yang perlu diingat

| Batas | Nilai | Dampak |
|-------|-------|--------|
| Durasi function | maks **120 detik** | Generate kuis ReAct memanggil Groq 2x + 12 embedding Gemini; jalur normal ±25-60 detik |
| Body request | **6 MB** | Batas unggah PDF disamakan di `lib/api.js`; seluruh PDF POJK di repo < 600 KB |
| Runtime | Node.js | Tidak ada filesystem persisten — karena itu state pindah ke Postgres |

---

## Deploy dengan Docker (Portable)

Alternatif dari EdgeOne, untuk menjalankan app di VM biasa. Kontainernya **stateless**: seluruh
data ada di Postgres, jadi tidak ada volume dan tidak ada berkas database di dalam image.
Kontainer melakukan panggilan jaringan saat runtime dan perlu tiga nilai — **`DATABASE_URL`**
(Neon), **`GROQ_API_KEY`** (fitur AI Groq), dan **`GEMINI_API_KEY`** (embedding RAG / impor PDF).

Panduan lengkap sampai instance hidup: [`deploy/tencent/README.md`](deploy/tencent/README.md).

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
  -e DATABASE_URL='postgresql://…neon.tech/neondb?sslmode=require' \
  -e GROQ_API_KEY=gsk_xxxxxxxx \
  -e GEMINI_API_KEY=AIza_xxxxxxxx \
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
| **Persistensi** | Tidak ada di kontainer — seluruh state di Postgres (Neon) lewat `DATABASE_URL`. Kontainer boleh dibuang kapan saja. |
| **Embedding** | Memakai **Gemini API** saat runtime — berikan `GEMINI_API_KEY` (env atau via `.env`). Tanpa key, fitur RAG nonaktif; fitur Groq lain tetap jalan. Tidak ada model lokal di image. |
| **Dependency** | `npm ci --omit=dev` di stage terpisah (express + driver Neon), jadi lapisan cache tidak batal setiap kali kode berubah. |
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
   Lihat status vector store, daftar dokumen, **Uji Pencarian** (retrieval), panel
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
- Database: **Postgres + pgvector** (Neon) lewat `DATABASE_URL`. **Ambang gap** = skor rata-rata `< 70`.

### View analitik (untuk SQL Agent)

Logika "gap" (rata-rata skor `< 70`) **dibakukan ke dalam VIEW** Postgres (`db/schema.sql`) agar SQL Agent menjawab
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
| `server.js` | Entri **dev lokal**: HTTP server Node built-in + static files; memanggil router yang sama dengan produksi |
| `cloud-functions/api/[[default]].js` | Entri **produksi**: Cloud Function EdgeOne (Express) yang mem-*mount* `lib/api.js` |
| `lib/api.js` | Router JSON API bebas framework — seluruh rute `/api/*`, dipakai bersama oleh kedua entri |
| `lib/pg.js` | Koneksi Postgres lewat driver HTTP Neon (`query/one/many/exec/scalar`) |
| `db/schema.sql` | DDL Postgres: tabel, index, dan kelima view analitik gap |
| `edgeone.json` | Konfigurasi Makers: versi Node, output statis, `maxDuration` function 120 detik |
| `lib/db.js` | Akses data Postgres (async): penerapan skema, seed deterministik, helper analitik gap & tren, akun/sesi/throttle, `app_settings` |
| `lib/groq.js` | Wrapper Groq Chat Completions + fitur AI (rekomendasi, topik kuis, SQL Agent) + **generator kuis ReAct + RAG** |
| `lib/vec.js` | Basis pengetahuan RAG: chunking (**parser hierarki hukum** default + chunker paragraf generik) + pencarian **pgvector** (cosine) + reindex saat backend embedding berubah |
| `lib/embedder.js` | Embedder **Gemini-only** (`gemini-embedding-001`, 3072-dim) via `fetch`; butuh `GEMINI_API_KEY`, tanpa fallback lokal |
| `lib/pdf.js` | Ekstraktor teks PDF tanpa dependency (FlateDecode via `node:zlib`) |
| `scripts/ingest_legal_pdf.py` | Ingest CLI massal PDF hukum (pypdf + Gemini) → menulis ke tabel RAG yang sama; `npm run ingest-legal` |
| `scripts/db_setup.js` | Terapkan skema + seed + bootstrap akun staf; `npm run db:setup` |
| `scripts/migrate_sqlite_to_pg.js` | Migrasi sekali jalan `data/auditor.db` → Postgres (embedding ikut, tanpa panggil Gemini); `npm run db:migrate` |
| `scripts/test_auth.js` | Uji regresi autentikasi (43 pemeriksaan) di atas branch Neon uji; `npm run test:auth` |
| `docker/` | Berkas Docker: `Dockerfile`, `docker-compose.yml`, `Dockerfile.dockerignore`. Image stateless; konteks build = root |
| `data/auditor.db` | Snapshot SQLite lama — **hanya sumber migrasi**, tidak dibuka aplikasi |
| `deploy/tencent/` | Jalur alternatif: deploy kontainer ke Tencent Cloud Lighthouse |
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
  nonaktif. Vektor di-L2-normalize sehingga `similarity = 1 - cosine_distance`. Bila
  nama/dimensi backend berubah dari yang tersimpan (`embed_meta`), `lib/vec.js` otomatis
  **reindex** (embed ulang semua chunk dari teks, dengan jeda agar tidak kena rate limit).
- **Chunking hukum (default)**: saat impor PDF, `lib/vec.js` memakai **parser hierarki hukum**
  (`parseHierarchyChunks`: BAB → Pasal → Seksi `A./B.` → Poin `1./2.` → Sub-poin `a./b.`) yang
  memberi *breadcrumb* konteks pada tiap chunk. Bila toggle parser dimatikan, dipakai chunker
  paragraf generik. Untuk ingest massal di luar UI, lihat
  [Ingest massal PDF hukum (CLI)](#ingest-massal-pdf-hukum-cli) (`scripts/ingest_legal_pdf.py`).
- **pgvector**: potongan teks disimpan di kolom `vector(3072)` dan dicari dengan operator jarak
  cosine `<=>`. Belum ada index vektor — dengan ratusan chunk, sequential scan sudah sub-milidetik,
  dan HNSW pada tipe `vector` memang dibatasi 2000 dimensi. Kalau korpus tumbuh besar, pindahkan
  kolomnya ke `halfvec(3072)` lalu buat index HNSW.
- **ReAct**: `generateQuizReAct()` menjalankan loop Thought → Action (`search_knowledge`) →
  Observation hingga materi cukup, lalu menyusun soal yang *grounded* pada konteks PDF.
  Toggle ReAct/RAG tersedia di tab **Pengaturan**.

Alur data: `Browser → /api/* → lib/api.js → lib/db.js → Postgres (Neon)` dan
`lib/api.js → lib/groq.js → Groq API` untuk fitur AI. Grafik tren digambar sebagai **SVG murni**
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
| `DATABASE_URL belum disetel` | Isi connection string Neon di `.env`, lalu `npm run db:setup`. |
| `relation "employees" does not exist` | Skema belum diterapkan — jalankan `npm run db:setup`. |
| Data ingin direset | `npm run seed` (mengosongkan tabel operasional lalu mengisi ulang data dummy). |
| Port 3000 dipakai | Ubah `PORT` di `.env`. |
| `RAG init warning: GEMINI_API_KEY tidak disetel` | Impor PDF & retrieval RAG butuh Gemini — isi `GEMINI_API_KEY` di `.env` atau panel **Pengaturan → Konfigurasi Embedding**, lalu restart. |
| Impor PDF error `Gemini 429` | Rate limit Gemini (free tier ~100 embed/menit) tercapai — tunggu sebentar, impor dokumen lebih kecil, atau pakai tier berbayar. |
| Kuis gagal dengan timeout di EdgeOne | Naikkan `cloudFunctions.nodejs.maxDuration` di `edgeone.json` (maks 120 detik), atau matikan toggle ReAct di tab Pengaturan. |
