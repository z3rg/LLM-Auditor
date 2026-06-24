'use strict';
/**
 * RAG knowledge store untuk LLM Auditor.
 *
 * - Menyimpan dokumen PDF yang diimpor sebagai potongan teks (chunk) + embedding.
 * - Embedding dihitung oleh `lib/embedder.js`: Gemini API (gemini-embedding-001,
 *   3072-dim). Tidak ada fallback lokal — butuh GEMINI_API_KEY.
 * - Pencarian kemiripan memakai ekstensi `sqlite-vec` (vec0, KNN) bila termuat;
 *   bila tidak, fallback ke perhitungan cosine di JS.
 *
 * Vektor di-L2-normalize → peringkat jarak L2 (default vec0) setara cosine:
 * cos = 1 - distance^2 / 2.
 *
 * Dimensi vektor mengikuti backend embedder yang aktif. Bila backend/dimensi
 * berubah dari yang tersimpan, store di-reindex (chunk di-embed ulang dari teks).
 */
const path = require('node:path');
const { db } = require('./db');
const embedder = require('./embedder');

const VEC_PATH = process.env.SQLITE_VEC_PATH || path.join(__dirname, 'vendor', 'vec0.dylib');

// ---------------------------------------------------------------------------
// Skema RAG (tabel dasar; virtual table vec dibuat saat ready() — butuh dimensi)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS pdf_documents (
    id         INTEGER PRIMARY KEY,
    filename   TEXT NOT NULL,
    title      TEXT,
    num_pages  INTEGER,
    num_chunks INTEGER NOT NULL DEFAULT 0,
    bytes      INTEGER,
    chars      INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pdf_chunks (
    id          INTEGER PRIMARY KEY,
    doc_id      INTEGER NOT NULL REFERENCES pdf_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    embedding   BLOB
  );
  CREATE INDEX IF NOT EXISTS idx_pdf_chunks_doc ON pdf_chunks(doc_id);
`);

// ---------------------------------------------------------------------------
// Muat ekstensi sqlite-vec (opsional, dengan fallback JS)
// ---------------------------------------------------------------------------
let vecEnabled = false;
(function loadVec() {
  try {
    db.enableLoadExtension(true);
    db.loadExtension(VEC_PATH);
    vecEnabled = true;
  } catch (e) {
    vecEnabled = false;
    console.warn(`  sqlite-vec tidak dimuat (${String(e.message).split('\n')[0]}). Memakai fallback cosine JS.`);
  } finally {
    try { db.enableLoadExtension(false); } catch (_) {}
  }
})();

// ---------------------------------------------------------------------------
// Util vektor
// ---------------------------------------------------------------------------
function toBlob(vec) { return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength)); }
function fromBlob(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); // salin → offset 0 (aligned)
  return new Float32Array(ab);
}
function dot(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }
function cosFromL2(d) { const c = 1 - (d * d) / 2; return Math.max(-1, Math.min(1, c)); }
function round2(x) { return Math.round(x * 100) / 100; }

// ---------------------------------------------------------------------------
// Inisialisasi backend + rekonsiliasi index (memoized)
// ---------------------------------------------------------------------------
let readyP = null;
function ready() { return readyP || (readyP = reconcile()); }

function vecTableExists() {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vec_pdf_chunks'").get();
}
function getMeta() { try { const r = db.prepare("SELECT value FROM app_settings WHERE key='embed_meta'").get(); return r ? JSON.parse(r.value) : null; } catch (_) { return null; } }
function setMeta(be) {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('embed_meta', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ name: be.name, dim: be.dim }));
}

async function reconcile() {
  const be = await embedder.init();
  const prev = getMeta();
  const changed = !prev || prev.name !== be.name || prev.dim !== be.dim;

  if (changed) {
    await reindex(be);            // (re)buat vtable + embed ulang semua chunk dari teks
    setMeta(be);
  } else if (vecEnabled && !vecTableExists()) {
    // Backend sama, tetapi vtable hilang → bangun ulang dari blob tersimpan (murah).
    db.exec(`CREATE VIRTUAL TABLE vec_pdf_chunks USING vec0(embedding float[${be.dim}])`);
    const ins = db.prepare('INSERT INTO vec_pdf_chunks (rowid, embedding) VALUES (?, ?)');
    for (const r of db.prepare('SELECT id, embedding FROM pdf_chunks WHERE embedding IS NOT NULL').all()) {
      ins.run(BigInt(r.id), r.embedding);
    }
  }
  return be;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Embed ulang seluruh chunk dari teks dengan backend baru (saat dimensi berubah). */
async function reindex(be) {
  if (vecEnabled) {
    db.exec('DROP TABLE IF EXISTS vec_pdf_chunks');
    db.exec(`CREATE VIRTUAL TABLE vec_pdf_chunks USING vec0(embedding float[${be.dim}])`);
  }
  const rows = db.prepare('SELECT id, content FROM pdf_chunks').all();
  if (!rows.length) return;
  const upd = db.prepare('UPDATE pdf_chunks SET embedding = ? WHERE id = ?');
  const insVec = vecEnabled ? db.prepare('INSERT INTO vec_pdf_chunks (rowid, embedding) VALUES (?, ?)') : null;
  // Pace API calls to avoid free-tier rate limits on the Gemini backend.
  const isCloudBackend = be.kind === 'model' && /gemini/.test(be.name);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const blob = toBlob(await be.embed(r.content, 'passage'));
    upd.run(blob, r.id);
    if (insVec) insVec.run(BigInt(r.id), blob);
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
/** Impor satu dokumen: chunk → embed (Gemini) → simpan (+ index vec0). */
async function addDocument({ filename, title, text, numPages, bytes, legalMode }) {
  const be = await ready();
  const useLegal = legalMode ?? true; // parser hierarki hukum adalah default
  const chunks = useLegal ? parseHierarchyChunks(text) : chunkText(text);
  if (!chunks.length) {
    throw new Error('Tidak ada teks yang dapat dipotong dari PDF (kemungkinan hasil scan/gambar).');
  }
  const now = new Date().toISOString();
  const docId = Number(db.prepare(
    'INSERT INTO pdf_documents (filename, title, num_pages, num_chunks, bytes, chars, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(filename, title || filename, numPages || null, chunks.length, bytes || null, text.length, now).lastInsertRowid);

  const insChunk = db.prepare('INSERT INTO pdf_chunks (doc_id, chunk_index, content, embedding) VALUES (?,?,?,?)');
  const insVec = vecEnabled ? db.prepare('INSERT INTO vec_pdf_chunks (rowid, embedding) VALUES (?, ?)') : null;
  for (let i = 0; i < chunks.length; i++) {
    const blob = toBlob(await be.embed(chunks[i], 'passage'));
    const cid = Number(insChunk.run(docId, i, chunks[i], blob).lastInsertRowid);
    if (insVec) insVec.run(BigInt(cid), blob); // vec0: rowid WAJIB integer → BigInt
  }
  return { id: docId, filename, title: title || filename, num_pages: numPages || null, num_chunks: chunks.length, chars: text.length };
}

/** Cari k chunk paling relevan untuk sebuah query. */
async function search(query, k = 5) {
  const be = await ready();
  const qv = await be.embed(query, 'query');
  if (vecEnabled) {
    const rows = db.prepare(`
      WITH knn AS (
        SELECT rowid AS id, distance FROM vec_pdf_chunks
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?
      )
      SELECT c.id, c.content, d.title AS source, knn.distance
      FROM knn JOIN pdf_chunks c ON c.id = knn.id JOIN pdf_documents d ON d.id = c.doc_id
      ORDER BY knn.distance
    `).all(toBlob(qv), k);
    return rows.map((r) => ({ id: r.id, content: r.content, source: r.source, similarity: round2(cosFromL2(r.distance)) }));
  }
  // Fallback JS: cosine atas semua chunk (vektor sudah L2-normalize → cos = dot).
  const all = db.prepare(`
    SELECT c.id, c.content, c.embedding, d.title AS source
    FROM pdf_chunks c JOIN pdf_documents d ON d.id = c.doc_id
  `).all();
  const scored = all.map((r) => ({
    id: r.id, content: r.content, source: r.source,
    similarity: round2(dot(qv, fromBlob(r.embedding))),
  }));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

function listDocuments() {
  return db.prepare(`
    SELECT id, filename, title, num_pages, num_chunks, chars, bytes, created_at
    FROM pdf_documents ORDER BY created_at DESC
  `).all();
}

function deleteDocument(id) {
  if (vecEnabled && vecTableExists()) {
    const ids = db.prepare('SELECT id FROM pdf_chunks WHERE doc_id = ?').all(id);
    const del = db.prepare('DELETE FROM vec_pdf_chunks WHERE rowid = ?');
    for (const row of ids) del.run(BigInt(row.id));
  }
  db.prepare('DELETE FROM pdf_chunks WHERE doc_id = ?').run(id);
  return db.prepare('DELETE FROM pdf_documents WHERE id = ?').run(id).changes > 0;
}

function stats() {
  const be = embedder.active();
  return {
    documents: db.prepare('SELECT COUNT(*) c FROM pdf_documents').get().c,
    chunks: db.prepare('SELECT COUNT(*) c FROM pdf_chunks').get().c,
    dim: be ? be.dim : null,
    vecEnabled,
    backend: vecEnabled ? 'sqlite-vec (vec0)' : 'cosine JS (fallback)',
    embedder: be ? be.name : '(loading…)',
    embedderKind: be ? be.kind : null,
  };
}

/** Reset the reconcile promise so the next ready() call re-runs reconcile with the new backend. */
function resetEmbedder() {
  readyP = null;
  ready().catch((e) => console.error('RAG reindex error:', e.message));
}

module.exports = { ready, addDocument, search, listDocuments, deleteDocument, stats, resetEmbedder };
