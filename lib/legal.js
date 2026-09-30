'use strict';
/**
 * Dokumen legal (POJK, kebijakan internal, dsb.) sebagai dasar penyusunan soal.
 *
 * Kenapa bukan embedding neural: AI Gateway Makers TIDAK punya endpoint
 * embeddings (`/v1/embeddings` dijawab "Invalid request path" — diuji
 * 2026-09-30), dan Blob tidak punya pencarian vektor. Maka "embedding" di sini
 * adalah vektor leksikal BM25 yang dihitung di proses sendiri, lalu DIPERKAYA
 * DeepSeek: tiap potongan diberi kata kunci Indonesia/Inggris dan dipetakan ke
 * topik kuis. Pengayaan itulah yang menjembatani nama topik berbahasa Inggris
 * ("Access Control & IAM") dengan teks POJK berbahasa Indonesia — tanpa itu
 * BM25 murni nyaris tidak menemukan apa pun.
 *
 * PDF dibaca di BROWSER (pdf.js), bukan di sini: server hanya menerima teks
 * per halaman. Dengan begitu tidak ada pustaka PDF yang harus lolos bundler
 * agent EdgeOne, dan batas ukuran body cukup untuk teks, bukan biner.
 *
 * Tata kunci (satu entitas = satu kunci, lihat lib/blob.js):
 *   legal-docs/<id>.json     metadata dokumen
 *   legal-chunks/<id>.json   [{i, page, pasal, text, tf, len, keywords, topics, enriched}]
 * Potongan satu dokumen disimpan dalam SATU blob, dan hanya ditulis oleh
 * langkah pengayaan dokumen itu — yang dijalankan berurutan oleh satu klien.
 */
const blob = require('./blob');

const K = {
  doc: (id) => `legal-docs/${id}.json`,
  chunks: (id) => `legal-chunks/${id}.json`,
};
const P = { docs: 'legal-docs/', chunks: 'legal-chunks/' };

const CHUNK_TARGET = 1100;   // karakter per potongan (≈ satu pasal pendek)
const CHUNK_MAX = 1600;
const MAX_TEXT = 3_000_000;  // batas teks satu dokumen
const ENRICH_BATCH = 4;      // potongan per panggilan DeepSeek — model penalar cepat kehabisan token

// ---------------------------------------------------------------------------
// Tokenisasi
// ---------------------------------------------------------------------------
const STOPWORDS = new Set((
  // Indonesia — kata fungsi + kerangka baku peraturan
  'yang dan di ke dari dalam untuk dengan pada atau ini itu adalah sebagai oleh tersebut dapat ' +
  'tidak akan bagi serta secara atas telah lebih antara setiap paling sedikit huruf ayat pasal ' +
  'angka bab bagian nomor tahun sebagaimana dimaksud cukup jelas penjelasan juga karena maka ' +
  'apabila jika bahwa yaitu ialah suatu para hal tentang terhadap sampai sejak sesuai berlaku ' +
  'mulai tanggal ditetapkan diundangkan salinan sesuai aslinya republik indonesia lembaran negara ' +
  'tambahan otoritas jasa keuangan peraturan pojk seojk ada sudah belum masih namun hanya ' +
  'agar sehingga kepada merupakan melalui tanpa pula lain dimana '
  // Inggris
  + 'the and of to in for with on or is are be by as at an a this that from it its into not'
).split(/\s+/).filter(Boolean));

/**
 * Stemmer ringan Bahasa Indonesia (gaya Nazief-Adriani, disederhanakan).
 * Tidak perlu sempurna — cukup KONSISTEN, karena diterapkan sama pada dokumen
 * dan kueri. "pengamanan" dan "keamanan" sama-sama menjadi "aman".
 */
function stem(w) {
  if (w.length <= 4 || /\d/.test(w)) return w;
  w = w.replace(/(lah|kah|tah|pun)$/, '');
  w = w.replace(/(nya|ku|mu)$/, '');
  if (w.length > 5) w = w.replace(/(kan|an|i)$/, '');
  const m = w.match(/^(meng|meny|mem|men|me|peng|peny|pem|pen|pe|ber|be|ter|di|ke|se)(.+)$/);
  if (m && m[2].length >= 4) w = m[2];
  return w;
}

function tokenize(text) {
  const out = [];
  const words = String(text || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/);
  for (const raw of words) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

function termFreq(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

// ---------------------------------------------------------------------------
// Pemotongan
// ---------------------------------------------------------------------------
const PASAL_RE = /(^|\n)\s*(Pasal\s+\d+[A-Z]?)\s*(?=\n)/g;

function cleanPageText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Pecah teks panjang pada batas kalimat/baris agar tiap potongan ≤ CHUNK_MAX. */
function splitLong(text) {
  if (text.length <= CHUNK_MAX) return [text];
  const out = [];
  let rest = text;
  while (rest.length > CHUNK_MAX) {
    const window = rest.slice(0, CHUNK_MAX);
    let cut = Math.max(window.lastIndexOf('\n', CHUNK_MAX), window.lastIndexOf('. ', CHUNK_MAX));
    if (cut < CHUNK_TARGET * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = CHUNK_MAX;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/**
 * Halaman -> potongan. Batas utama adalah "Pasal N" (satuan makna peraturan);
 * pasal pendek digabung sampai ~CHUNK_TARGET, pasal panjang dipecah.
 * Nomor halaman & pasal pertama tiap potongan disimpan untuk kutipan.
 */
function chunkPages(pages) {
  // Satukan halaman sambil mencatat offset awal tiap halaman.
  let full = '';
  const starts = [];
  for (const p of pages) {
    const text = cleanPageText(p.text);
    if (!text) continue;
    starts.push({ at: full.length, page: Number(p.page) || starts.length + 1 });
    full += text + '\n';
  }
  const pageAt = (offset) => {
    let page = starts.length ? starts[0].page : 1;
    for (const s of starts) { if (s.at <= offset) page = s.page; else break; }
    return page;
  };

  // Bagian PENJELASAN mengulang nomor pasal batang tubuh. Tanpa penanda ini
  // kutipan "Pasal 29" bisa menunjuk ke "Pasal 29 — Cukup jelas".
  const expl = full.search(/\n\s*PENJELASAN\s*\n/);
  const explAt = expl >= 0 ? expl : Infinity;

  // Segmen per pasal (teks sebelum pasal pertama = pembukaan/menimbang).
  const cuts = [0];
  let m;
  PASAL_RE.lastIndex = 0;
  while ((m = PASAL_RE.exec(full))) cuts.push(m.index + m[1].length);
  cuts.push(full.length);
  const segments = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const text = full.slice(cuts[i], cuts[i + 1]).trim();
    if (!text) continue;
    const pasal = (text.match(/^Pasal\s+\d+[A-Z]?/) || [null])[0];
    segments.push({ at: cuts[i], text, pasal });
  }

  // Gabung segmen pendek, pecah yang panjang.
  const chunks = [];
  let buf = null;
  const flush = () => { if (buf && buf.text.trim()) chunks.push(buf); buf = null; };
  for (const seg of segments) {
    for (const [k, part] of splitLong(seg.text).entries()) {
      const offset = seg.at + (k === 0 ? 0 : seg.text.indexOf(part.slice(0, 40)));
      const explanation = seg.at >= explAt;
      // Jangan pernah menggabung batang tubuh dengan PENJELASAN: labelnya
      // akan menjadi rentang palsu seperti "Pasal 2–1".
      if (buf && buf.explanation === explanation && buf.text.length + part.length + 1 <= CHUNK_TARGET) {
        buf.text += '\n' + part;
        if (!buf.pasal && seg.pasal) buf.pasal = seg.pasal;
        buf.pasalTo = seg.pasal || buf.pasalTo;
      } else {
        flush();
        buf = { page: pageAt(Math.max(0, offset)), pasal: seg.pasal, pasalTo: seg.pasal, text: part, explanation };
      }
    }
  }
  flush();

  return chunks
    .filter((c) => tokenize(c.text).length >= 8) // buang potongan yang hanya kop/nomor
    .map((c, i) => {
      const pasal = c.pasal && c.pasalTo && c.pasalTo !== c.pasal
        ? `${c.pasal}–${c.pasalTo.replace(/^Pasal\s+/, '')}` : c.pasal;
      const label = pasal && c.explanation ? `Penjelasan ${pasal}` : pasal;
      return { i, page: c.page, pasal: label || null, text: c.text };
    });
}

function indexChunk(c) {
  const tokens = tokenize(c.text);
  return { ...c, tf: termFreq(tokens), len: tokens.length, keywords: [], topics: [], enriched: false };
}

// ---------------------------------------------------------------------------
// Penyimpanan
// ---------------------------------------------------------------------------
function publicDoc(d) {
  return d && {
    id: d.id, title: d.title, filename: d.filename, pages: d.pages,
    chunkCount: d.chunkCount, enrichedCount: d.enrichedCount || 0,
    uploadedBy: d.uploadedBy, uploadedAt: d.uploadedAt,
  };
}

async function listDocuments() {
  const docs = await blob.cached('legal:docs', () => blob.getAllUnder(P.docs));
  return docs.filter((d) => d && d.id)
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))
    .map(publicDoc);
}

async function getDocument(id) {
  return blob.getJSON(K.doc(Number(id)), null);
}

async function getChunks(id) {
  return blob.getJSON(K.chunks(Number(id)), []);
}

/**
 * Simpan dokumen baru dari teks per halaman.
 * @param {{title:string, filename?:string, pages:{page:number,text:string}[], uploadedBy:string}} input
 */
async function createDocument({ title, filename, pages, uploadedBy }) {
  title = String(title || '').trim().slice(0, 160);
  if (!title) throw new Error('Judul dokumen wajib diisi.');
  if (!Array.isArray(pages) || !pages.length) throw new Error('Dokumen tidak memuat halaman.');
  const total = pages.reduce((n, p) => n + String((p && p.text) || '').length, 0);
  if (total > MAX_TEXT) throw new Error('Teks dokumen terlalu besar.');

  const chunks = chunkPages(pages).map(indexChunk);
  if (!chunks.length) {
    throw new Error('Tidak ada teks yang bisa dibaca. PDF hasil pindaian (gambar) perlu di-OCR lebih dulu.');
  }

  let id = Date.now();
  const doc = {
    id, title, filename: String(filename || '').slice(0, 200),
    pages: pages.length, chunkCount: chunks.length, enrichedCount: 0,
    uploadedBy: uploadedBy || '', uploadedAt: new Date().toISOString(),
  };
  // Potongan ditulis lebih dulu: dokumen baru "ada" begitu metadatanya tertulis.
  for (let attempt = 0; ; attempt++) {
    if (await blob.createJSON(K.chunks(id), chunks)) break;
    if (attempt === 4) throw new Error('Gagal mengalokasikan id dokumen.');
    id += 1;
  }
  doc.id = id;
  await blob.putJSON(K.doc(id), doc);
  blob.invalidate('legal');
  return publicDoc(doc);
}

async function deleteDocument(id) {
  const doc = await getDocument(id);
  if (!doc) return false;
  await blob.del(K.doc(doc.id));
  await blob.del(K.chunks(doc.id));
  blob.invalidate('legal');
  return true;
}

/**
 * Perkaya potongan berikutnya yang belum diproses.
 * @param enrichFn async (chunks, topics) => [{i, keywords[], topics[]}]
 * @returns {{doc, processed:number, remaining:number}}
 */
async function enrichNext(id, topics, enrichFn) {
  const doc = await getDocument(id);
  if (!doc) return null;
  const chunks = await getChunks(doc.id);
  let batch = chunks.filter((c) => !c.enriched).slice(0, ENRICH_BATCH);
  let processed = 0;
  if (batch.length) {
    let result;
    try {
      result = await enrichFn(batch, topics);
    } catch (e) {
      // Terpotong tanpa satu label pun: coba sekali lagi dengan SATU potongan.
      // Tanpa ini kelompok yang sama gagal di setiap klik "Coba lagi".
      if (!e.truncated || batch.length === 1) throw e;
      batch = batch.slice(0, 1);
      result = await enrichFn(batch, topics);
    }
    const { tags, truncated } = Array.isArray(result) ? { tags: result, truncated: false } : result;
    const byI = new Map(tags.map((t) => [t.i, t]));
    const topicIds = new Set(topics.map((t) => t.id));
    for (const c of batch) {
      const t = byI.get(c.i);
      // Jawaban terpotong: hanya potongan yang labelnya utuh yang selesai,
      // sisanya diproses panggilan berikutnya. Jawaban utuh: potongan yang
      // dilewati model tetap ditandai selesai — kalau tidak, satu potongan
      // yang selalu dilewati membuat pengayaan berulang selamanya.
      if (!t && truncated) continue;
      c.keywords = t ? t.keywords.slice(0, 14) : [];
      c.topics = t ? t.topics.filter((x) => topicIds.has(x)) : [];
      c.enriched = true;
      processed += 1;
    }
    await blob.putJSON(K.chunks(doc.id), chunks);
    doc.enrichedCount = chunks.filter((c) => c.enriched).length;
    await blob.putJSON(K.doc(doc.id), doc);
    blob.invalidate('legal');
  }
  return {
    doc: publicDoc(doc),
    processed,
    remaining: chunks.filter((c) => !c.enriched).length,
  };
}

// ---------------------------------------------------------------------------
// Pencarian (BM25 + label topik dari DeepSeek)
// ---------------------------------------------------------------------------
const BM25_K1 = 1.4;
const BM25_B = 0.75;
const KEYWORD_WEIGHT = 2; // kata kunci hasil pengayaan dihitung dua kali
const TAG_BOOST = 6;      // potongan yang DeepSeek petakan ke topik ini
const MIN_SCORE = 6;      // ambang relevansi untuk korpus penuh (≥ MIN_SCORE_N potongan)
const MIN_SCORE_N = 40;   // korpus lebih kecil -> IDF rendah -> ambang ikut turun
const MIN_MATCHED = 2;    // satu kata umum yang kebetulan cocok bukan bukti relevansi

/**
 * Padanan Indonesia untuk topik bawaan. Nama topik berbahasa Inggris, teks
 * POJK berbahasa Indonesia: tanpa jembatan ini potongan yang BELUM diperkaya
 * nyaris tidak pernah cocok.
 */
const TOPIC_TERMS = {
  'Access Control & IAM': 'hak akses pengendalian akses otorisasi autentikasi identitas pengguna kata sandi privilege',
  'Network Security': 'keamanan jaringan firewall enkripsi komunikasi data serangan siber perimeter',
  'Data Privacy & Protection': 'pelindungan data pribadi kerahasiaan nasabah konsumen persetujuan privasi',
  'Incident Response': 'insiden gangguan penanganan pelaporan kejadian siber pemulihan eskalasi',
  'Change Management': 'perubahan pengembangan pengadaan sistem aplikasi pengujian implementasi',
  'Business Continuity & DRP': 'kelangsungan usaha rencana pemulihan bencana pusat pemulihan data center cadangan',
  'ISO 27001 Compliance': 'standar keamanan informasi kepatuhan sertifikasi kebijakan prosedur',
  'IT Risk Management': 'manajemen risiko teknologi informasi identifikasi pengukuran pemantauan pengendalian',
  'Application Controls': 'pengendalian aplikasi validasi input pemrosesan transaksi integritas data',
  'Audit Logging & Monitoring': 'jejak audit log pemantauan audit intern rekam kegiatan pengawasan',
};

/** Seluruh potongan dari semua dokumen, dengan statistik korpus untuk BM25. */
async function corpus() {
  return blob.cached('legal:corpus', async () => {
    const docs = (await blob.getAllUnder(P.docs)).filter((d) => d && d.id);
    const lists = await blob.getManyJSON(docs.map((d) => K.chunks(d.id)));
    const rows = [];
    docs.forEach((d, n) => {
      for (const c of lists[n] || []) {
        const kwTf = termFreq(tokenize((c.keywords || []).join(' ')));
        const tf = { ...c.tf };
        for (const [t, v] of Object.entries(kwTf)) tf[t] = (tf[t] || 0) + v * KEYWORD_WEIGHT;
        const len = c.len + Object.values(kwTf).reduce((a, b) => a + b, 0) * KEYWORD_WEIGHT;
        rows.push({ doc: d, chunk: c, tf, len });
      }
    });
    const df = {};
    for (const r of rows) for (const t of Object.keys(r.tf)) df[t] = (df[t] || 0) + 1;
    const avgLen = rows.length ? rows.reduce((a, r) => a + r.len, 0) / rows.length : 1;
    return { rows, df, avgLen, N: rows.length };
  });
}

function bm25(queryTerms, row, stats, hits) {
  let score = 0;
  for (const t of queryTerms) {
    const f = row.tf[t];
    if (!f) continue;
    if (hits) hits.n += 1;
    const idf = Math.log(1 + (stats.N - stats.df[t] + 0.5) / (stats.df[t] + 0.5));
    score += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * row.len / stats.avgLen));
  }
  return score;
}

function uniq(arr) { return [...new Set(arr)]; }

function toExcerpt(row, score) {
  const c = row.chunk;
  return {
    docId: row.doc.id,
    docTitle: row.doc.title,
    chunk: c.i,
    page: c.page,
    pasal: c.pasal,
    text: c.text,
    score: Math.round(score * 100) / 100,
  };
}

/** Label kutipan yang ringkas, mis. "POJK 11/2022 · hlm. 23 · Pasal 5". */
function citation(x) {
  return [x.docTitle, x.page ? `hlm. ${x.page}` : null, x.pasal].filter(Boolean).join(' · ');
}

/**
 * Potongan yang relevan untuk sebuah topik kuis, terurut dari yang terkuat.
 * Mengembalikan [] bila tidak ada dokumen atau tidak ada yang cukup relevan —
 * penyusun soal lalu kembali ke pengetahuan umum.
 */
async function searchTopic(topic, { limit = 15, extra = '' } = {}) {
  const stats = await corpus();
  if (!stats.N) return [];
  const q = uniq(tokenize(`${topic.name} ${topic.area || ''} ${TOPIC_TERMS[topic.name] || ''} ${extra}`));
  // IDF BM25 bergantung pada ukuran korpus: dengan satu dokumen pendek skor
  // pasal yang jelas relevan pun kecil. Ambang absolut akan menolak semuanya.
  const minScore = MIN_SCORE * Math.min(1, stats.N / MIN_SCORE_N);
  const scored = stats.rows.map((row) => {
    const tagged = (row.chunk.topics || []).includes(topic.id);
    const hits = { n: 0 };
    const s = bm25(q, row, stats, hits) + (tagged ? TAG_BOOST : 0);
    return { row, s, tagged, matched: hits.n };
  }).filter((x) => x.tagged || (x.s >= minScore && x.matched >= MIN_MATCHED))
    .sort((a, b) => b.s - a.s);

  // Jangan biarkan satu dokumen memonopoli: maks 60% kuota per dokumen.
  const perDoc = {};
  const cap = Math.max(3, Math.ceil(limit * 0.6));
  const out = [];
  for (const x of scored) {
    const n = perDoc[x.row.doc.id] || 0;
    if (n >= cap) continue;
    perDoc[x.row.doc.id] = n + 1;
    out.push({ ...toExcerpt(x.row, x.s), row: x.row });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Pilih satu kutipan per sub-konsep dari kumpulan kandidat topik.
 * Tiap kutipan dipakai paling banyak dua kali; sub-konsep yang tidak punya
 * padanan dibiarkan tanpa kutipan (soal dari pengetahuan umum).
 */
async function assignToSubconcepts(pool, subconcepts, topic) {
  if (!pool.length) return subconcepts.map(() => null);
  const stats = await corpus();
  const used = new Map();
  const base = tokenize(`${TOPIC_TERMS[topic.name] || ''}`);
  return subconcepts.map((sub) => {
    const q = uniq(tokenize(sub).concat(base));
    let best = null;
    for (const x of pool) {
      if ((used.get(x) || 0) >= 2) continue;
      const s = bm25(q, x.row, stats) + x.score * 0.15;
      if (!best || s > best.s) best = { x, s };
    }
    if (!best) return null;
    used.set(best.x, (used.get(best.x) || 0) + 1);
    return best.x;
  });
}

/** Buang referensi internal sebelum dikirim ke klien atau disimpan. */
function plainExcerpt(x) {
  if (!x) return null;
  const { row, ...rest } = x;
  return rest;
}

module.exports = {
  ENRICH_BATCH,
  tokenize, stem, chunkPages, citation,
  listDocuments, getDocument, getChunks, createDocument, deleteDocument, enrichNext,
  searchTopic, assignToSubconcepts, plainExcerpt,
};
