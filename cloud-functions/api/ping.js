/**
 * Probe A — tanpa import sama sekali.
 *
 * Tujuannya memisahkan dua kemungkinan saat /api/* menggantung:
 *   · /api/ping IKUT menggantung  -> runtime function-nya sendiri yang bermasalah
 *     (konfigurasi build/route), bukan kode aplikasi.
 *   · /api/ping JALAN             -> runtime sehat; masalahnya ada di graf modul
 *     aplikasi (lihat /api/diag).
 *
 * Bentuknya sengaja meniru contoh quick start dokumentasi apa adanya.
 */
export default function onRequest(context) {
  return new Response(
    JSON.stringify({ ok: true, probe: 'ping', node: process.version, now: new Date().toISOString() }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
}
