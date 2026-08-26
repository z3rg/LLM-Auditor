# Dokumentasi Proyek — LLM Auditor

> Aplikasi analitik hasil kuis **IT Auditor** lintas-divisi, ditenagai **model bawaan EdgeOne Makers** (LLM) dan
> **Google Gemini** (embedding RAG). Dokumen ini merangkum tujuan, arsitektur, alur kerja
> **ReAct Agent**, cuplikan kode penting, hasil analisis, dan insight.
>
> Dokumen pendukung: [README.md](README.md) (cara pakai & deploy) · [DEVELOPER.md](DEVELOPER.md)
> (panduan pengembangan).

---

## 1. Tujuan Proyek dan Dataset

### 1.1 Tujuan

Mengubah **data hasil kuis IT Audit** menjadi keputusan yang dapat ditindaklanjuti, dengan
bantuan LLM, melalui beberapa fitur inti:

| Tujuan | Bagaimana dicapai |
|--------|-------------------|
| **Deteksi gap pengetahuan** per karyawan / divisi / topik | Logika gap (rata-rata skor `< 70`) dibakukan ke dalam **VIEW SQLite** (`v_employee_topic`, `v_division_topic`, dst.) agar konsisten |
| **Rekomendasi perbaikan berbasis AI** | LLM menyusun analisis + rekomendasi + prioritas + penilaian risiko |
| **SQL Agent bahasa-natural** | Pertanyaan natural → query `SELECT` read-only (divalidasi + auto-repair) → tabel hasil |
| **Kuis perbaikan yang _grounded_** | Agen **ReAct + RAG** menyusun soal yang berbasis materi regulasi (PDF) — **fokus dokumen ini** |
| **Alur persetujuan** | Super Admin / Auditor → kirim rekomendasi → **Direktur** acknowledge |

Prinsip teknis: **zero-dependency** pada inti aplikasi (hanya modul bawaan Node:
`node:http`, `node:crypto`, `node:zlib`, `fetch`). Layanan eksternal (AI Gateway Makers, Gemini) dipanggil
langsung via `fetch` tanpa SDK.

### 1.2 Dataset

Proyek memakai **dua sumber data** yang berbeda peran.

#### a. Data kuis IT Audit (analitik) — deterministik

Dihasilkan oleh seeder deterministik (`lib/db.js`), sehingga hasil selalu sama dan gap dirancang
realistis per divisi. Snapshot aktual basis data:

| Entitas | Jumlah |
|---------|--------|
| Karyawan (termasuk akun Super Admin / Direktur / Lead Auditor) | **35** + akun yang mendaftar mandiri |
| Divisi | **8** (Finance, IT, HR, Operations, Marketing, Legal & Compliance, Internal Audit, Procurement) |
| Topik audit IT | **10** (Access Control & IAM, Network Security, Data Privacy, Incident Response, Change Management, BC & DRP, ISO 27001, IT Risk Management, Application Controls, Audit Logging) |
| Hasil kuis (`quiz_attempts`) | **391** |
| Rentang waktu | **2025-12-03 → 2026-06-11** (~6 bulan) |
| Rata-rata skor global | **76,6 / 100** · **Ambang gap = `< 70`** |

#### b. Basis pengetahuan RAG (regulasi) — untuk grounding kuis

Tiga dokumen **POJK (Peraturan OJK)** tentang Teknologi Informasi & sistem elektronik perbankan,
diimpor lalu di-_embed_ dengan **Gemini `gemini-embedding-001` (3072 dimensi)** dan disimpan ke
**Postgres + `pgvector`**:

| Dokumen | Halaman | Chunk tersimpan |
|---------|---------|-----------------|
| `POJK 11 - 03 - 2022.pdf` | 76 | 353 |
| `pojk 13-2020.pdf` | 13 | 34 |
| `pojk 4-2021.pdf` | 66 | 65* |
| **Total** | — | **452 chunk** (dim 3072, backend `gemini:gemini-embedding-001`) |

> *`pojk 4-2021` **terimpor sebagian — 65 dari 272 chunk** yang direncanakan (`num_chunks=272`
> tetapi baris `pdf_chunks` hanya 65). Impor lewat UI kemungkinan terhenti oleh **rate limit
> Gemini free-tier (~100 embed/menit)** — lihat insight §4.1. Chunking memakai **parser hierarki
> hukum** (BAB → Pasal → Seksi → Poin → Sub-poin) dengan _breadcrumb_ konteks pada tiap potongan.

---

## 2. Arsitektur dan Alur Kerja ReAct Agent

### 2.1 Arsitektur sistem

```
Browser (public/) ──/api/*──> lib/api.js
   (static hosting)             (server.js lokal / Cloud Function EdgeOne)
                                  ├──> lib/auth.js ──> sesi (cookie HttpOnly) + peran
                                  ├──> lib/db.js   ──> Postgres (Neon) + VIEW analitik
                                  ├──> lib/ai.js   ──fetch──> AI Gateway Makers (deepseek-v4-flash)
                                  └──> lib/vec.js  ──> pgvector (cosine <=>)
                                            └──> lib/embedder.js ──fetch──> Gemini API (embedding)
```

| Berkas | Peran |
|--------|-------|
| `lib/api.js` | Router API + gerbang sesi/peran; dipakai server dev lokal maupun Cloud Function |
| `cloud-functions/api/[[default]].js` | Entri produksi EdgeOne Makers: adapter Fetch → req/res Node |
| `lib/auth.js` | Autentikasi: hash scrypt, sesi + cookie HttpOnly, throttle login, bootstrap akun staf |
| `lib/db.js` | Akses data Postgres (async), seed deterministik, VIEW analitik gap, akun & `sessions` |
| `lib/ai.js` | Wrapper Chat Completions OpenAI-compatible + fitur AI + **agen ReAct penyusun kuis** |
| `lib/vec.js` | RAG store: chunking (parser hukum), pencarian `pgvector` (cosine) |
| `lib/embedder.js` | Embedder **Gemini-only** (3072-dim) via `fetch` |
| `lib/pdf.js` | Ekstraktor teks PDF tanpa dependency (FlateDecode) |
| Postgres (Neon) | Basis data (kuis + basis pengetahuan RAG); `data/auditor.db` kini hanya sumber migrasi |

### 2.2 Autentikasi dan kontrol akses

Akses ke aplikasi memakai **akun sungguhan**, bukan pemilih peran. Alurnya:

```
Daftar / Masuk ──> lib/auth.js ──> scrypt verify ──> token sesi acak 32 byte
                                                          │
                                   sessions(token_hash)  <┘  (SHA-256, kedaluwarsa 7 hari)
                                                          │
Setiap /api/* ──> auth.currentUser(req) ──> akun + peran ─┘ ──> 401 tanpa sesi, 403 bila peran tak sesuai
```

Poin desain yang relevan untuk audit:

- **Kata sandi tidak pernah disimpan apa adanya** — hash `scrypt` (`node:crypto`) dengan salt acak
  per akun dan perbandingan *timing-safe*. Token sesi pun disimpan **ter-hash**, sehingga isi tabel
  `sessions` tidak cukup untuk membajak sesi. Atribut `Secure` dipasang otomatis begitu request
  datang lewat HTTPS, dan sengaja dilepas di `http://localhost` agar login pengembangan tidak mati.
- **Peran dibaca dari sesi di sisi server**, bukan dari input klien. Versi sebelumnya memakai header
  `x-role` yang bisa dipalsukan siapa pun dengan satu perintah `curl`.
- **Identitas peserta tidak bisa disamarkan**: `employee_id` untuk pembuatan kuis diambil dari sesi,
  dan `POST /api/quiz/submit` memverifikasi kepemilikan sesi kuis. Ini menjaga integritas
  `quiz_attempts` — skor hanya bisa ditulis atas nama diri sendiri, yang penting karena angka itulah
  yang memberi makan seluruh VIEW analitik gap.
- **Pendaftaran mandiri hanya menghasilkan peran `employee`** (Peserta Audit); kenaikan peran
  dilakukan Super Admin, dan menonaktifkan akun langsung mencabut seluruh sesinya.
- Layar Masuk **tidak menampilkan struktur peran** sistem; login dibatasi 8 percobaan gagal per
  email setiap 10 menit.

### 2.3 Apa itu ReAct di sini?

**ReAct = Reasoning + Acting.** Alih-alih meminta LLM langsung "buat 10 soal", agen ini
**menalar** materi apa yang dibutuhkan, lalu **bertindak** memanggil _tool_ `search_knowledge`
(pencarian `pgvector`) untuk menarik materi nyata dari PDF regulasi, baru menyusun soal yang
_grounded_ pada materi tersebut. Setiap langkah penalaran (Thought / Action / Observation)
direkam ke **trace** dan ditampilkan di UI agar transparan.

Implementasi ini memakai **grounding per-soal**: setiap soal punya retrieval-nya sendiri,
sehingga RAG memengaruhi **tiap** soal — bukan satu pencarian untuk seluruh kuis.

### 2.4 Alur kerja (per-soal)

```
                 ┌─────────────────────────── generateQuizReActPerQuestion() ──────────────────────────┐
                 │                                                                                      │
  /api/quiz/     │  1. PLAN (ReAct reasoning)                                                           │
  generate  ───► │     planQuizSubtopics(topic, area, n)  ──fetch──► LLM                                │
                 │       └─► n sub-konsep berbeda + 1 query pencarian per sub-konsep                    │
                 │                                                                                      │
                 │  2. ACT — retrieval PER SOAL (loop n kali)                                           │
                 │     untuk tiap sub-konsep:  vec.search(query) ──► pgvector (cosine <=>)             │
                 │       └─► grounded = (similarity_top ≥ GROUND_MIN 0.63) ? true : false (blend+tandai)│
                 │                                                                                      │
                 │  3. GENERATE (grounded, terfokus)                                                    │
                 │     groundedGeneratePerQuestion(items) ──fetch──► LLM                                │
                 │       └─► tepat 1 soal per "blok materi"; field `block` memetakan soal↔sumber        │
                 │                                                                                      │
                 │  4. ASSEMBLE → { questions[], trace, sources, groundedCount }                        │
                 └──────────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
        Tiap soal membawa: grounded · source (judul PDF) · similarity · excerpt (kutipan)
        UI: badge 📚 sumber / 💡 pengetahuan umum + expander "🔎 Lihat kutipan sumber"
```

Inti desain — **pemisahan tanggung jawab** agar output andal:
1. **Reasoning/Planning** (apa yang harus dicari) dipisah dari
2. **Retrieval** (mengambil materi dari `pgvector`) dan
3. **Generation final** (menyusun JSON soal) — menghindari JSON soal terpotong di tengah loop.

**Blend + tandai:** bila sebuah sub-konsep tidak menemukan materi di atas ambang
(`similarity < GROUND_MIN`), soal tetap dibuat dari pengetahuan umum IT-audit, namun **ditandai**
`grounded:false` agar transparan (tidak diam-diam "pure LLM").

---

## 3. Cuplikan Kode Penting dan Hasil Analisis

### 3.1 Cuplikan kode

#### (a) Embedding via Gemini — `lib/embedder.js`

AI Gateway Makers hanya melayani chat completion, jadi vektor dihitung lewat Gemini. `taskType` dibedakan
untuk dokumen vs query agar retrieval optimal:

```js
async function tryGemini(apiKey) {
  const model = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
  // ... dimensi di-cache di embed_meta agar tidak boros panggilan probe saat restart ...
  return {
    name: `gemini:${model}`, dim, kind: 'model',
    embed: async (text, role) => {
      const taskType = role === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
      return Float32Array.from(await geminiEmbedRaw(apiKey, model, text, taskType));
    },
  };
}
```

#### (b) Pencarian RAG — `lib/vec.js`

Vektor di-L2-normalize sehingga **similarity = 1 − jarak cosine** pgvector:

```js
async function search(query, k = 5) {
  const be = await ready();
  const qv = toVector(await be.embed(query, 'query'));
  const rows = await pg.many(`
    SELECT c.id, c.content, d.title AS source,
           (c.embedding <=> $1::vector) AS distance
    FROM pdf_chunks c
    JOIN pdf_documents d ON d.id = c.doc_id
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $1::vector
    LIMIT $2
  `, [qv, k]);
  return rows.map((r) => ({ id: r.id, content: r.content, source: r.source,
                            similarity: round2(1 - Number(r.distance)) }));
}
```

#### (c) ReAct — langkah PLAN — `lib/groq.js`

```js
// Ambang similarity agar sebuah soal dianggap benar-benar "grounded" oleh RAG.
// Embedding Gemini memampatkan similarity ke pita sempit & tinggi → ambang harus DI ATAS
// lantai-noise (~0.60), bukan 0.5. Bisa disetel via env QUIZ_GROUND_MIN.
const GROUND_MIN = Number(process.env.QUIZ_GROUND_MIN) || 0.63;

async function planQuizSubtopics(topic, area, n, hasKB) {
  // LLM menalar n sub-konsep BERBEDA + satu query pencarian per sub-konsep.
  // Output JSON: {"thought":"...","subtopics":[{"subconcept":"...","query":"..."}]}
}
```

#### (d) ReAct — orkestrasi retrieval per-soal — `lib/groq.js`

```js
// 2) Per-question retrieval — one search_knowledge call per sub-concept.
for (const s of subs) {
  const results = useKB ? await safeSearch(search, s.query) : [];
  const top = results[0] || null;
  const grounded = !!(top && top.similarity >= GROUND_MIN);
  const strong   = results.filter((r) => r.similarity >= GROUND_MIN);
  const ctx      = strong.length ? strong : (results.length ? results.slice(0, 1) : []);
  items.push({ subconcept: s.subconcept, query: s.query, context: ctx,
               grounded, source: grounded ? top.source : null,
               similarity: top ? top.similarity : null });
  // ... trace.push({ action: 'search_knowledge', observation: `top: ${top.source} (skor ...)` }) ...
}

// 3) Grounded generation — tepat 1 soal per blok; field `block` memetakan soal↔sumber.
const gen = await groundedGeneratePerQuestion(topic, area, items);
const questions = gen.questions.map((q, i) => {
  const bi = (q.block >= 1 && q.block <= items.length) ? q.block - 1 : i;
  const it = items[bi] || {};
  const topChunk = (it.context && it.context[0]) || null;
  return { ...q, grounded: !!it.grounded, source: it.grounded ? it.source : null,
           similarity: it.similarity ?? null,
           excerpt: (it.grounded && topChunk) ? String(topChunk.content).slice(0, 800) : null };
});
```

#### (e) Penyatuan di server — `server.js` (`POST /api/quiz/generate`)

```js
const ragOn = useRag && hasKB;
const gen = await ai.generateQuizReActPerQuestion(topic.name, topic.area, 12, {
  search: ragOn ? (q) => vec.search(q, 4) : null,  // tool search_knowledge
  hasKB: ragOn,
});
const groundedCount = questions.filter((q) => q.grounded).length;
// Jawaban benar di-strip; grounded/source/excerpt dikirim ke UI untuk badge & expander.
```

### 3.2 Hasil analisis — A. Kalibrasi & perilaku ReAct Agent

**Kalibrasi ambang grounding.** Diuji dua query ke basis pengetahuan POJK:

| Query | Similarity top | Interpretasi |
|-------|----------------|--------------|
| _"resep rendang dan teknik memasak daging sapi"_ (OFF-topic) | **0,60** | lantai-noise embedding |
| _"kontrol akses pengguna dan manajemen hak akses"_ (ON-topic) | **0,67–0,68** | relevan |

➡️ Embedding Gemini **memampatkan** similarity ke pita sempit (≈0,60–0,70). Maka ambang
`GROUND_MIN = 0,63` dipilih **di atas lantai-noise** — kalau dipakai 0,5, _semua_ query lolos
dan tanda "pengetahuan umum" tak pernah muncul (fitur jadi tidak berfungsi).

**Hasil generate kuis (3 topik diuji).** Setiap kuis: trace **14 langkah** =
`plan_subtopics → 12× search_knowledge → final_answer`, lalu dipangkas ke 10 soal:

| Topik | groundedCount | Sumber yang dipakai |
|-------|---------------|---------------------|
| Access Control & IAM | **10 / 10** | pojk 4-2021, POJK 11-03-2022, pojk 13-2020 |
| Network Security | **10 / 10** | POJK 11-03-2022, pojk 4-2021, pojk 13-2020 |
| Data Privacy & Protection | **10 / 10** | POJK 11-03-2022 (skor top 0,70–0,77) |

➡️ Basis pengetahuan POJK ternyata **menutupi seluruh 10 topik IT-audit** dengan baik, sehingga
hampir semua soal ter-_grounding_. Tiap soal menampilkan **kutipan sumber** beserta breadcrumb
hukum, mis. `[Pasal 3 > b. kecukupan kebijakan dan prosedur penggunaan]`.

### 3.3 Hasil analisis — B. Analitik gap (dataset kuis)

**Rata-rata skor per divisi** (diurut menaik; ambang gap `< 70`):

| Divisi | Avg | Status |
|--------|-----|--------|
| **Operations** | **69,5** | 🔴 **gap** (di bawah ambang) |
| IT | 71,2 | dekat ambang |
| Procurement | 73,5 | |
| Marketing | 77,6 | |
| Human Resources | 78,3 | |
| Internal Audit | 80,6 | |
| Legal & Compliance | 81,2 | |
| Finance | 81,4 | terkuat |

**Jumlah gap pada level divisi × topik** (`is_gap = 1`): Operations **3**, divisi lain **2** masing-masing.

**Karyawan dengan gap terbanyak** (`v_employee_score.gap_topics`):

| Karyawan | Divisi | Topik ber-gap |
|----------|--------|---------------|
| Joko Susilo | IT | **9** |
| Hesti Rahmawati | Procurement | 7 |
| Lukman Hakim | Operations | 6 |
| Putri Maharani | Procurement | 6 |
| Oscar Tanuwijaya | Internal Audit | 5 |

**Catatan penting:** pada level **topik global**, **tidak ada** topik yang berstatus gap
(skor 72,8–80,0). Topik terlemah _Incident Response_ (72,8) pun masih di atas 70. Ini **benar**
secara metodologis — divisi kuat (Finance/Legal) **menutupi** divisi lemah saat diagregasi
global; gap baru terlihat pada granularitas **divisi×topik** dan **karyawan×topik**.

---

## 4. Kesimpulan serta Insight

### 4.1 Insight teknis (ReAct + RAG)

1. **Grounding per-soal mengalahkan grounding pooled.** Dengan satu retrieval per sub-konsep,
   RAG memengaruhi **setiap** soal dan tiap soal bisa diberi atribusi sumber — bukan satu
   pencarian untuk 10 soal sekaligus.
2. **Kalibrasi ambang itu wajib, bukan opsional.** Karena Gemini memampatkan similarity ke pita
   ~0,60–0,70, ambang naif (0,5) membuat penanda grounding _selalu_ true. Memasang `GROUND_MIN`
   tepat di atas lantai-noise (0,63, dapat disetel via `QUIZ_GROUND_MIN`) membuat tanda
   "pengetahuan umum" bermakna.
3. **Pemisahan Plan → Act → Generate menaikkan keandalan.** Generation final yang terfokus
   (1 soal/blok) menghindari JSON terpotong dan menjaga pemetaan soal↔sumber via field `block`.
4. **Transparansi ReAct.** Trace Thought/Action/Observation + kutipan sumber per-soal membuat
   keluaran LLM **dapat diaudit** — selaras dengan konteks proyek (IT Audit).
5. **Arsitektur ramping.** Dua dependency runtime + `pgvector` + Gemini via `fetch`: tanpa ORM,
   bundler, atau model lokal — berjalan serverless di EdgeOne Makers, dan tetap bisa dikemas
   sebagai kontainer (lihat folder `docker/`).
6. **Robustness ingesti vs rate limit.** Bukti nyata: `pojk 4-2021` hanya tersimpan **65 dari 272**
   chunk karena batas **Gemini free-tier (~100 embed/menit)**. `addDocument()` menyisipkan chunk
   satu-per-satu tanpa transaksi atomik, sehingga error di tengah meninggalkan dokumen separuh
   ter-_embed_ + `num_chunks` stale. **Kandidat perbaikan:** pacing/backoff saat impor, transaksi
   atau penanda status impor, dan rekonsiliasi `num_chunks` vs jumlah baris aktual.

### 4.2 Insight domain (analitik audit)

1. **Operations** adalah satu-satunya divisi yang **secara keseluruhan** masuk wilayah gap
   (69,5 < 70) dan punya gap divisi×topik terbanyak (3) — prioritas intervensi tertinggi.
2. **IT** (71,2) berada tepat di atas ambang namun memuat individu paling berisiko
   (Joko Susilo, 9 topik ber-gap) — sinyal bahwa **rata-rata divisi bisa menyembunyikan
   risiko individual**.
3. **Gap bersifat granular.** Tidak adanya gap di level topik global menegaskan pentingnya
   memakai **VIEW analitik** (divisi×topik, karyawan×topik) ketimbang rata-rata global —
   inilah alasan SQL Agent diwajibkan memakai view tersebut.
4. **Kecukupan basis pengetahuan.** KB POJK ternyata cukup luas untuk meng-_grounding_ seluruh
   10 topik IT-audit; tanda "pengetahuan umum" akan muncul hanya bila sebuah sub-konsep benar-benar
   tak tercakup regulasi.

### 4.3 Kesimpulan

LLM Auditor menunjukkan bahwa **agen ReAct + RAG per-soal** dapat menghasilkan kuis IT-audit yang
**grounded, dapat diaudit, dan terkalibrasi** di atas basis pengetahuan regulasi (POJK), sembari
mempertahankan arsitektur **zero-dependency** yang mudah dipelihara. Di sisi analitik, pembakuan
logika gap ke dalam VIEW SQLite memberi dasar yang konsisten untuk rekomendasi AI dan SQL Agent.

### 4.4 Pengembangan lanjutan

- **Hybrid retrieval** (gabung leksikal + semantik) & **reranking** untuk memperhalus pita
  similarity Gemini yang sempit.
- **Ambang grounding adaptif** per-query (mis. margin terhadap lantai-noise) alih-alih ambang tetap.
- **OCR** untuk PDF hasil scan agar cakupan KB lebih luas.
- **Penguatan autentikasi**: reset kata sandi via email, verifikasi domain email perusahaan, 2FA,
  dan audit log percobaan login. (Autentikasi dasar — registrasi, sesi, kontrol peran sisi server,
  serta atribut cookie `Secure` yang mengikuti protokol — sudah diterapkan; lihat §2.2.)
