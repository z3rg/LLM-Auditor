/** Tangga 3 — createRequire + require berkas CommonJS TETANGGA (dalam direktori function). */
import { createRequire } from 'node:module';

export default async function onRequest() {
  try {
    const require = createRequire(import.meta.url);
    const sibling = require('./p3lib.cjs');
    return new Response(JSON.stringify({
      ok: true, probe: 'p3-require-cjs-tetangga', sibling,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, probe: 'p3', code: e.code, error: String(e.message) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
