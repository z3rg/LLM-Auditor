'use strict';
/**
 * Pemuat .env mini (tanpa dependency dotenv).
 *
 * Hanya berguna untuk dev lokal. Di EdgeOne Makers tidak ada berkas .env —
 * variabel datang dari konfigurasi project, dan pemuat ini diam saja.
 * Nilai yang sudah ada di process.env tidak pernah ditimpa.
 */
const fs = require('node:fs');
const path = require('node:path');

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    const file = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2].replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (_) { /* .env opsional */ }
}

module.exports = { loadEnv };
