'use strict';
/**
 * Lapisan penyimpanan LLM Auditor — EdgeOne Pages Blob.
 *
 * Menggantikan Postgres (Neon). Blob adalah object store, bukan database:
 * tidak ada kueri, index, join, maupun transaksi. Dua sifat SDK-nya yang
 * dipakai berat di sini, karena keduanya yang membuat penyimpanan ini aman:
 *
 *   1. `onlyIfNew` — tulis bersyarat yang gagal (PreconditionFailedError) bila
 *      kunci sudah ada. Ini satu-satunya operasi atomik yang tersedia, dan
 *      dipakai untuk hal yang benar-benar butuh keunikan: alamat email dan
 *      alokasi id.
 *   2. `consistency: "strong"` — baca lewat domain tanpa cache, menjamin
 *      read-after-write. Default di modul ini SENGAJA strong: mode "eventual"
 *      bisa tertinggal sampai 60 detik, dan itu berarti pengguna yang baru
 *      login membaca sesi basi lalu langsung terlempar "sesi berakhir".
 *
 * Aturan tata kunci yang menjaga kebenaran: SATU ENTITAS = SATU KUNCI. Tidak
 * ada koleksi besar yang dibaca-ubah-tulis, karena Blob tidak punya penguncian
 * dan dua penulis pada blob yang sama akan saling menimpa diam-diam. Penulisan
 * yang sering (submit kuis, sesi, throttle login) karena itu selalu menyentuh
 * kunci milik satu pengguna saja.
 *
 * Konsekuensi yang diterima: agregat (analitik gap) harus mengumpulkan banyak
 * objek sekaligus. Itu sebabnya ada cache dalam proses di bawah — mode Agent
 * EdgeOne memakai Session mode sehingga instance-nya bertahan antar-request,
 * jadi cache ini benar-benar terpakai, bukan sekadar hiasan.
 *
 * Env:
 *   BLOB_STORE_NAME    nama namespace (default 'auditor')
 *   EDGEONE_PROJECT_ID + EDGEONE_BLOB_TOKEN
 *                      HANYA untuk akses dari luar runtime Pages (skrip seed).
 *                      Di dalam Agent Function, kredensialnya disuntik platform
 *                      saat build dan kedua env ini tidak perlu ada.
 *   BLOB_LOCAL_DIR     pakai berkas lokal alih-alih Blob sungguhan (dev & uji).
 */
const crypto = require('node:crypto');

const STORE_NAME = process.env.BLOB_STORE_NAME || 'auditor';

// Bukan konstanta bebas: SDK menolak nama namespace di luar pola ini.
const STORE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

let cachedStore = null;

/** Store Blob, dibuat sekali per proses. */
function store() {
  if (cachedStore) return cachedStore;
  if (!STORE_NAME_RE.test(STORE_NAME)) {
    throw new Error(
      `BLOB_STORE_NAME '${STORE_NAME}' tidak valid — hanya huruf, angka, garis bawah, dan tanda hubung (maks 64).`
    );
  }
  // Dua penamaan diterima: milik proyek ini, dan milik SDK sendiri
  // (PAGES_PROJECT_ID / PAGES_BLOB_DEPLOY_CREDENTIAL, yang dibaca SDK langsung
  // dari process.env). Menerima keduanya membuat konfigurasi di konsol Makers
  // tidak bergantung pada nama mana yang kebetulan dipakai.
  const projectId = (process.env.EDGEONE_PROJECT_ID || process.env.PAGES_PROJECT_ID || '').trim();
  const token = (process.env.EDGEONE_BLOB_TOKEN || process.env.PAGES_BLOB_DEPLOY_CREDENTIAL || '').trim();
  const localDir = (process.env.BLOB_LOCAL_DIR || '').trim();

  // Urutannya eksplisit supaya tidak pernah ada tebak-tebakan soal data mana
  // yang sedang dipakai:
  //   1. projectId + token  -> Blob sungguhan dari luar platform (skrip seed)
  //   2. BLOB_LOCAL_DIR     -> berkas lokal (dev & uji, tanpa kredensial)
  //   3. selain itu         -> Blob sungguhan, kredensial disuntik platform
  if (projectId && token) {
    const { getStore } = require('@edgeone/pages-blob');
    cachedStore = getStore({ name: STORE_NAME, projectId, token, consistency: 'strong' });
  } else if (localDir) {
    const { LocalStore } = require('./blob_local');
    const path = require('node:path');
    cachedStore = new LocalStore(path.resolve(localDir, STORE_NAME));
  } else {
    const { getStore } = require('@edgeone/pages-blob');
    cachedStore = getStore(STORE_NAME);
  }
  return cachedStore;
}

/** Pesan yang menyebut penyebab sebenarnya, bukan 'fetch failed'. */
function explain(e) {
  const msg = String((e && e.message) || e);
  if (/credential|deployCredential|MISSING_PROJECT_ID|projectId|token/i.test(msg)) {
    return new Error(
      'Blob tidak terautentikasi. Di dalam EdgeOne Makers ini otomatis; ' +
      'di luar (dev lokal / skrip) set EDGEONE_PROJECT_ID dan EDGEONE_BLOB_TOKEN. ' +
      `Penyebab asli: ${msg}`
    );
  }
  return e;
}

function isNotFound(e) {
  return /not found|404|NoSuchKey/i.test(String((e && e.message) || e));
}

/** Tulis bersyarat gagal karena kuncinya sudah ada. */
function isAlreadyExists(e) {
  const code = (e && e.code) || '';
  return code === 'PRECONDITION_FAILED' || /already exists|precondition/i.test(String((e && e.message) || e));
}

// --- operasi dasar ----------------------------------------------------------

/** Baca JSON, atau `fallback` bila kunci tidak ada. */
async function getJSON(key, fallback = null) {
  try {
    const value = await store().get(key, { type: 'json' });
    return value === null || value === undefined ? fallback : value;
  } catch (e) {
    if (isNotFound(e)) return fallback;
    throw explain(e);
  }
}

/** Tulis/timpa JSON. */
async function putJSON(key, value) {
  try {
    await store().setJSON(key, value);
  } catch (e) {
    throw explain(e);
  }
}

/**
 * Tulis HANYA bila kunci belum ada. Mengembalikan false bila sudah terisi.
 * Ini satu-satunya operasi atomik yang punya Blob — dipakai untuk keunikan
 * email dan alokasi id, jangan diganti dengan get-lalu-put.
 */
async function createJSON(key, value) {
  try {
    await store().setJSON(key, value, { onlyIfNew: true });
    return true;
  } catch (e) {
    if (isAlreadyExists(e)) return false;
    throw explain(e);
  }
}

async function del(key) {
  try {
    await store().delete(key);
  } catch (e) {
    if (isNotFound(e)) return;
    throw explain(e);
  }
}

/** Seluruh kunci di bawah sebuah prefix (SDK sudah menggabungkan halaman). */
async function listKeys(prefix) {
  try {
    const res = await store().list({ prefix });
    return (res && res.blobs ? res.blobs : []).map((b) => b.key);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw explain(e);
  }
}

/**
 * Baca banyak kunci sekaligus dengan paralelisme terbatas.
 *
 * Dibatasi karena analitik gap membaca puluhan objek sekaligus dan SDK punya
 * RateLimitedError — melepas 500 fetch serentak adalah cara tercepat menemuinya.
 */
async function getManyJSON(keys, limit = 12) {
  // Hasilnya SEJAJAR dengan `keys` (kunci yang hilang jadi null), karena
  // beberapa pemanggil memetakan balik ke nama kunci untuk mengambil id.
  // Penyaringan null adalah urusan pemanggil.
  const out = new Array(keys.length).fill(null);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= keys.length) return;
      out[i] = await getJSON(keys[i], null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, keys.length) }, worker));
  return out;
}

/** Semua objek di bawah prefix, tanpa kunci yang hilang. */
async function getAllUnder(prefix) {
  return (await getManyJSON(await listKeys(prefix))).filter((v) => v !== null);
}

// --- cache dalam proses -----------------------------------------------------
// Mode Agent EdgeOne memakai Session mode: request dengan conversation_id yang
// sama dilayani instance yang sama, jadi memori proses bertahan antar-request
// dan cache ini benar-benar mengurangi fan-out. TTL-nya pendek supaya data
// yang berubah tetap terlihat cepat.
const CACHE_TTL_MS = Number(process.env.BLOB_CACHE_TTL_MS || 15_000);
const cache = new Map();

async function cached(key, loader, ttl = CACHE_TTL_MS) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await loader();
  cache.set(key, { value, until: Date.now() + ttl });
  return value;
}

/** Buang entri cache (satu prefix, atau semuanya). */
function invalidate(prefix) {
  if (!prefix) { cache.clear(); return; }
  for (const k of cache.keys()) if (k === prefix || k.startsWith(`${prefix}:`)) cache.delete(k);
}

// --- util -------------------------------------------------------------------

/** Kunci stabil & aman-URL dari teks bebas (email). Bukan untuk rahasia. */
function keyHash(text) {
  return crypto.createHash('sha256').update(String(text).trim().toLowerCase()).digest('hex').slice(0, 32);
}

module.exports = {
  STORE_NAME,
  store,
  getJSON, putJSON, createJSON, del,
  listKeys, getManyJSON, getAllUnder,
  cached, invalidate,
  keyHash,
};
