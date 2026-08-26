'use strict';
/**
 * LLM Auditor — entri pengembangan lokal.
 *
 * Di produksi (EdgeOne Makers) berkas ini TIDAK dipakai: frontend disajikan
 * static hosting dan API dijalankan sebagai Cloud Function
 * (cloud-functions/api/[[default]].js). Keduanya memakai router yang sama,
 * lib/api.js, sehingga perilaku lokal dan terdeploy tidak bercabang.
 *
 * Butuh DATABASE_URL (Neon). Siapkan skema & data awal sekali dengan:
 *   npm run db:setup
 */
require('./lib/env').loadEnv();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const apiRouter = require('./lib/api');
const ai = require('./lib/ai');
const vec = require('./lib/vec');
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
  if (!process.env.DATABASE_URL) {
    console.error('\n  DATABASE_URL belum disetel. Isi di .env (connection string Neon), lalu jalankan `npm run db:setup`.\n');
    process.exit(1);
  }

  // Hangatkan embedder RAG sebelum melayani request.
  try { await vec.ready(); } catch (e) { console.warn('  RAG init warning:', e.message); }

  // Beri kata sandi awal untuk akun staf bawaan (sekali saja, saat pertama jalan).
  let boot = { seeded: [], seedPassword: null };
  try {
    boot = await auth.bootstrap();
  } catch (e) {
    console.error(`\n  Gagal menyiapkan akun staf: ${e.message}`);
    console.error('  Skema database sudah dibuat? Jalankan `npm run db:setup` lebih dulu.\n');
    process.exit(1);
  }

  const r = await vec.stats();
  server.listen(PORT, () => {
    console.log(`\n  LLM Auditor running:  http://localhost:${PORT}`);
    const aiCfg = ai.cfg();
    console.log(`  LLM provider:         ${aiCfg.providerLabel}`);
    console.log(`  LLM model:            ${aiCfg.model}`);
    console.log(`  LLM key loaded:       ${aiCfg.key ? 'yes' : `NO — set ${aiCfg.keyEnv} in .env`}`);
    console.log(`  Database:             Postgres (Neon)`);
    console.log(`  RAG embedder:         ${r.embedder} (dim ${r.dim})`);
    console.log(`  RAG vector store:     ${r.backend} — ${r.chunks} chunk`);
    if (boot.seeded.length) {
      console.log(`\n  Akun staf disiapkan dengan kata sandi awal "${boot.seedPassword}":`);
      for (const email of boot.seeded) console.log(`    · ${email}`);
      console.log('  Ganti kata sandi setelah masuk (menu Pengaturan), atau set SEED_PASSWORD di .env.');
    }
    console.log('');
  });
})();
