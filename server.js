'use strict';
/**
 * LLM Auditor — entri pengembangan lokal.
 *
 * Di produksi (EdgeOne Makers) berkas ini TIDAK dipakai: frontend disajikan
 * static hosting dan API dijalankan sebagai Agent Functions (agents/api/**,
 * lewat jembatan agents/_api.js). Keduanya memakai router yang sama,
 * lib/api.js, sehingga perilaku lokal dan terdeploy tidak bercabang.
 *
 * Butuh backend Blob. Untuk dev lokal set BLOB_LOCAL_DIR di .env (berkas biasa,
 * tanpa kredensial); untuk menunjuk Blob sungguhan set EDGEONE_PROJECT_ID +
 * EDGEONE_BLOB_TOKEN. Isi data awal sekali dengan:
 *   npm run seed
 */
require('./lib/env').loadEnv();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const apiRouter = require('./lib/api');
const ai = require('./lib/ai');
const db = require('./lib/db');
const auth = require('./lib/auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    apiRouter.handle(req, res);
    return;
  }
  serveStatic(res, url.pathname);
});

(async () => {
  const local = process.env.BLOB_LOCAL_DIR;
  const remote = process.env.EDGEONE_PROJECT_ID && process.env.EDGEONE_BLOB_TOKEN;
  if (!local && !remote) {
    console.error('\n  Backend Blob belum dipilih. Set BLOB_LOCAL_DIR di .env untuk dev lokal,');
    console.error('  atau EDGEONE_PROJECT_ID + EDGEONE_BLOB_TOKEN untuk memakai Blob sungguhan.\n');
    process.exit(1);
  }

  // Isi data awal bila store masih kosong — di Postgres ini dulu langkah
  // terpisah (`db:setup`) karena DDL mahal; di Blob seed-nya idempoten & murah.
  try { await db.seed(); } catch (e) {
    console.error(`\n  Gagal menyiapkan data awal: ${e.message}\n`);
    process.exit(1);
  }

  // Beri kata sandi awal untuk akun staf bawaan (sekali saja, saat pertama jalan).
  let boot = { seeded: [], seedPassword: null };
  try {
    boot = await auth.bootstrap();
  } catch (e) {
    console.error(`\n  Gagal menyiapkan akun staf: ${e.message}\n`);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`\n  LLM Auditor running:  http://localhost:${PORT}`);
    const aiCfg = ai.cfg();
    console.log(`  LLM provider:         ${aiCfg.providerLabel}`);
    console.log(`  LLM model:            ${aiCfg.model}`);
    console.log(`  LLM key loaded:       ${aiCfg.key ? 'yes' : `NO — set ${aiCfg.keyEnv} in .env`}`);
    console.log(`  Penyimpanan:          EdgeOne Blob (${local ? `lokal: ${local}` : 'remote'})`);
    if (boot.seeded.length) {
      console.log(`\n  Akun staf disiapkan dengan kata sandi awal "${boot.seedPassword}":`);
      for (const email of boot.seeded) console.log(`    · ${email}`);
      console.log('  Ganti kata sandi setelah masuk (menu Pengaturan), atau set SEED_PASSWORD di .env.');
    }
    console.log('');
  });
})();
