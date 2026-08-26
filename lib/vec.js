'use strict';
/**
 * RAG knowledge store untuk LLM Auditor — Postgres + pgvector.
 *
 * - Menyimpan dokumen PDF yang diimpor sebagai potongan teks (chunk) + embedding.
 * - Embedding dihitung oleh `lib/embedder.js`: Gemini (gemini-embedding-001,
 *   3072-dim). Tidak ada fallback lokal — butuh GEMINI_API_KEY.
 * - Pencarian kemiripan memakai operator jarak cosine pgvector (`<=>`), yang
 *   menggantikan sekaligus dua jalur di versi SQLite: KNN vec0 dan fallback
 *   cosine di JS.
 *
 * Vektor dari Gemini sudah L2-normalized, sehingga similarity = 1 - distance.
 */
const pg = require('./pg');
const embedder = require('./embedder');

// ---------------------------------------------------------------------------
// Util vektor
// ---------------------------------------------------------------------------
/** Float32Array → literal pgvector '[0.1,0.2,…]' (dikirim sebagai teks lalu di-cast). */
function toVector(vec) {
  return `[${Array.from(vec).join(',')}]`;
}
function round2(x) { return Math.round(x * 100) / 100; }

/** Dimensi kolom pdf_chunks.embedding saat ini, mis. 3072. */
async function columnDim() {
  const row = await pg.one(`
    SELECT format_type(a.atttypid, a.atttypmod) AS t
    FROM pg_attribute a
    WHERE a.attrelid = 'pdf_chunks'::regclass AND a.attname = 'embedding'
  `);
  const m = row && /vector\((\d+)\)/.exec(row.t);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Inisialisasi backend + rekonsiliasi index (memoized per-proses)
// ---------------------------------------------------------------------------
let readyP = null;
function ready() { return readyP || (readyP = reconcile()); }

async function getMeta() {
  const r = await pg.one("SELECT value FROM app_settings WHERE key = 'embed_meta'");
  try { return r ? JSON.parse(r.value) : null; } catch (_) { return null; }
}
async function setMeta(be) {
  await pg.exec(`
    INSERT INTO app_settings (key, value) VALUES ('embed_meta', $1)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `, [JSON.stringify({ name: be.name, dim: be.dim })]);
}

async function reconcile() {
  const be = await embedder.init();
  const prev = await getMeta();
  if (!prev || prev.name !== be.name || prev.dim !== be.dim) {
    await reindex(be);
    await setMeta(be);
  }
  return be;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Embed ulang seluruh chunk dari teks dengan backend baru (saat dimensi berubah). */
async function reindex(be) {
  const dim = await columnDim();
  if (dim !== be.dim) {
    // Tipe kolom pgvector mengunci dimensi — kosongkan dulu, baru ubah tipe.
    await pg.exec('UPDATE pdf_chunks SET embedding = NULL');
    await pg.exec(`ALTER TABLE pdf_chunks ALTER COLUMN embedding TYPE vector(${be.dim})`);
  }
  const rows = await pg.many('SELECT id, content FROM pdf_chunks');
  if (!rows.length) return;
  const isCloudBackend = be.kind === 'model' && /gemini/.test(be.name);
  for (let i = 0; i < rows.length; i++) {
    const vec = toVector(await be.embed(rows[i].content, 'passage'));
    await pg.exec('UPDATE pdf_chunks SET embedding = $1::vector WHERE id = $2', [vec, rows[i].id]);
    // Jaga jarak agar tidak menabrak rate limit tier gratis Gemini.
    if (isCloudBackend && i % 20 === 19) await sleep(200);
  }
  console.log(`  RAG: ${rows.length} chunk di-embed ulang dengan ${be.name} (dim ${be.dim}).`);
}

// ---------------------------------------------------------------------------
// Chunking: generic paragraph-based
// ---------------------------------------------------------------------------
function chunkText(text, size = 900, overlap = 150) {
  const clean = String(text).replace(/[ \t]+\n/g, '\n').trim();
  const paras = clean.split(/\n{2,}/);
  const chunks = [];
  let buf = '';
  const flush = () => { if (buf.trim().length > 20) chunks.push(buf.trim()); buf = ''; };
  for (const p of paras) {
    if (p.length > size) {
      flush();
      for (let i = 0; i < p.length; i += size - overlap) {
        const piece = p.slice(i, i + size).trim();
        if (piece.length > 20) chunks.push(piece);
      }
      continue;
    }
    if (buf && (buf.length + 2 + p.length) > size) flush();
    buf = buf ? buf + '\n\n' + p : p;
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// Chunking: legal hierarchy (BAB → Pasal → Section → Point → Sub-point)
// Ported from scripts/ingest_legal_pdf.py — produces breadcrumb-prefixed chunks.
// ---------------------------------------------------------------------------
const RE_BAB      = /^\s*BAB\s+[IVXLCDM]+\b/;
const RE_PASAL    = /^\s*Pasal\s+\d+\s*$/;
const RE_SECTION  = /^\s*[A-Z]\.\s+\S/;
const RE_POINT    = /^\s*\d{1,2}\.\s+\S/;
const RE_SUBPOINT = /^\s*[a-z]\.\s+\S/;
const RE_TOC      = /\.{4,}\s*-?\s*\d+\s*-?\s*$/;

function parseHierarchyChunks(text, { maxChars = 3500, minChars = 40 } = {}) {
  const chunks = [];
  let bab = null, section = null, point = null, subpoint = null;
  let bufLines = [];

  const pushChunk = (body) => {
    if (body.length < minChars) return;
    const crumb = [bab, section, point, subpoint].filter(Boolean).join(' > ');
    const full = crumb ? `[${crumb}]\n${body}` : body;
    if (full.length <= maxChars) { chunks.push(full); return; }
    // Split on sentence boundary when oversized.
    const sents = full.split(/(?<=[.;:])\s+/);
    let cur = '';
    for (const s of sents) {
      if (cur && cur.length + s.length + 1 > maxChars) { chunks.push(cur.trim()); cur = s; }
      else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur.trim()) chunks.push(cur.trim());
  };

  const flush = () => { pushChunk(bufLines.join('\n').trim()); bufLines = []; };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim() || RE_TOC.test(line) || line.trim() === 'DAFTAR ISI') continue;

    if (RE_BAB.test(line))     { flush(); bab = line.trim(); section = point = subpoint = null; continue; }
    if (RE_PASAL.test(line))   { flush(); bab = line.trim(); section = point = subpoint = null; continue; }
    if (RE_SECTION.test(line)) { flush(); section = line.trim(); point = subpoint = null; bufLines.push(line.trim()); continue; }
    if (RE_POINT.test(line))   { flush(); point = line.trim(); subpoint = null; bufLines.push(line.trim()); continue; }
    if (RE_SUBPOINT.test(line)){ flush(); subpoint = line.trim(); bufLines.push(line.trim()); continue; }
    bufLines.push(line.trim());
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
/** Impor satu dokumen: chunk → embed (Gemini) → simpan. */
async function addDocument({ filename, title, text, numPages, bytes, legalMode }) {
  const be = await ready();
  const useLegal = legalMode ?? true; // parser hierarki hukum adalah default
  const chunks = useLegal ? parseHierarchyChunks(text) : chunkText(text);
  if (!chunks.length) {
    throw new Error('Tidak ada teks yang dapat dipotong dari PDF (kemungkinan hasil scan/gambar).');
  }
  const now = new Date().toISOString();
  const doc = await pg.one(`
    INSERT INTO pdf_documents (filename, title, num_pages, num_chunks, bytes, chars, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
  `, [filename, title || filename, numPages || null, chunks.length, bytes || null, text.length, now]);

  for (let i = 0; i < chunks.length; i++) {
    const vec = toVector(await be.embed(chunks[i], 'passage'));
    await pg.exec(
      'INSERT INTO pdf_chunks (doc_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4::vector)',
      [doc.id, i, chunks[i], vec]
    );
  }
  return {
    id: doc.id, filename, title: title || filename,
    num_pages: numPages || null, num_chunks: chunks.length, chars: text.length,
  };
}

/** Cari k chunk paling relevan untuk sebuah query. */
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
  // Vektor sudah L2-normalized → cosine similarity = 1 - cosine distance.
  return rows.map((r) => ({
    id: r.id, content: r.content, source: r.source,
    similarity: round2(1 - Number(r.distance)),
  }));
}

async function listDocuments() {
  return pg.many(`
    SELECT id, filename, title, num_pages, num_chunks, chars, bytes, created_at
    FROM pdf_documents ORDER BY created_at DESC
  `);
}

async function deleteDocument(id) {
  // pdf_chunks punya ON DELETE CASCADE, jadi cukup hapus dokumennya.
  const rows = await pg.many('DELETE FROM pdf_documents WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}

async function stats() {
  const be = embedder.active();
  const c = await pg.one(`
    SELECT (SELECT COUNT(*)::int FROM pdf_documents) AS documents,
           (SELECT COUNT(*)::int FROM pdf_chunks)    AS chunks
  `);
  return {
    documents: c.documents,
    chunks: c.chunks,
    dim: be ? be.dim : null,
    backend: 'pgvector (cosine)',
    embedder: be ? be.name : '(loading…)',
    embedderKind: be ? be.kind : null,
  };
}

/** Reset memoization agar ready() berikutnya memakai backend yang baru. */
function resetEmbedder() {
  readyP = null;
  ready().catch((e) => console.error('RAG reindex error:', e.message));
}

module.exports = { ready, addDocument, search, listDocuments, deleteDocument, stats, resetEmbedder };
