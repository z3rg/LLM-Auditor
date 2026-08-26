/** Tangga 4 — import dependency npm (driver Neon), menguji pemasangan node_modules function. */
export default async function onRequest() {
  try {
    const mod = await import('@neondatabase/serverless');
    return new Response(JSON.stringify({
      ok: true, probe: 'p4-dependency-npm', neon: typeof mod.neon,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, probe: 'p4', code: e.code, error: String(e.message) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
