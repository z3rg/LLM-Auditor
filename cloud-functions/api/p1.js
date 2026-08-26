/** Tangga 1 — import STATIS modul bawaan Node saja (tanpa dependency, tanpa lib/). */
import { Readable } from 'node:stream';

export default function onRequest() {
  return new Response(JSON.stringify({
    ok: true, probe: 'p1-import-statis-node-builtin',
    readable: typeof Readable, node: process.version,
  }), { headers: { 'Content-Type': 'application/json' } });
}
