# Panduan Developer — LLM Auditor

Dokumen ini untuk **pengembangan lanjutan**. Untuk cara pakai & deploy, lihat
[README.md](README.md).

---

## 1. Filosofi & Stack

- **Backend nyaris tanpa dependency**: satu paket runtime saja —
  `@neondatabase/serverless` (driver HTTP Postgres). Selebihnya modul bawaan Node
  (`node:http`, `node:stream`, `node:crypto`, `node:zlib`, `fetch`). Tidak ada framework web,
  ORM, bundler, atau SDK vendor.
- **Frontend tanpa build step**: HTML + CSS + satu file `app.js` vanilla. Tidak ada React/Vite.
- **Data**: Postgres (Neon) + `pgvector` untuk vektor. Tidak ada state di filesystem — runtime
  EdgeOne bersifat ephemeral.
- **LLM**: **AI Gateway EdgeOne Makers** (OpenAI-compatible Chat Completions) via `fetch`,
  model bawaan `@makers/deepseek-v4-flash`. Groq tetap jadi jalur alternatif karena skemanya
  identik — lihat `provider()` di `lib/ai.js`.
- **Embedding RAG**: Google **Gemini** (`gemini-embedding-001`, 3072-dim) via `fetch` —
  panggilan jaringan, butuh `GEMINI_API_KEY`. Tidak ada model lokal; tidak ada fallback leksikal.

> Prinsip saat menambah fitur: jangan menambah dependency kalau modul bawaan cukup, dan jangan
> pernah menyimpan state di disk — layanan eksternal (AI Gateway Makers, Gemini) dipanggil langsung via
> `fetch` tanpa SDK, dan apa pun yang harus bertahan masuk ke Postgres.

---

## 2. Peta Berkas

```
server.js              Entri DEV LOKAL: HTTP server + static files + warmup RAG
cloud-functions/
  package.json         {"type":"module"} — menandai folder ini ESM, lib/ tetap CommonJS
  api/[[default]].js   ARTEFAK bundle (hasil npm run build:function) - di-commit
  api/ping.js          Probe tanpa import: menguji runtime function
functions-src/
  api-entry.mjs        SUMBER cloud function: adapter Fetch -> req/res Node -> lib/api.js
edgeone.json           Konfigurasi Makers: nodeVersion, outputDirectory, maxDuration 120s
db/
  schema.sql           DDL Postgres: tabel, index, kelima view analitik gap
lib/
  auth.js              Autentikasi: hash scrypt, sesi + cookie HttpOnly, throttle login, bootstrap akun staf
  api.js               Router JSON API bebas framework (dipakai server.js DAN cloud function)
  pg.js                Koneksi Postgres via driver HTTP Neon (query/one/many/exec/scalar)
  db.js                Akses data Postgres (async): apply schema, seed deterministik, analitik gap, akun & sessions
  env.js               Pemuat .env mini untuk dev lokal
  ai.js                Wrapper Chat Completions (default AI Gateway Makers, alternatif Groq) + fitur AI + generator kuis ReAct
  vec.js               RAG store: chunking (parser hukum + generik), pencarian pgvector (cosine), reindex
  embedder.js          Embedder Gemini-only (gemini-embedding-001, 3072-dim) via fetch
  pdf.js               Ekstraktor teks PDF (FlateDecode via zlib)
scripts/
  ingest_legal_pdf.py  Ingest CLI massal PDF hukum (pypdf + Gemini + psycopg) -> tabel RAG yang sama
  db_setup.js          Terapkan skema + seed + bootstrap akun staf (npm run db:setup)
  migrate_sqlite_to_pg.js  Migrasi sekali jalan data/auditor.db -> Postgres (npm run db:migrate)
  test_auth.js         Uji regresi auth di atas branch Neon terpisah (npm run test:auth)
public/
  index.html           Markup (layar Masuk/Daftar + semua tab, termasuk Pengaturan & Akun)
  app.js               Semua logika frontend (termasuk alur auth & pengelolaan akun)
  styles.css           Tema dashboard
  auth.css             Tema layar Masuk/Daftar (kertas kerja + register kontrol + stempel)
docker/
  Dockerfile           Image stateless (npm ci --omit=dev); jalur alternatif ke VM
  docker-compose.yml   Orkestrasi 1-perintah (context build = root, ../); tanpa volume
  Dockerfile.dockerignore  Apa yang TIDAK ikut ke image (BuildKit auto-discover by name)
deploy/tencent/        Jalur alternatif: kontainer di Tencent Cloud Lighthouse
data/
  auditor.db           Snapshot SQLite lama - HANYA sumber migrasi, tidak dibuka aplikasi
.venv/                 Virtualenv Python untuk scripts/ingest_legal_pdf.py (di-gitignore)
```

---

## 3. Setup Dev Lokal

```bash
cp .env.example .env          # isi DATABASE_URL (Neon) + MAKERS_MODELS_KEY + GEMINI_API_KEY
npm install                   # driver Neon + esbuild (dev)
npm run db:setup              # terapkan skema, isi data dummy, siapkan akun staf
node server.js                # atau ./start.sh
npm run seed                  # reset data dummy
```

Tidak ada langkah build/unduh model: embedding RAG memakai Gemini API saat runtime.

Verifikasi cepat:

```bash
curl localhost:3000/api/config | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).rag))"
```

`rag.embedder` harus `gemini:gemini-embedding-001` (dengan `rag.dim=3072`) saat `GEMINI_API_KEY`
aktif, dan `rag.backend` selalu `pgvector (cosine)`.

---

## 4. Alur Data

```
Browser ──/api/*──> lib/api.js ──> lib/db.js ──> lib/pg.js ──HTTP──> Postgres (Neon)
       (server.js lokal /            ├──> lib/ai.js   ──fetch──> AI Gateway Makers
        cloud function di EdgeOne)   └──> lib/vec.js ──> lib/embedder.js ──fetch──> Gemini API
                                                   └──> pgvector (<=> cosine)
```

- **Autentikasi**: cookie sesi `sid` (HttpOnly, SameSite=Lax, 7 hari; `Secure` ditambahkan
  otomatis saat `isSecureRequest()` mendeteksi HTTPS — `X-Forwarded-Proto` dari reverse proxy,
  koneksi TLS langsung, atau paksaan `COOKIE_SECURE`). Token acak 32 byte,
  disimpan **ter-hash SHA-256** di tabel `sessions`; kata sandi di-hash **scrypt** dengan salt
  per akun. `auth.currentUser(req)` me-resolve akun dari cookie di awal `api()` — seluruh
  endpoint di luar `/api/auth/*` menolak request tanpa sesi dengan `401`.
- **Kontrol akses**: peran dibaca dari akun pada sesi (`employee|auditor|director|super_admin`),
  bukan dari header/body klien. Endpoint analitik dibatasi peran staf, endpoint Super Admin
  memakai `isSuper(user)`, dan endpoint peserta selalu memakai `user.id` (klien tidak bisa
  menyamar sebagai peserta lain — `/api/quiz/submit` juga memverifikasi kepemilikan sesi kuis).
- **Pendaftaran**: `POST /api/auth/register` selalu membuat akun `role='employee'`. Kenaikan
  peran & penonaktifan lewat `/api/admin/users/:id/{role,status}` (Super Admin); menonaktifkan
  akun langsung menghapus seluruh sesinya.
- **Quiz pipeline (Fitur 7/9)**: `/api/quiz/generate` → `ai.generateQuizReAct()` (ReAct) →
  tool `search_knowledge` memanggil `vec.search()` → `ai.groundedGenerate()` menyusun soal →
  disimpan ke `quiz_sessions` (jawaban benar di-strip sebelum dikirim ke klien) →
  `/api/quiz/submit` menilai & meng-update `quiz_attempts`.

---

## 5. Model Data (Postgres)

Tabel inti: `divisions`, `topics`, `employees`, `quiz_attempts`, `recommendations`,
`quiz_sessions`, `app_settings`, `sessions`, `login_attempts`. Akun hidup di `employees` (kolom
`password_hash`, `status`, `created_at` + unique index `lower(email)`) sehingga peserta yang
mendaftar langsung ikut ke seluruh view analitik gap tanpa join tambahan. RAG: `pdf_documents`
dan `pdf_chunks` dengan kolom `embedding vector(3072)`.

Seluruh DDL ada di `db/schema.sql`, diterapkan lewat `npm run db:setup` — bukan lagi otomatis
saat modul dimuat, karena di serverless itu berarti DDL di setiap cold start.

> **Cast agregat itu wajib.** Driver Postgres mengembalikan `bigint` dan `numeric` sebagai
> **string**, jadi `COUNT(*)` tanpa `::int` akan membuat `a + b` di JS menjadi penggabungan
> string. Pola di seluruh kode: `COUNT(*)::int`, `SUM(x)::int`, `ROUND(AVG(x), 1)::float8`.
> Alias camelCase juga wajib dikutip (`AS "divisionId"`) karena Postgres melipat identifier
> tanpa kutip menjadi huruf kecil.

**View analitik** membakukan logika gap (rata-rata `< GAP_THRESHOLD`) — selalu pakai view
untuk pertanyaan skor/gap (lihat `schemaDescription()` & komentar di `lib/db.js`):
`v_employee_topic`, `v_division_topic`, `v_division_score`, `v_topic_score`, `v_employee_score`.

`app_settings(key,value)` menyimpan toggle (`quiz_use_react`, `quiz_use_rag`, `pdf_legal_mode`),
konfigurasi embedding Gemini (`embed_backend`, `embed_gemini_key`, `embed_gemini_model` — di-set
via Settings UI, menang atas env), dan meta embedder (`embed_meta` = `{name,dim}`) untuk deteksi
perubahan backend/dimensi.

---

## 6. Subsistem RAG

### 6.1 Embedder (`lib/embedder.js`)

**Gemini-only.** `init()` (memoized, async) menyelesaikan satu backend — Google Gemini
(`gemini-embedding-001`, **3072-dim**) via `fetch` ke
`generativelanguage.googleapis.com/v1beta/.../:embedContent`:

- **Kunci**: `getDbSetting('embed_gemini_key')` (di-set via Settings UI) **menang atas**
  `process.env.GEMINI_API_KEY`. Bila keduanya kosong, `init()` **melempar error** — tidak ada
  fallback lokal/leksikal. Model: `embed_gemini_model` (DB) atau `GEMINI_EMBED_MODEL` (env),
  default `gemini-embedding-001`.
- **`role`**: `'query'` → `taskType: RETRIEVAL_QUERY`; lainnya → `RETRIEVAL_DOCUMENT`.
- **Probe dimensi**: `tryGemini()` membaca `dim` dari `embed_meta` yang tersimpan bila namanya
  cocok, sehingga **tidak** memboroskan satu panggilan API (kuota) tiap server restart; baru
  melakukan probe live (`embed 'a'`) bila belum ada.

Backend mengembalikan `{ name:'gemini:<model>', dim, kind:'model', embed(text, role) -> Float32Array }`.
Vektor diperlakukan sebagai unit-norm (gemini-embedding-001 @3072-dim) → `similarity = 1 - (a <=> b)`.

`reconfigure({ geminiKey, geminiModel })` menyimpan setting ke DB, mereset memoization, lalu
`init()` ulang; `server.js` (`POST /api/settings/embed`) memanggilnya lalu `vec.resetEmbedder()`
agar index di-reindex bila dimensi berubah.

### 6.2 Vector store (`lib/vec.js`)

- `ready()` (memoized): init embedder lalu **rekonsiliasi index** —
  bila `embed_meta` berbeda (nama/dim) → `reindex()` meng-embed ulang semua chunk dari teks, dan
  bila dimensinya berubah ia juga `ALTER TABLE pdf_chunks ALTER COLUMN embedding TYPE vector(N)`
  (tipe pgvector mengunci dimensi). Server lokal memanggil `await vec.ready()` sebelum `listen`;
  di Cloud Function pemanggilan itu terjadi lazily pada request RAG pertama. `reindex()` **memberi jeda** (`sleep(200)` tiap 20 chunk) untuk backend Gemini
  agar tidak menabrak rate limit free-tier.
- **Chunking**: `addDocument({ legalMode })` default `legalMode = true` → `parseHierarchyChunks()`
  (BAB → Pasal → Seksi `A./B.` → Poin `1./2.` → Sub-poin `a./b.`, dengan *breadcrumb* `[crumb]`
  di awal tiap chunk). Bila `legalMode=false`, pakai `chunkText()` paragraf generik. Server
  membaca toggle dari `pdf_legal_mode` (`db.getBool`, default true).
- `addDocument()` / `search()` **async** (menunggu `ready()` + embed Gemini).
- `search()` mengurutkan dengan operator jarak cosine pgvector: `ORDER BY embedding <=> $1::vector`.
  Tidak ada jalur fallback lagi — satu implementasi, satu perilaku.

> **GOTCHA penting**: vektor dikirim sebagai **teks** lalu di-cast (`$1::vector`), bukan sebagai
> array biner. Jangan lupa `::vector`-nya; tanpa itu Postgres menolak dengan
> *"column embedding is of type vector but expression is of type text"*.
>
> **Index sengaja tidak ada.** HNSW pada tipe `vector` dibatasi 2000 dimensi sedangkan embedding
> kita 3072, dan dengan ratusan chunk sequential scan sudah sub-milidetik. Kalau korpus tumbuh
> besar, pindahkan kolomnya ke `halfvec(3072)` (batas HNSW 4000) lalu buat index.

### 6.3 PDF (`lib/pdf.js`)

Best-effort untuk PDF **berbasis teks**: decode stream `FlateDecode` via `node:zlib`, lalu tarik
teks dari operator `Tj/TJ` di dalam blok `BT…ET`. Diproses dalam encoding **`latin1`** (1 byte =
1 char code). PDF hasil scan/gambar tidak menghasilkan teks → ditolak oleh `/api/pdf/import`.

---

## 7. Pipeline ReAct (`lib/groq.js`)

Kuis peserta (`POST /api/quiz/generate`, bila toggle ReAct aktif) memakai
**`generateQuizReActPerQuestion(topic, area, n, { search, hasKB })`** — grounding **per soal**:

1. **Plan (ReAct reasoning)** — `planQuizSubtopics()` menalar `n` sub-konsep BERBEDA + satu query
   pencarian per sub-konsep (1 panggilan LLM, JSON).
2. **Retrieval per soal** — untuk tiap sub-konsep, `search(query)` (→ `vec.search`, pgvector)
   dijalankan TERPISAH. Tiap blok materi = dasar satu soal. `grounded` true bila similarity top
   chunk `≥ GROUND_MIN` (default **0.63**, env `QUIZ_GROUND_MIN`; di atas lantai-noise embedding
   Gemini ~0.60). Materi di bawah ambang tetap dilampirkan sedikit (blend) tapi soalnya ditandai
   `grounded:false`.
3. **Grounded generation** — `groundedGeneratePerQuestion()`: satu panggilan JSON membuat tepat
   1 soal per blok (field `block` memetakan soal↔blok); soal blok-k WAJIB berbasis konteks blok-k,
   atau dari pengetahuan umum bila konteks kosong.
4. Return `{ questions, model, trace, sources, groundedCount }`. Tiap question membawa
   `grounded`, `source`, `similarity`, `subconcept` — disimpan di payload sesi dan disurfacing ke
   UI (badge 📚 sumber / 💡 pengetahuan umum per soal + ringkasan `groundedCount/n`).

> **Granularitas**: retrieval & grounding di sini **per soal** (n query embed/kuis). Bila KB kosong
> atau RAG dimatikan, `search=null` → semua soal `grounded:false` (pengetahuan umum), trace tetap
> menampilkan langkah plan.

Versi lama **`generateQuizReAct()`** (loop Thought→Action→Observation, satu retrieval *pooled* →
N soal via `groundedGenerate()`) masih diekspor untuk kompatibilitas, tetapi jalur kuis peserta
kini memakai varian per-soal. Pemisahan **reasoning/retrieval** dari **generation final** tetap
dipertahankan agar JSON soal tidak terpotong di tengah loop.

---

## 8. Resep "Cara Menambah …"

### Menambah endpoint API
Tambahkan cabang di fungsi `api()` di `server.js` (cek `req.method` + `url.pathname`,
gunakan `sendJson`). Untuk body JSON pakai `readBody(req)`; untuk biner pakai `readRawBody(req)`.
Endpoint otomatis butuh sesi (objek `user` tersedia di dalam `api()`); tambahkan cek peran
dengan `isSuper(user)` / `isStaff(user)` bila perlu, atau daftarkan path di `STAFF_ONLY`.
Dokumentasikan di tabel API README.

### Mengganti model embedding Gemini
Embedding RAG terikat ke satu backend (Gemini). Ganti model lewat `GEMINI_EMBED_MODEL` (env) atau
panel **Pengaturan → Konfigurasi Embedding** (`POST /api/settings/embed` → `embedder.reconfigure`).
Bila model baru punya **dimensi berbeda**, `embed_meta` berubah → `vec.js` otomatis `reindex()`
semua chunk dari teks. Tidak ada langkah konversi/ONNX/unduh model.

> Bila menambah penyedia embedding lain di masa depan, ikuti kontrak
> `{ name, dim, kind:'model', embed(text, role) -> Float32Array }` dari `tryGemini()`, dan
> pertahankan vektor unit-norm agar `1 - (a <=> b)` tetap terbaca sebagai cosine similarity.

### Ingest massal PDF hukum (di luar UI)
`scripts/ingest_legal_pdf.py` (pypdf + `google-genai` + `psycopg`) menulis ke tabel RAG yang
sama dan men-set `embed_meta` ke `gemini:<model>` agar server tidak re-embed saat restart.
Jalankan `npm run ingest-legal -- <file.pdf>` (atau `python3 scripts/ingest_legal_pdf.py <file.pdf>`)
dengan `GEMINI_API_KEY` **dan** `DATABASE_URL` ter-set; skemanya harus sudah ada (`npm run db:setup`). Model, dimensi (3072), aturan parser hierarki, dan `MAX_CHARS`
harus tetap **sinkron** dengan `lib/embedder.js`/`lib/vec.js`.

### Menambah tab UI
Tambah `<a class="nav-item" data-tab="x" data-roles="...">` + `<section id="tab-x">` di
`index.html`, lalu fungsi `loadX()` di `app.js` dan panggil dari handler nav (`data-tab==='x'`).

---

## 9. Docker (internal)

Semua berkas Docker ada di **`docker/`**; **konteks build = root repo**. Jalankan dari root:
`docker build -f docker/Dockerfile -t llm-auditor .` atau
`docker compose -f docker/docker-compose.yml --env-file .env up --build` (atau `npm run docker:up`).

`docker/Dockerfile` multi-stage (basis `node:22-bookworm-slim`):

- **deps**: `COPY package.json package-lock.json` → `npm ci --omit=dev`. Lapisan terpisah supaya
  cache dependency tidak batal setiap kali kode berubah. **Tidak ada** model lokal/ONNX.
- **runtime**: `COPY --from=deps /app/node_modules` + `COPY . .` → `chown` → user non-root `node`
  → `HEALTHCHECK` ke `/api/config`.

Kontainernya **stateless** — tidak ada `VOLUME`, tidak ada berkas database. **Rahasia diberikan
saat `docker run`/compose**: `DATABASE_URL` (Neon), `MAKERS_MODELS_KEY`, dan `GEMINI_API_KEY` — image
tidak menyimpan satu pun.

`docker/Dockerfile.dockerignore` (BuildKit otomatis memakai `<dockerfile>.dockerignore`; pola
relatif ke konteks root) **mengecualikan** `node_modules/`, `.venv/`, `data/`, `*.db*`, `.env`,
`.cache/`, `*.md`.

`docker/docker-compose.yml`: `name: llm-auditor`, `build.context: ..` + `dockerfile: docker/Dockerfile`. Interpolasi `${...}` membaca `.env`
root via flag `--env-file .env`.

> Arsitektur yang didukung: `linux/amd64`, `linux/arm64`.

---

## 10. Referensi Variabel Lingkungan

| Var | Default | Fungsi |
|-----|---------|--------|
| `MAKERS_MODELS_KEY` | — | Kunci AI Gateway Makers (wajib untuk fitur AI) |
| `MAKERS_MODEL` | `@makers/deepseek-v4-flash` | Id model di gateway |
| `AI_PROVIDER` | *(auto)* | Paksa `makers` atau `groq`; auto = `makers` bila kuncinya ada |
| `GROQ_API_KEY` | — | Jalur alternatif bila tidak memakai gateway Makers |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Model chat Groq |
| `GEMINI_API_KEY` | — | Key Google Gemini (wajib untuk embedding RAG / impor PDF); bisa juga di-set via Settings UI |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | Model embedding Gemini (3072-dim) |
| `PORT` | `3000` | Port HTTP (dev lokal saja) |
| `DATABASE_URL` | — | Connection string Neon — **wajib**; driver berbicara lewat endpoint HTTP Neon |
| `TEST_DATABASE_URL` | — | Database khusus `npm run test:auth`; uji **mengosongkan** seluruh tabelnya |
| `SEED_PASSWORD` | `Auditor#2026` | Kata sandi awal akun staf, dibaca saat `npm run db:setup` |
| `COOKIE_SECURE` | *(auto)* | Paksa/matikan atribut `Secure`; kosong = deteksi dari `X-Forwarded-Proto` |

---

## 11. Verifikasi

### Uji otomatis — `npm run test:auth`

`scripts/test_auth.js` menjalankan **43 pemeriksaan** terhadap server sungguhan (port 3116-3118):
atribut cookie di empat skenario protokol, gerbang sesi, kontrol peran, pendaftaran, administrasi
akun, ganti kata sandi, throttle login, aset statis, dan kebersihan layar masuk dari struktur peran.

Dua sifat yang membuatnya aman dijalankan kapan saja:

- Berjalan di atas **database terpisah** lewat `TEST_DATABASE_URL` (branch Neon khusus uji), dan
  **menolak jalan** bila variabel itu kosong — karena langkah pertamanya mengosongkan semua tabel.
- **Tidak memanggil LLM/Gemini**, jadi tidak butuh API key dan tidak menghabiskan kuota.
  Sesi kuis untuk uji kepemilikan disisipkan langsung ke tabel `quiz_sessions`.

Menambah kasus uji: tulis `check('nama', kondisi)` di dalam blok yang relevan — helper `req()`
mengembalikan `{status, data, setCookie}` dan proses keluar dengan kode 1 bila ada yang gagal.

> Batas yang perlu diingat: uji berbasis `fetch` **tidak** menegakkan atribut cookie. Regresi
> `Secure` hanya terlihat di browser sungguhan, jadi sekali-sekali login manual di
> `http://localhost` tetap perlu.

### Verifikasi manual (bagian yang belum terotomasi)

- **Modul terisolasi**: `node -e "require('./lib/vec') …"` untuk roundtrip add/search/delete.
- **PDF**: hasilkan PDF Flate via `zlib.deflateSync` lalu cek `pdf.extractText`.
- **API**: `curl` endpoint (lihat contoh di README & §3 di atas).
- **E2E UI**: jalankan server, buka browser, daftar akun peserta baru dan masuk sebagai
  akun staf untuk memeriksa gating menu per peran.
- **Auth**: sudah tercakup `npm run test:auth`; untuk pemeriksaan cepat manual pakai
  `curl -c sid.txt -X POST /api/auth/login …` lalu `curl -b sid.txt …`.

Saran ke depan: perluas pola `scripts/test_auth.js` ke `pdf.js`, parser hierarki hukum `vec.js`
(`parseHierarchyChunks`, deterministik tanpa jaringan), dan rekonsiliasi dimensi `vec.js`.
Tes embedder Gemini perlu key/jaringan, jadi cocok di-mock atau ditandai opsional.

---

## 12. Ide Pengembangan Lanjutan

- **OCR** untuk PDF hasil scan (mis. integrasi Tesseract opsional) agar importer lebih luas.
- **Penguatan auth**: reset kata sandi lewat email, verifikasi domain email perusahaan, 2FA,
  dan audit log percobaan login. (Atribut cookie `Secure` sudah otomatis mengikuti protokol —
  lihat `isSecureRequest()` di `lib/auth.js`.)
- **Index vektor** (`halfvec(3072)` + HNSW) begitu korpus RAG tumbuh melewati beberapa ribu chunk.
- **Hybrid retrieval** (gabung skor leksikal + semantik) dan **reranking**.
- **Chunking lebih cerdas** (sadar heading/section) & dedup lintas-dokumen.
- **Streaming** jawaban LLM ke UI (gateway Makers mendukung SSE); **caching** embedding query.
- **Test otomatis** + CI (lint, build Docker, smoke test).
