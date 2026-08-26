#!/usr/bin/env node
'use strict';
/**
 * Cadangkan / pulihkan seluruh isi store Blob LLM Auditor.
 *
 *   node scripts/blob_backup.js dump   [berkas.json]   # ekspor semua kunci
 *   node scripts/blob_backup.js restore berkas.json    # tulis balik semua kunci
 *
 * Kenapa ini ada: Postgres (Neon) punya point-in-time restore bawaan, jadi
 * skrip cadangan lama hanya pelengkap. EdgeOne Blob TIDAK punya itu — sekali
 * sebuah kunci ditimpa atau dihapus, isinya hilang. Cadangan yang Anda pegang
 * sendiri karena itu jadi lebih penting setelah pindah ke Blob, bukan kurang.
 *
 * Backend dipilih lewat env yang sama dengan aplikasi:
 *   BLOB_LOCAL_DIR                            -> berkas lokal
 *   EDGEONE_PROJECT_ID + EDGEONE_BLOB_TOKEN   -> Blob sungguhan
 *
 * Isi cadangan memuat hash kata sandi dan token sesi ter-hash. Perlakukan
 * berkasnya seperti rahasia: simpan dengan izin ketat, jangan commit.
 */
require('../lib/env').loadEnv();
const fs = require('node:fs');
const blob = require('../lib/blob');

const [, , command, file] = process.argv;

async function dump(target) {
  const keys = await blob.listKeys('');
  const entries = {};
  let n = 0;
  for (const key of keys) {
    entries[key] = await blob.getJSON(key, null);
    if (++n % 25 === 0) process.stdout.write(`\r  ${n}/${keys.length} kunci…`);
  }
  const payload = {
    store: blob.STORE_NAME,
    takenAt: new Date().toISOString(),
    count: keys.length,
    entries,
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), { mode: 0o600 });
  console.log(`\r  ${keys.length} kunci -> ${target} (${(fs.statSync(target).size / 1024).toFixed(1)} KB)`);
}

async function restore(source) {
  const payload = JSON.parse(fs.readFileSync(source, 'utf8'));
  const keys = Object.keys(payload.entries || {});
  if (!keys.length) throw new Error('Cadangan kosong.');
  console.log(`  Memulihkan ${keys.length} kunci dari cadangan ${payload.takenAt} (store "${payload.store}")`);
  let n = 0;
  for (const key of keys) {
    if (payload.entries[key] === null) continue;
    await blob.putJSON(key, payload.entries[key]);
    if (++n % 25 === 0) process.stdout.write(`\r  ${n}/${keys.length} kunci…`);
  }
  blob.invalidate();
  console.log(`\r  ${n} kunci dipulihkan.`);
}

(async () => {
  if (!process.env.BLOB_LOCAL_DIR && !(process.env.EDGEONE_PROJECT_ID && process.env.EDGEONE_BLOB_TOKEN)) {
    throw new Error('Backend Blob belum dipilih (BLOB_LOCAL_DIR, atau EDGEONE_PROJECT_ID + EDGEONE_BLOB_TOKEN).');
  }
  if (command === 'dump') {
    await dump(file || `auditor-blob-${new Date().toISOString().slice(0, 10)}.json`);
  } else if (command === 'restore') {
    if (!file) throw new Error('Sebutkan berkas cadangan: node scripts/blob_backup.js restore berkas.json');
    await restore(file);
  } else {
    console.log('Pemakaian:\n  node scripts/blob_backup.js dump   [berkas.json]\n  node scripts/blob_backup.js restore berkas.json');
    process.exit(1);
  }
})().catch((e) => { console.error('\n  Gagal:', e.message, '\n'); process.exit(1); });
