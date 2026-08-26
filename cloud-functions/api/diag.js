/**
 * Probe B — menguji resolusi modul satu per satu.
 *
 * Import-nya dinamis dan dibungkus try/catch supaya kegagalan salah satu modul
 * tidak mematikan seluruh function: hasilnya justru dilaporkan. Ini yang
 * menjawab pertanyaan pokoknya — apakah kode di luar cloud-functions/ (lib/)
 * ikut terkemas ke bundle function, dan apakah dependency npm-nya terpasang.
 */
export default async function onRequest(context) {
  const targets = [
    ['express', () => import('express')],
    ['@neondatabase/serverless', () => import('@neondatabase/serverless')],
    ['../../lib/api.js', () => import('../../lib/api.js')],
    ['../../lib/db.js', () => import('../../lib/db.js')],
    ['../../db/schema.sql (fs)', async () => {
      const fs = await import('node:fs');
      const url = await import('node:url');
      const path = await import('node:path');
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      return { size: fs.statSync(path.join(here, '..', '..', 'db', 'schema.sql')).size };
    }],
  ];

  const results = {};
  for (const [name, load] of targets) {
    try {
      await load();
      results[name] = 'ok';
    } catch (e) {
      results[name] = `GAGAL: ${e.code || ''} ${String(e.message).slice(0, 200)}`.trim();
    }
  }

  return new Response(JSON.stringify({
    probe: 'diag',
    node: process.version,
    cwd: process.cwd(),
    dir: import.meta.url,
    envTerpasang: {
      DATABASE_URL: !!process.env.DATABASE_URL,
      MAKERS_MODELS_KEY: !!process.env.MAKERS_MODELS_KEY,
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    },
    modul: results,
  }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
