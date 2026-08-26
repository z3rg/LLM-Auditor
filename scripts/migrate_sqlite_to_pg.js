'use strict';
/**
 * Migrasi sekali jalan: data/auditor.db (SQLite) → Postgres (Neon).
 *
 *   node scripts/migrate_sqlite_to_pg.js [path/ke/auditor.db]
 *
 * Memindahkan seluruh isi snapshot demo — divisi, topik, karyawan, attempt
 * kuis, rekomendasi, sesi kuis, pengaturan, dokumen PDF, dan 452 chunk RAG.
 * Embedding sudah tersimpan sebagai blob Float32 di SQLite, jadi tinggal
 * dikonversi ke literal pgvector: TIDAK ada satu pun panggilan ke Gemini.
 *
 * Skrip ini berjalan LOKAL saja dan sengaja memakai node:sqlite (butuh Node
 * >= 22.5). Aplikasi yang terdeploy tidak pernah memuat modul ini.
 *
 * Bersifat menimpa: tabel tujuan dikosongkan lebih dulu, sehingga bisa
 * dijalankan ulang tanpa menumpuk data.
 */
require('../lib/env').loadEnv();

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const pg = require('../lib/pg');

const SRC = process.argv[2] || path.join(__dirname, '..', 'data', 'auditor.db');

// Urutan penting: mengikuti ketergantungan foreign key.
const TABLES = [
  { name: 'divisions',     cols: ['id', 'name'] },
  { name: 'topics',        cols: ['id', 'name', 'area'] },
  { name: 'employees',     cols: ['id', 'name', 'email', 'role', 'division_id', 'password_hash', 'status', 'created_at'] },
  { name: 'quiz_attempts', cols: ['id', 'employee_id', 'topic_id', 'score', 'taken_at'] },
  { name: 'recommendations', cols: ['id', 'scope_type', 'scope_ref', 'scope_label', 'title', 'gap_summary', 'recommendation', 'recommended_topics', 'model', 'created_by', 'status', 'ack_by', 'ack_note', 'ack_at', 'created_at'] },
  { name: 'quiz_sessions', cols: ['id', 'employee_id', 'topic_id', 'payload', 'num_questions', 'status', 'score', 'model', 'created_at', 'submitted_at'] },
  { name: 'sessions',      cols: ['token_hash', 'employee_id', 'created_at', 'expires_at', 'user_agent'] },
  { name: 'app_settings',  cols: ['key', 'value'] },
  { name: 'pdf_documents', cols: ['id', 'filename', 'title', 'num_pages', 'num_chunks', 'bytes', 'chars', 'created_at'] },
];

const BATCH = 200;

/** Blob Float32 milik SQLite → literal pgvector '[…]'. */
function blobToVector(buf) {
  if (!buf) return null;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return `[${Array.from(new Float32Array(ab)).join(',')}]`;
}

/** INSERT multi-baris dengan placeholder $1..$n. */
async function insertRows(table, cols, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = slice.map((row) => {
      const marks = cols.map((c) => {
        params.push(row[c] === undefined ? null : row[c]);
        return `$${params.length}`;
      });
      return `(${marks.join(', ')})`;
    });
    await pg.exec(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}`,
      params
    );
  }
}

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum disetel.');
  if (!fs.existsSync(SRC)) throw new Error(`Berkas SQLite tidak ditemukan: ${SRC}`);

  // immutable=1: buka betul-betul read-only, tanpa membuat berkas WAL/SHM di
  // samping snapshot yang dilacak git.
  const src = new DatabaseSync(`file:${SRC}?immutable=1`, { readOnly: true });
  console.log(`  Sumber : ${SRC}`);
  console.log(`  Tujuan : ${process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@')}\n`);

  console.log('  Mengosongkan tabel tujuan…');
  await pg.exec(`
    TRUNCATE pdf_chunks, pdf_documents, app_settings, sessions, login_attempts,
             quiz_sessions, quiz_attempts, recommendations, employees, topics, divisions
    RESTART IDENTITY CASCADE
  `);

  const summary = [];
  for (const t of TABLES) {
    const rows = src.prepare(`SELECT ${t.cols.join(', ')} FROM ${t.name}`).all();
    if (rows.length) await insertRows(t.name, t.cols, rows);
    summary.push({ tabel: t.name, sumber: rows.length });
    console.log(`  ${t.name.padEnd(16)} ${String(rows.length).padStart(5)} baris`);
  }

  // pdf_chunks ditangani terpisah: kolom embedding perlu cast ke vector.
  const chunks = src.prepare('SELECT id, doc_id, chunk_index, content, embedding FROM pdf_chunks').all();
  for (let i = 0; i < chunks.length; i += 25) {
    const slice = chunks.slice(i, i + 25);
    const params = [];
    const tuples = slice.map((c) => {
      params.push(c.id, c.doc_id, c.chunk_index, c.content, blobToVector(c.embedding));
      const n = params.length;
      return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n}::vector)`;
    });
    await pg.exec(
      `INSERT INTO pdf_chunks (id, doc_id, chunk_index, content, embedding) VALUES ${tuples.join(', ')}`,
      params
    );
    process.stdout.write(`\r  pdf_chunks       ${Math.min(i + 25, chunks.length)}/${chunks.length} chunk`);
  }
  console.log(chunks.length ? '' : '\r  pdf_chunks           0 chunk');
  summary.push({ tabel: 'pdf_chunks', sumber: chunks.length });

  // Sinkronkan sequence identity agar INSERT berikutnya tidak menabrak id lama.
  for (const t of TABLES.concat([{ name: 'pdf_chunks' }])) {
    if (['sessions', 'app_settings'].includes(t.name)) continue; // tanpa kolom identity
    await pg.exec(`
      SELECT setval(pg_get_serial_sequence('${t.name}', 'id'),
                    GREATEST(COALESCE((SELECT MAX(id) FROM ${t.name}), 0), 1))
    `);
  }

  // Verifikasi: bandingkan jumlah baris sumber vs tujuan.
  console.log('\n  Verifikasi jumlah baris:');
  let mismatch = 0;
  for (const row of summary) {
    const dest = await pg.scalar(`SELECT COUNT(*)::int FROM ${row.tabel}`);
    const ok = dest === row.sumber;
    if (!ok) mismatch += 1;
    console.log(`    ${ok ? '✓' : '✗'} ${row.tabel.padEnd(16)} sumber ${String(row.sumber).padStart(5)} → tujuan ${String(dest).padStart(5)}`);
  }
  src.close();

  if (mismatch) {
    console.error(`\n  ${mismatch} tabel tidak cocok. Periksa error di atas.\n`);
    process.exit(1);
  }
  console.log('\n  Migrasi selesai, seluruh jumlah baris cocok.\n');
})().catch((e) => {
  console.error('\n  Gagal:', e.message, '\n');
  process.exit(1);
});
