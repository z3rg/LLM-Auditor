/**
 * Jembatan privat: context EdgeOne Makers Agents -> router lib/api.js.
 *
 * Berkas berawalan "_" tidak diekspos sebagai rute (konvensi agents), jadi ini
 * murni modul bersama yang dipakai seluruh berkas di agents/api/. Polanya sama
 * dengan agents/api/_proxy.ts pada template deepseek-harness: satu modul privat
 * mengerjakan semuanya, berkas rute hanya meneruskan.
 *
 * Kenapa agents/ menggantikan cloud-functions/:
 *   · Cloud Functions mem-bundle tiap function jadi satu /var/user/index.mjs,
 *     dan bundler-nya menyerah pada graf modul lib/ — itulah yang memaksa
 *     scripts/build_function.sh mem-bundle sendiri lewat esbuild, dan artefak
 *     hasilnya tetap ditolak builder.
 *   · Runtime agents menjalankan berkas ini sebagai modul Node biasa dengan
 *     node_modules terpasang. Import relatif ke ../lib/ tetap import relatif,
 *     dan dependency runtime cukup didaftarkan di edgeone.json ->
 *     agents.externalNodeModules. Tidak ada langkah bundle sama sekali.
 *
 * Tiga sifat yang disengaja dipertahankan dari entri lama:
 *   1. Bentuk `onRequest(context) -> Response`, bukan instance Express.
 *      Deploy Express selalu berakhir "Invoking task timed out" tanpa stack.
 *   2. Ada watchdog: apa pun yang menggantung dibalas 504 berisi keterangan
 *      sebelum platform memotongnya tanpa jejak.
 *   3. Tanpa dependency framework. Body dibaca sekali lalu dialirkan ulang.
 */
import { Readable } from 'node:stream';

// Di-resolusi sebagai import relatif biasa oleh runtime agents.
import apiRouter from '../lib/api.js';

// SDK Blob TIDAK di-import di sini. lib/blob.js me-require-nya secara malas
// saat operasi pertama, dan paketnya dijamin ada di runtime lewat
// edgeone.json -> agents.externalNodeModules. Import di sini hanya akan
// memindahkan kegagalan resolusi ke waktu muat modul, di mana pesannya hilang.

// Batas aman di bawah agents.timeout (300 detik), agar penyebabnya masih terlihat.
const WATCHDOG_MS = Number(process.env.FUNCTION_WATCHDOG_MS || 280_000);

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Header sebagai objek datar berkunci huruf kecil.
 * Runtime agents memberi objek biasa; runtime lain memberi Headers. Terima
 * keduanya daripada berasumsi — lib/api.js membaca req.headers.cookie dan
 * req.headers['x-filename'].
 */
function headerBag(request) {
  const h = request?.headers;
  if (!h) return {};
  if (typeof h.forEach === 'function' && typeof h.get === 'function') {
    const out = {};
    h.forEach((value, name) => { out[String(name).toLowerCase()] = value; });
    return out;
  }
  const out = {};
  for (const [name, value] of Object.entries(h)) {
    out[String(name).toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * URL permintaan, dinormalkan ke path lengkap yang dicocokkan lib/api.js.
 * context.request.url bisa berupa URL absolut ATAU path saja, dan query bisa
 * datang terpisah lewat context.request.query.
 */
function requestUrl(context) {
  const raw = typeof context.request?.url === 'string' && context.request.url
    ? context.request.url
    : '/api';
  const url = new URL(raw, 'http://makers.local');

  if (!url.search) {
    const query = context.request?.query;
    if (query && typeof query === 'object' && !Array.isArray(query)) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
        else url.searchParams.set(key, String(value));
      }
    }
  }

  // Platform bisa memangkas prefix mount sebelum sampai ke sini, sementara
  // router mencocokkan path lengkap ('/api/config').
  if (!(url.pathname === '/api' || url.pathname.startsWith('/api/'))) {
    url.pathname = '/api' + (url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`);
  }
  return url;
}

/** Body permintaan sebagai Buffer mentah, atau null bila tidak ada. */
async function requestBody(context) {
  const request = context.request;
  const method = String(request?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;

  // Jalur yang diutamakan: unggahan PDF mengirim byte application/pdf mentah,
  // dan hanya arrayBuffer() yang menjamin byte-nya tidak lewat decoder teks.
  if (typeof request?.arrayBuffer === 'function') {
    try {
      const bytes = Buffer.from(await request.arrayBuffer());
      if (bytes.length) return bytes;
    } catch (_) { /* body sudah dikonsumsi runtime; pakai request.body */ }
  }

  const body = request?.body;
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (typeof body.getReader === 'function') {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  // Runtime agents mem-parse body JSON lebih dulu; susun ulang jadi byte
  // karena lib/api.js membacanya sendiri sebagai stream.
  try { return Buffer.from(JSON.stringify(body), 'utf8'); } catch (_) { return null; }
}

/** Request Fetch -> objek mirip IncomingMessage yang dipahami lib/api.js. */
function toNodeRequest(context, url, bodyBuffer) {
  const req = Readable.from(bodyBuffer && bodyBuffer.length ? [bodyBuffer] : []);
  req.method = String(context.request?.method || 'GET').toUpperCase();
  req.url = url.pathname + url.search;
  req.headers = headerBag(context.request);
  // lib/api.js menyusun URL dari req.headers.host.
  if (!req.headers.host) req.headers.host = url.host;
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

/**
 * Salin variabel dari context.env ke process.env.
 *
 * Konfigurasi project Makers sampai ke agent lewat context.env, sedangkan
 * seluruh lib/ membaca process.env (dan harus tetap begitu — server.js lokal,
 * skrip db:setup, dan skrip ingest Python memakai jalur yang sama). Nilai yang
 * sudah ada tidak pernah ditimpa, sama seperti lib/env.js.
 */
function adoptEnv(context) {
  const env = context?.env;
  if (!env || typeof env !== 'object') return;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Entri tunggal untuk seluruh berkas rute di agents/api/. */
export async function handleApi(context) {
  if (!context?.request) return json(500, { error: 'Request tidak ditemukan pada context agent.' });

  try {
    adoptEnv(context);
    const url = requestUrl(context);
    const bodyBuffer = await requestBody(context);
    const req = toNodeRequest(context, url, bodyBuffer);

    const handled = new Promise((resolve) => {
      const res = makeNodeResponse(resolve);
      apiRouter.handle(req, res);
    });

    let timer;
    const watchdog = new Promise((resolve) => {
      timer = setTimeout(() => resolve(json(504, {
        error: `Permintaan tidak selesai dalam ${Math.round(WATCHDOG_MS / 1000)} detik.`,
        path: url.pathname,
        hint: 'Cek MAKERS_MODELS_KEY dan keterjangkauan EdgeOne Blob dari agent.',
      })), WATCHDOG_MS);
    });

    const response = await Promise.race([handled, watchdog]);
    clearTimeout(timer);
    return response;
  } catch (e) {
    // Termasuk kegagalan resolusi lib/: lebih baik terbaca sebagai 500
    // daripada hilang sebagai timeout tanpa jejak.
    return json(500, {
      error: String((e && e.message) || e),
      stack: String((e && e.stack) || '').split('\n').slice(0, 4),
    });
  }
}

export default { handleApi };
