# Panduan Developer — LLM Auditor

Dokumen ini untuk **pengembangan lanjutan**. Untuk cara pakai & deploy, lihat
[README.md](README.md).

---

## 1. Filosofi & Stack

- **Backend zero-dependency**: hanya modul bawaan Node
  (`node:http`, `node:sqlite`, `node:zlib`, `node:fs`, global `fetch`). Tidak ada framework
  web, ORM, bundler, **maupun dependency npm runtime** (`package.json` tidak punya `dependencies`).
- **Frontend tanpa build step**: HTML + CSS + satu file `app.js` vanilla. Tidak ada React/Vite.
  Server menyajikan file statis apa adanya.
- **Data lokal**: SQLite (`node:sqlite`) + ekstensi `sqlite-vec` untuk vektor.
- **LLM**: Groq (OpenAI-compatible Chat Completions) via `fetch`.
- **Embedding RAG**: Google **Gemini** (`gemini-embedding-001`, 3072-dim) via `fetch` —
  panggilan jaringan, butuh `GEMINI_API_KEY`. Tidak ada model lokal; tidak ada fallback leksikal.

> Prinsip saat menambah fitur: pertahankan zero-dependency di jalur inti. Layanan eksternal
> (Groq, Gemini) dipanggil langsung via `fetch` tanpa SDK.

---

## 2. Peta Berkas

```
server.js              HTTP server + routing API + static files + warmup RAG
lib/
  auth.js              Autentikasi: hash scrypt, sesi + cookie HttpOnly, throttle login, bootstrap akun staf
  db.js                Skema SQLite, seed deterministik, view analitik gap, app_settings, akun & sessions
  groq.js              Wrapper Groq + fitur AI + generator kuis ReAct
  vec.js               RAG store: chunking (parser hukum + generik), index sqlite-vec (KNN), reindex, fallback cosine
  embedder.js          Embedder Gemini-only (gemini-embedding-001, 3072-dim) via fetch
  pdf.js               Ekstraktor teks PDF (FlateDecode via zlib)
  vendor/vec0.dylib    Ekstensi sqlite-vec (macOS arm64) untuk dev native
scripts/
  ingest_legal_pdf.py  Ingest CLI massal PDF hukum (pypdf + Gemini) -> tabel RAG yang sama (npm run ingest-legal)
public/
  index.html           Markup (layar Masuk/Daftar + semua tab, termasuk Pengaturan & Akun)
  app.js               Semua logika frontend (termasuk alur auth & pengelolaan akun)
  styles.css           Tema dashboard
  auth.css             Tema layar Masuk/Daftar (kertas kerja + register kontrol + stempel)
docker/
  Dockerfile           Image portabel (sqlite-vec; app zero-dependency); RAG via Gemini saat runtime
  docker-compose.yml   Orkestrasi 1-perintah + volume persist (context build = root, ../)
  Dockerfile.dockerignore  Apa yang TIDAK ikut ke image (BuildKit auto-discover by name)
data/
  auditor.db           DB SQLite (auto-dibuat; di-gitignore). Default ./data/auditor.db; override via DB_PATH
.venv/                 Virtualenv Python untuk scripts/ingest_legal_pdf.py (di-gitignore)
```

---

## 3. Setup Dev Lokal

```bash
cp .env.example .env          # isi GROQ_API_KEY + GEMINI_API_KEY (untuk RAG)
node server.js                # atau ./start.sh — tanpa npm install (zero-dependency)
npm run seed                  # reset data dummy
```

Tidak ada langkah build/unduh model: embedding RAG memakai Gemini API saat runtime.

Verifikasi cepat:

```bash
curl localhost:3000/api/config | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).rag))"
```

`rag.embedder` harus `gemini:gemini-embedding-001` (dengan `rag.dim=3072`) saat `GEMINI_API_KEY`
aktif. `rag.vecEnabled=true` berarti `sqlite-vec` termuat.

---

## 4. Alur Data

```
Browser ──/api/*──> server.js ──> lib/db.js (SQLite + view)
                              ├──> lib/groq.js ──fetch──> Groq API
                              └──> lib/vec.js ──> lib/embedder.js ──fetch──> Gemini API
                                            └──> sqlite-vec (KNN)
```

- **Autentikasi**: cookie sesi `sid` (HttpOnly, SameSite=Lax, 7 hari). Token acak 32 byte,
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

## 5. Model Data (SQLite)

Tabel inti: `divisions`, `topics`, `employees`, `quiz_attempts`, `recommendations`,
`quiz_sessions`, `app_settings`, `sessions`. Akun hidup di `employees` (kolom tambahan
`password_hash`, `status`, `created_at` + unique index email `COLLATE NOCASE`) sehingga peserta
yang mendaftar langsung ikut ke seluruh view analitik gap tanpa join tambahan. RAG: `pdf_documents`, `pdf_chunks`, dan virtual table
`vec_pdf_chunks USING vec0(embedding float[DIM])`.

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
Vektor diperlakukan sebagai unit-norm (gemini-embedding-001 @3072-dim) → jarak L2 (default vec0)
≡ peringkat cosine.

`reconfigure({ geminiKey, geminiModel })` menyimpan setting ke DB, mereset memoization, lalu
`init()` ulang; `server.js` (`POST /api/settings/embed`) memanggilnya lalu `vec.resetEmbedder()`
agar index di-reindex bila dimensi berubah.

### 6.2 Vector store (`lib/vec.js`)

- `ready()` (memoized): init embedder lalu **rekonsiliasi index** —
  bila `embed_meta` berbeda (nama/dim) → `reindex()` meng-embed ulang semua chunk dari teks dan
  membuat ulang `vec_pdf_chunks` dengan dimensi baru. Server memanggil `await vec.ready()`
  sebelum `listen`. `reindex()` **memberi jeda** (`sleep(200)` tiap 20 chunk) untuk backend Gemini
  agar tidak menabrak rate limit free-tier.
- **Chunking**: `addDocument({ legalMode })` default `legalMode = true` → `parseHierarchyChunks()`
  (BAB → Pasal → Seksi `A./B.` → Poin `1./2.` → Sub-poin `a./b.`, dengan *breadcrumb* `[crumb]`
  di awal tiap chunk). Bila `legalMode=false`, pakai `chunkText()` paragraf generik. Server
  membaca toggle dari `pdf_legal_mode` (`db.getBool`, default true).
- `addDocument()` / `search()` **async** (menunggu `ready()` + embed Gemini).
- Bila `sqlite-vec` tak termuat → fallback cosine murni-JS atas blob embedding tersimpan.

> **GOTCHA penting**: di `node:sqlite`, `rowid` virtual table vec0 **wajib di-bind sebagai
> `BigInt`** (mis. `insVec.run(BigInt(id), blob)`), jika tidak akan error
> *"Only integers are allowed for primary key values"*.

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
2. **Retrieval per soal** — untuk tiap sub-konsep, `search(query)` (→ `vec.search`, sqlite-vec)
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
> pertahankan vektor unit-norm agar jarak L2 vec0 tetap setara cosine.

### Ingest massal PDF hukum (di luar UI)
`scripts/ingest_legal_pdf.py` (pypdf + `google-genai` + `sqlite-vec`) menulis ke tabel RAG yang
sama dan men-set `embed_meta` ke `gemini:<model>` agar server tidak re-embed saat restart.
Jalankan `npm run ingest-legal -- <file.pdf>` (atau `python3 scripts/ingest_legal_pdf.py <file.pdf>`)
dengan `GEMINI_API_KEY` ter-set. Model, dimensi (3072), aturan parser hierarki, dan `MAX_CHARS`
harus tetap **sinkron** dengan `lib/embedder.js`/`lib/vec.js`.

### Menambah tab UI
Tambah `<a class="nav-item" data-tab="x" data-roles="...">` + `<section id="tab-x">` di
`index.html`, lalu fungsi `loadX()` di `app.js` dan panggil dari handler nav (`data-tab==='x'`).

---

## 9. Docker (internal)

Semua berkas Docker ada di **`docker/`**; **konteks build = root repo**. Jalankan dari root:
`docker build -f docker/Dockerfile -t llm-auditor .` atau
`docker compose -f docker/docker-compose.yml --env-file .env up --build` (atau `npm run docker:up`).

`docker/Dockerfile` multi-stage (basis `node:24-bookworm-slim`):

- **builder**: install alat (`ca-certificates curl tar`) → unduh `vec0.so` Linux sesuai
  `TARGETARCH` (`ARG SQLITE_VEC_VERSION`) → `COPY . .`. **Tidak ada `npm install`** — inti app
  zero-dependency, jadi tak perlu `node_modules`. **Tidak ada** model lokal/ONNX.
- **runtime**: `COPY --from=builder /app /app` → buat `/app/data` + `chown` → user non-root
  `node` → `HEALTHCHECK` ke `/api/config`.

Env runtime kunci: `DB_PATH=/app/data/auditor.db` (volume), `SQLITE_VEC_PATH=/app/lib/vendor/vec0.so`,
`GEMINI_EMBED_MODEL=gemini-embedding-001`. **Rahasia diberikan saat `docker run`/compose**:
`GROQ_API_KEY` (fitur AI) dan `GEMINI_API_KEY` (embedding RAG) — image tidak menyimpannya.

`docker/Dockerfile.dockerignore` (BuildKit otomatis memakai `<dockerfile>.dockerignore`; pola
relatif ke konteks root) **mengecualikan** `node_modules/`, `.venv/`, `lib/vendor/` (dylib macOS),
`data/`, `*.db*`, `.env`, `.cache/`, `*.md`.

`docker/docker-compose.yml`: `name: llm-auditor` (pin nama proyek → volume `llm-auditor_auditor-data`
stabil), `build.context: ..` + `dockerfile: docker/Dockerfile`. Interpolasi `${...}` membaca `.env`
root via flag `--env-file .env`.

> Mengubah versi: `ARG SQLITE_VEC_VERSION` (`docker/Dockerfile`) untuk biner sqlite-vec. Arsitektur
> yang didukung: `linux/amd64`, `linux/arm64`.

---

## 10. Referensi Variabel Lingkungan

| Var | Default | Fungsi |
|-----|---------|--------|
| `GROQ_API_KEY` | — | Key Groq (wajib untuk fitur AI) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Model chat Groq |
| `GEMINI_API_KEY` | — | Key Google Gemini (wajib untuk embedding RAG / impor PDF); bisa juga di-set via Settings UI |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | Model embedding Gemini (3072-dim) |
| `PORT` | `3000` | Port HTTP |
| `DB_PATH` | `./data/auditor.db` | Lokasi file SQLite (override untuk volume; dir dibuat otomatis) |
| `SQLITE_VEC_PATH` | `lib/vendor/vec0.dylib` | Path ekstensi sqlite-vec |

---

## 11. Verifikasi (manual)

Tidak ada test runner. Pola verifikasi yang dipakai selama pengembangan:

- **Modul terisolasi**: `node -e "require('./lib/vec') …"` untuk roundtrip add/search/delete.
- **PDF**: hasilkan PDF Flate via `zlib.deflateSync` lalu cek `pdf.extractText`.
- **API**: `curl` endpoint (lihat contoh di README & §3 di atas).
- **E2E UI**: jalankan server, buka browser, daftar akun peserta baru dan masuk sebagai
  akun staf untuk memeriksa gating menu per peran.
- **Auth**: `curl -c sid.txt -X POST /api/auth/login …` lalu `curl -b sid.txt …`; verifikasi
  `401` tanpa cookie, `403` untuk peran yang salah, dan bahwa `?id=` peserta lain diabaikan.

Saran ke depan: tambahkan smoke test ringan (mis. `node --test`) untuk `pdf.js`, parser hierarki
hukum `vec.js` (`parseHierarchyChunks`, deterministik tanpa jaringan), dan rekonsiliasi dimensi
`vec.js`. Tes embedder Gemini perlu key/jaringan, jadi cocok di-mock atau ditandai opsional.

---

## 12. Ide Pengembangan Lanjutan

- **OCR** untuk PDF hasil scan (mis. integrasi Tesseract opsional) agar importer lebih luas.
- **Penguatan auth**: cookie `Secure` di belakang HTTPS, reset kata sandi lewat email,
  verifikasi domain email perusahaan, 2FA, dan audit log percobaan login.
- **Multi-arch vendor sqlite-vec** ter-bundle untuk dev native lintas-OS (kini hanya macOS arm64).
- **Hybrid retrieval** (gabung skor leksikal + semantik) dan **reranking**.
- **Chunking lebih cerdas** (sadar heading/section) & dedup lintas-dokumen.
- **Streaming** jawaban Groq ke UI; **caching** embedding query.
- **Test otomatis** + CI (lint, build Docker, smoke test).
