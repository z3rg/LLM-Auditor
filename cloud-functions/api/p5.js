/** Tangga 5 — import berkas DI LUAR cloud-functions/ (inti dugaan bundling). */
export default async function onRequest() {
  try {
    const mod = await import('../../lib/pg.js');
    return new Response(JSON.stringify({
      ok: true, probe: 'p5-import-luar-direktori', keys: Object.keys(mod.default || mod).slice(0, 6),
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, probe: 'p5', code: e.code, error: String(e.message) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
