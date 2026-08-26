#!/usr/bin/env node
'use strict';
/**
 * Isi data awal LLM Auditor ke EdgeOne Blob.
 *
 *   node scripts/seed_blob.js              # isi bila store masih kosong (idempoten)
 *   node scripts/seed_blob.js --reseed     # HAPUS semua data aplikasi lalu isi ulang
 *
 * Backend dipilih lewat env, sama seperti aplikasinya:
 *   BLOB_LOCAL_DIR                             -> berkas lokal (dev & uji)
 *   EDGEONE_PROJECT_ID + EDGEONE_BLOB_TOKEN    -> Blob sungguhan dari luar platform
 *
 * Token dibuat di konsol Makers (Project Settings -> API Token). Skrip ini
 * dijalankan dari mesin Anda, BUKAN dari dalam function, karena di dalam
 * function kredensialnya disuntik platform dan tidak bisa diambil dari sini.
 */
require('../lib/env').loadEnv();

const db = require('../lib/db');
const auth = require('../lib/auth');

const reseed = process.argv.includes('--reseed');

(async () => {
  const local = process.env.BLOB_LOCAL_DIR;
  const remote = process.env.EDGEONE_PROJECT_ID && process.env.EDGEONE_BLOB_TOKEN;
  if (!local && !remote) {
    console.error('\n  Backend Blob belum dipilih.');
    console.error('  Dev lokal : BLOB_LOCAL_DIR=./.blob-data');
    console.error('  Blob asli : EDGEONE_PROJECT_ID=makers-xxxx EDGEONE_BLOB_TOKEN=…\n');
    process.exit(1);
  }
  console.log(`  Target: ${local ? `berkas lokal (${local})` : `Blob project ${process.env.EDGEONE_PROJECT_ID}`}`);

  if (reseed) {
    console.log('  --reseed: menghapus seluruh data aplikasi…');
    await db.reseed();
  } else {
    const created = await db.seed();
    if (!created) console.log('  Store sudah terisi — tidak ada yang diubah (pakai --reseed untuk memaksa).');
  }

  const [divisions, topics, employees] = await Promise.all([
    db.listDivisions(), db.listTopics(), db.listEmployees(),
  ]);
  const boot = await auth.bootstrap();

  console.log(`  Divisi     : ${divisions.length}`);
  console.log(`  Topik      : ${topics.length}`);
  console.log(`  Peserta    : ${employees.length}`);
  if (boot.seeded.length) {
    console.log(`\n  Akun staf disiapkan dengan kata sandi awal "${boot.seedPassword}":`);
    for (const email of boot.seeded) console.log(`    · ${email}`);
    console.log('  Ganti kata sandi setelah masuk, atau set SEED_PASSWORD sebelum menjalankan ini.');
  } else {
    console.log('  Akun staf   : kata sandi sudah pernah disetel (tidak diubah).');
  }
  console.log('');
})().catch((e) => { console.error('\n  Gagal:', e.message, '\n'); process.exit(1); });
