'use strict';
/**
 * Koneksi Postgres (Neon) untuk LLM Auditor.
 *
 * Memakai driver HTTP `@neondatabase/serverless`, bukan koneksi TCP biasa:
 * di EdgeOne Cloud Functions setiap request bisa dilayani proses baru, dan
 * driver TCP akan membuka koneksi baru terus-menerus sampai slot Postgres
 * habis. Driver HTTP menembak endpoint Neon per-kueri tanpa menahan koneksi.
 *
 * Konsekuensinya DATABASE_URL harus URL Neon (…neon.tech). Untuk dev lokal
 * pakai branch Neon terpisah — bukan Postgres di localhost, yang tidak
 * berbicara protokol HTTP ini.
 *
 * Env:
 *   DATABASE_URL — connection string Neon (wajib).
 */
// Driver di-require secara MALAS, saat kueri pertama — bukan saat modul dimuat.
// Di EdgeOne Makers paketnya tersedia lewat edgeone.json ->
// agents.externalNodeModules, jadi require() biasa cukup dan tidak ada langkah
// bundle. setNeonFactory() dipertahankan untuk pengujian dan untuk host lain
// yang ingin menyuntikkan driver sendiri.
let neonFactory = null;
function setNeonFactory(fn) { neonFactory = fn; }
function resolveNeon() {
  if (neonFactory) return neonFactory;
  return require('@neondatabase/serverless').neon;
}

let client = null;

function sql() {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL belum disetel. Isi di .env (lokal) atau di variabel lingkungan project EdgeOne Makers.'
    );
  }
  client = resolveNeon()(url);
  return client;
}

/**
 * Jalankan satu pernyataan berparameter.
 * Placeholder memakai gaya Postgres ($1, $2, …), bukan `?` seperti SQLite.
 */
async function query(text, params = []) {
  const c = sql();
  // Versi driver berbeda menaruh bentuk non-template di tempat berbeda:
  // yang baru di `sql.query`, yang lama memanggil `sql(text, params)`.
  const run = typeof c.query === 'function' ? c.query.bind(c) : c;
  return await run(text, params);
}

/** Semua baris. */
async function many(text, params = []) {
  return query(text, params);
}

/** Baris pertama, atau null bila kosong — pengganti `.get()` milik node:sqlite. */
async function one(text, params = []) {
  const rows = await query(text, params);
  return rows.length ? rows[0] : null;
}

/** Jalankan tanpa membaca hasil — pengganti `.run()`. */
async function exec(text, params = []) {
  await query(text, params);
}

/** Nilai satu kolom dari baris pertama (mis. COUNT). */
async function scalar(text, params = []) {
  const row = await one(text, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

/** Untuk pengujian: lupakan client agar DATABASE_URL yang baru terbaca. */
function reset() {
  client = null;
}

module.exports = { query, many, one, exec, scalar, reset, setNeonFactory };
