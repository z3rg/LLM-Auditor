'use strict';
/**
 * Penyiapan database sekali jalan: terapkan skema → isi data awal → beri kata
 * sandi awal untuk akun staf bawaan.
 *
 *   npm run db:setup              # aman diulang; data yang sudah ada dibiarkan
 *   npm run seed                  # kosongkan tabel operasional lalu isi ulang
 *
 * Di versi SQLite semua ini terjadi otomatis saat modul database dimuat. Itu
 * tidak cocok untuk serverless — setiap cold start akan menjalankan DDL — jadi
 * penyiapan sekarang jadi langkah eksplisit.
 *
 * Butuh DATABASE_URL (Neon) di .env atau di lingkungan.
 */
require('../lib/env').loadEnv();

const db = require('../lib/db');
const auth = require('../lib/auth');

const reseed = process.argv.includes('--reseed');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL belum disetel. Isi connection string Neon di .env lebih dulu.');
    process.exit(1);
  }

  console.log('  Menerapkan skema (db/schema.sql)…');
  await db.applySchema();

  if (reseed) {
    console.log('  Mengosongkan tabel operasional dan mengisi ulang data dummy…');
    await db.reseed();
  } else {
    const created = await db.seed();
    console.log(created ? '  Data dummy diisi.' : '  Data sudah ada — pengisian dilewati.');
  }

  const boot = await auth.bootstrap();
  if (boot.seeded.length) {
    console.log(`\n  Akun staf disiapkan dengan kata sandi awal "${boot.seedPassword}":`);
    for (const email of boot.seeded) console.log(`    · ${email}`);
    console.log('  Ganti kata sandi setelah masuk, atau set SEED_PASSWORD sebelum menjalankan ini.');
  }

  const counts = await require('../lib/pg').one(`
    SELECT (SELECT COUNT(*)::int FROM divisions)     AS divisions,
           (SELECT COUNT(*)::int FROM topics)        AS topics,
           (SELECT COUNT(*)::int FROM employees)     AS employees,
           (SELECT COUNT(*)::int FROM quiz_attempts) AS attempts,
           (SELECT COUNT(*)::int FROM pdf_chunks)    AS chunks
  `);
  console.log('\n  Isi database:', counts);
  console.log('  Selesai.\n');
})().catch((e) => {
  console.error('\n  Gagal:', e.message, '\n');
  process.exit(1);
});
