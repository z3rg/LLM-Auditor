/**
 * Probe kesehatan tanpa dependency — GET /api/ping.
 *
 * SENGAJA tidak meng-import lib/ apa pun. Kalau /api/ping hidup tetapi rute
 * lain mati, penyebabnya ada di graf modul lib/ atau di dependency runtime,
 * bukan di routing atau di runtime agent itu sendiri. Itu satu-satunya
 * pemisahan yang menghemat waktu saat deploy gagal tanpa stack trace.
 *
 * Hanya melaporkan APAKAH sebuah variabel terisi — tidak pernah nilainya.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/**
 * Apakah builder sudah mengganti placeholder kredensial di dalam SDK Blob.
 *
 * Ini pemeriksaan yang menentukan: autentikasi otomatis Pages Blob bekerja
 * dengan menyubstitusi string {{PAGES_BLOB_DEPLOY_CREDENTIAL}} di dalam berkas
 * paketnya saat build. Kalau string itu masih utuh, paketnya dipasang apa
 * adanya dari npm (mis. karena didaftarkan di externalNodeModules) dan Blob
 * akan menjawab "Missing: token" berapa kali pun di-deploy ulang.
 */
function blobCredentialPatched() {
  try {
    const resolve = createRequire(import.meta.url);
    const file = resolve.resolve('@edgeone/pages-blob');
    const src = readFileSync(file, 'utf8');
    return !src.includes('{{PAGES_BLOB_DEPLOY' + '_CREDENTIAL}}');
  } catch (e) {
    return `tidak terbaca: ${String((e && e.message) || e).slice(0, 120)}`;
  }
}

export async function onRequest(context) {
  const env = { ...process.env, ...(context?.env && typeof context.env === 'object' ? context.env : {}) };
  const isSet = (key) => typeof env[key] === 'string' && env[key].trim().length > 0;

  return new Response(JSON.stringify({
    ok: true,
    runtime: 'edgeone-makers-agents',
    node: process.version,
    now: new Date().toISOString(),
    env: {
      MAKERS_MODELS_KEY: isSet('MAKERS_MODELS_KEY'),
      // Dipisah per nama: platform menyuntikkan PAGES_PROJECT_ID sendiri, jadi
      // menggabungkannya dengan EDGEONE_PROJECT_ID membuat variabel yang belum
      // diisi terlihat seolah sudah — itu sempat menyesatkan diagnosis.
      EDGEONE_PROJECT_ID: isSet('EDGEONE_PROJECT_ID'),
      PAGES_PROJECT_ID: isSet('PAGES_PROJECT_ID'),
      EDGEONE_BLOB_TOKEN: isSet('EDGEONE_BLOB_TOKEN'),
      PAGES_BLOB_DEPLOY_CREDENTIAL: isSet('PAGES_BLOB_DEPLOY_CREDENTIAL'),
      BLOB_STORE_NAME: isSet('BLOB_STORE_NAME'),
    },
    // Kredensial otomatis Blob: true = builder sudah menambal SDK-nya.
    blobCredentialPatched: blobCredentialPatched(),
    // Ringkasan siap-tidaknya, supaya satu panggilan cukup untuk tahu apa yang kurang.
    ready: {
      ai: isSet('MAKERS_MODELS_KEY'),
      blob: (isSet('EDGEONE_PROJECT_ID') || isSet('PAGES_PROJECT_ID'))
        && (isSet('EDGEONE_BLOB_TOKEN') || isSet('PAGES_BLOB_DEPLOY_CREDENTIAL')),
    },
  }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default onRequest;
