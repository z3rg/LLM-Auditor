/**
 * EdgeOne Makers Cloud Function — seluruh /api/* LLM Auditor.
 *
 * Memakai bentuk `onRequest(context) -> Response` seperti contoh quick start
 * dokumentasi, BUKAN "export instance Express". Alasannya konkret: deployment
 * pertama dengan Express selalu berakhir `Invoking task timed out after 120
 * seconds` tanpa stack trace — handler terpanggil tapi tidak pernah membalas.
 * Gaya Fetch menghapus dua ketidakpastian sekaligus: adaptor Express milik
 * platform, dan bentuk objek res yang diberikannya.
 *
 * Router aplikasinya sendiri (lib/api.js) berbicara req/res gaya Node, jadi
 * berkas ini yang menjembatani Fetch <-> Node. Tiga sifat yang disengaja:
 *
 *   1. SUMBER, bukan berkas yang dideploy. `npm run build:function` mem-bundle
 *      berkas ini + seluruh lib/ jadi satu artefak mandiri di
 *      cloud-functions/api/[[default]].js.
 *
 *      Alasannya: platform mem-bundle tiap function jadi satu berkas
 *      /var/user/index.mjs, dan bundler-nya menyerah pada graf modul lib/ —
 *      import('../../lib/pg.js') berhasil (probe p5), tetapi
 *      import('../../lib/api.js') yang grafnya jauh lebih besar ditinggalkan
 *      sebagai require runtime lalu MODULE_NOT_FOUND. Dengan mem-bundle
 *      sendiri, artefaknya nol import relatif dan hasilnya bisa diuji lokal
 *      sebelum dikirim.
 *   2. Ada watchdog. Apa pun yang menggantung dibalas 504 berisi keterangan
 *      sebelum platform memotongnya di 120 detik tanpa jejak.
 *   3. Tidak ada dependency framework. Body dibaca sekali lalu dialirkan ulang.
 */
import { Readable } from 'node:stream';

// Batas aman di bawah maxDuration 120 detik, agar penyebabnya masih terlihat.
const WATCHDOG_MS = Number(process.env.FUNCTION_WATCHDOG_MS || 100_000);

// Di-inline oleh esbuild saat build; tidak ada resolusi modul saat runtime.
import apiRouter from '../lib/api.js';

function loadRouter() {
  return apiRouter;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Request Fetch -> objek mirip IncomingMessage yang dipahami lib/api.js. */
function toNodeRequest(request, url, bodyBuffer) {
  const req = Readable.from(bodyBuffer && bodyBuffer.length ? [bodyBuffer] : []);
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.headers = Object.fromEntries(request.headers);
  // lib/api.js memanggil req.destroy() saat body melewati batas.
  if (typeof req.destroy !== 'function') req.destroy = () => {};
  return req;
}

/** Objek mirip ServerResponse yang menyelesaikan sebuah Response Fetch. */
function makeNodeResponse(resolve) {
  const chunks = [];
  let status = 200;
  const headers = {};
  return {
    headersSent: false,
    statusCode: 200,
    setHeader(name, value) { headers[name] = value; },
    getHeader(name) { return headers[name]; },
    removeHeader(name) { delete headers[name]; },
    writeHead(code, extra) {
      status = code;
      this.statusCode = code;
      if (extra) for (const [k, v] of Object.entries(extra)) headers[k] = v;
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, { status, headers }));
    },
  };
}

export default async function onRequest(context) {
  // Bentuk context berbeda antar runtime: kadang Request langsung, kadang
  // dibungkus. Terima keduanya daripada berasumsi.
  const request = context && typeof context.method === 'string' ? context : context?.request;
  if (!request) return json(500, { error: 'Request tidak ditemukan pada context function.' });

  try {
    const url = new URL(request.url);

    // Platform bisa saja memangkas prefix mount sebelum sampai ke sini,
    // sementara router mencocokkan path lengkap ('/api/config').
    if (!(url.pathname === '/api' || url.pathname.startsWith('/api/'))) {
      url.pathname = '/api' + (url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`);
    }

    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const bodyBuffer = hasBody ? Buffer.from(await request.arrayBuffer()) : null;

    const router = loadRouter();
    const req = toNodeRequest(request, url, bodyBuffer);

    const handled = new Promise((resolve) => {
      const res = makeNodeResponse(resolve);
      router.handle(req, res);
    });

    let timer;
    const watchdog = new Promise((resolve) => {
      timer = setTimeout(() => resolve(json(504, {
        error: `Permintaan tidak selesai dalam ${Math.round(WATCHDOG_MS / 1000)} detik.`,
        path: url.pathname,
        hint: 'Cek DATABASE_URL (Neon) dan keterjangkauan jaringan dari function.',
      })), WATCHDOG_MS);
    });

    const response = await Promise.race([handled, watchdog]);
    clearTimeout(timer);
    return response;
  } catch (e) {
    // Termasuk kegagalan import lib/: lebih baik terbaca sebagai 500 daripada
    // hilang sebagai timeout tanpa jejak.
    return json(500, { error: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 4) });
  }
}
