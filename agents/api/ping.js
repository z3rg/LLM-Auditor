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
      BLOB_STORE_NAME: isSet('BLOB_STORE_NAME'),
      BLOB_LOCAL_DIR: isSet('BLOB_LOCAL_DIR'),
    },
  }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default onRequest;
