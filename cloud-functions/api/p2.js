/** Tangga 2 — import DINAMIS modul bawaan Node, di dalam handler. */
export default async function onRequest() {
  try {
    const fs = await import('node:fs');
    return new Response(JSON.stringify({
      ok: true, probe: 'p2-import-dinamis-node-builtin', existsSync: typeof fs.existsSync,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, probe: 'p2', error: String(e.message) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
