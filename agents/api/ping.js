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
      EDGEONE_PROJECT_ID: isSet('EDGEONE_PROJECT_ID') || isSet('PAGES_PROJECT_ID'),
      EDGEONE_BLOB_TOKEN: isSet('EDGEONE_BLOB_TOKEN') || isSet('PAGES_BLOB_DEPLOY_CREDENTIAL'),
      BLOB_STORE_NAME: isSet('BLOB_STORE_NAME'),
    },
    // Ringkasan siap-tidaknya, supaya satu panggilan cukup untuk tahu apa yang kurang.
    ready: {
      ai: isSet('MAKERS_MODELS_KEY'),
      blob: (isSet('EDGEONE_PROJECT_ID') || isSet('PAGES_PROJECT_ID'))
        && (isSet('EDGEONE_BLOB_TOKEN') || isSet('PAGES_BLOB_DEPLOY_CREDENTIAL')),
    },
  }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default onRequest;
