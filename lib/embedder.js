'use strict';
/**
 * Text embedder untuk RAG — Gemini-only.
 *
 * Backend: Google Gemini API (gemini-embedding-001, 3072-dim).
 * Membutuhkan GEMINI_API_KEY (via .env atau Settings UI). Tidak ada fallback
 * lokal/leksikal — bila key tidak tersedia atau API gagal, embedding tidak aktif.
 *
 * Env:
 *   GEMINI_API_KEY        — kunci Google AI (wajib).
 *   GEMINI_EMBED_MODEL    — default: gemini-embedding-001.
 *
 * Skrip ingest hukum (scripts/ingest_legal_pdf.py) memakai model & dimensi yang
 * sama sehingga baris yang ditulisnya langsung dibaca oleh lib/vec.js.
 */

// ---------------------------------------------------------------------------
// Backend Gemini (gemini-embedding-001, 3072-dim, Google AI API)
// ---------------------------------------------------------------------------
async function geminiEmbedRaw(apiKey, model, text, taskType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text: String(text) }] },
      taskType,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) { const e = await r.text(); throw new Error(`Gemini ${r.status}: ${e.slice(0, 200)}`); }
  const j = await r.json();
  if (!Array.isArray(j.embedding?.values)) throw new Error('Gemini: respons tanpa embedding.values');
  return j.embedding.values;
}

async function tryGemini(apiKey) {
  const model = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
  const name = `gemini:${model}`;
  // Avoid a live probe call when the dimension is already cached in embed_meta —
  // this saves a quota-burning API call on every server restart.
  let dim;
  try {
    const cached = getDbSetting('embed_meta');
    const meta = cached ? JSON.parse(cached) : null;
    dim = (meta && meta.name === name) ? meta.dim : null;
  } catch (_) { dim = null; }
  if (!dim) {
    const probe = await geminiEmbedRaw(apiKey, model, 'a', 'RETRIEVAL_DOCUMENT');
    dim = probe.length;
  }
  return {
    name,
    dim,
    kind: 'model',
    embed: async (text, role) => {
      const taskType = role === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
      return Float32Array.from(await geminiEmbedRaw(apiKey, model, text, taskType));
    },
  };
}

// ---------------------------------------------------------------------------
// DB settings helper (lazy require to avoid circular deps at module load)
// ---------------------------------------------------------------------------
function getDbSetting(key) {
  try {
    const { db } = require('./db');
    const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return r ? r.value : null;
  } catch (_) { return null; }
}
function setDbSetting(key, value) {
  try {
    const { db } = require('./db');
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Resolusi backend (memoized)
// ---------------------------------------------------------------------------
let resolved = null;
let resolving = null;

function init() {
  if (resolved) return Promise.resolve(resolved);
  if (resolving) return resolving;
  resolving = (async () => {
    // DB settings (set via Settings UI) override env vars.
    const geminiKey   = getDbSetting('embed_gemini_key') || process.env.GEMINI_API_KEY;
    const dbGeminiModel = getDbSetting('embed_gemini_model');
    if (dbGeminiModel) process.env.GEMINI_EMBED_MODEL = dbGeminiModel;

    if (!geminiKey) {
      throw new Error('GEMINI_API_KEY tidak disetel. Tambahkan ke .env atau konfigurasi via Settings UI.');
    }
    return (resolved = await tryGemini(geminiKey));
  })();
  return resolving;
}

/** Reset memoization and re-init with new Gemini settings saved to DB. */
async function reconfigure({ geminiKey, geminiModel } = {}) {
  setDbSetting('embed_backend', 'gemini');
  if (geminiKey !== undefined) setDbSetting('embed_gemini_key', geminiKey);
  if (geminiModel)             setDbSetting('embed_gemini_model', geminiModel);
  resolved = null;
  resolving = null;
  return init();
}

function active() { return resolved; }

module.exports = { init, active, reconfigure };
