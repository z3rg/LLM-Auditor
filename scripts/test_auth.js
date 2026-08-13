'use strict';
/**
 * Uji regresi alur autentikasi: sesi, kontrol peran, pendaftaran, administrasi
 * akun, throttle login, dan perilaku atribut cookie `Secure`.
 *
 *   npm run test:auth
 *
 * Menjalankan server sungguhan di port 3116-3118 memakai salinan database.
 * Tidak memanggil Groq/Gemini, jadi tidak butuh API key.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Berjalan di atas SALINAN database (lewat DB_PATH), sehingga data/auditor.db
// yang dilacak git tidak pernah tersentuh oleh pengujian.
const ROOT = path.join(__dirname, '..');
const TEST_DB = path.join(os.tmpdir(), `llm-auditor-uji-${process.pid}.db`);

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

function startServer(port, env = {}) {
  const child = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DB_PATH: TEST_DB, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server timeout:\n' + out)), 40000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('LLM Auditor running')) { clearTimeout(t); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`server exit ${c}:\n${out}`)); });
  });
}

async function req(base, method, p, { body, cookie, headers = {} } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data, setCookie: r.headers.get('set-cookie') || '' };
}
const sidOf = (setCookie) => (setCookie.match(/sid=([^;]+)/) || [])[1];

(async () => {
  // DB uji = salinan, agar data/auditor.db yang dilacak git tidak berubah.
  fs.copyFileSync(path.join(ROOT, 'data', 'auditor.db'), TEST_DB);

  // ---------------------------------------------------------------- HTTP biasa
  const B = 'http://localhost:3116';
  let srv = await startServer(3116);
  try {
    // --- atribut cookie
    let r = await req(B, 'POST', '/api/auth/login', { body: { email: 'admin@company.co.id', password: 'Auditor#2026' } });
    check('login super admin berhasil', r.status === 200 && r.data.user.role === 'super_admin', `status ${r.status}`);
    check('HTTP polos: cookie TANPA Secure (localhost tetap bisa login)', !/;\s*Secure/i.test(r.setCookie));
    check('cookie tetap HttpOnly + SameSite=Lax', /HttpOnly/i.test(r.setCookie) && /SameSite=Lax/i.test(r.setCookie));
    const adminCookie = `sid=${sidOf(r.setCookie)}`;

    r = await req(B, 'POST', '/api/auth/login', {
      body: { email: 'auditor@company.co.id', password: 'Auditor#2026' },
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    check('di balik proxy HTTPS: cookie BER-Secure', /;\s*Secure/i.test(r.setCookie), r.setCookie.slice(0, 70));
    const auditorCookie = `sid=${sidOf(r.setCookie)}`;

    r = await req(B, 'POST', '/api/auth/logout', { cookie: adminCookie, headers: { 'X-Forwarded-Proto': 'https' } });
    check('logout mencerminkan atribut yang sama (Secure + Max-Age=0)', /;\s*Secure/i.test(r.setCookie) && /Max-Age=0/.test(r.setCookie));
    r = await req(B, 'GET', '/api/auth/me', { cookie: adminCookie });
    check('sesi benar-benar mati setelah logout', r.status === 401);

    // --- login ulang untuk sisa pengujian
    r = await req(B, 'POST', '/api/auth/login', { body: { email: 'admin@company.co.id', password: 'Auditor#2026' } });
    const admin = `sid=${sidOf(r.setCookie)}`;

    // --- gerbang sesi & peran
    check('tanpa sesi: /api/overview ditolak 401', (await req(B, 'GET', '/api/overview')).status === 401);
    check('kata sandi salah ditolak 401', (await req(B, 'POST', '/api/auth/login', { body: { email: 'admin@company.co.id', password: 'salah' } })).status === 401);
    r = await req(B, 'GET', '/api/auth/me', { cookie: admin });
    check('/api/auth/me mengenali akun', r.status === 200 && r.data.user.email === 'admin@company.co.id');
    r = await req(B, 'GET', '/api/overview', { cookie: admin });
    check('super admin membaca analitik', r.status === 200 && r.data.totals.attempts === 391, `attempts ${r.data?.totals?.attempts}`);

    // --- pendaftaran
    const email = `uji.${Date.now()}@company.co.id`;
    r = await req(B, 'POST', '/api/auth/register', { body: { name: 'Peserta Uji', email, password: 'Sandi2026', division_id: 1 } });
    check('pendaftaran membuat akun peserta + sesi', r.status === 201 && r.data.user.role === 'employee' && !!sidOf(r.setCookie));
    const peserta = `sid=${sidOf(r.setCookie)}`;
    const pesertaId = r.data.user.id;
    check('email duplikat ditolak 409', (await req(B, 'POST', '/api/auth/register', { body: { name: 'Ganda', email: email.toUpperCase(), password: 'Sandi2026', division_id: 1 } })).status === 409);
    check('kata sandi lemah ditolak 400', (await req(B, 'POST', '/api/auth/register', { body: { name: 'Lemah', email: `x${Date.now()}@c.id`, password: 'pendek', division_id: 1 } })).status === 400);
    check('kata sandi tanpa angka ditolak 400', (await req(B, 'POST', '/api/auth/register', { body: { name: 'Tanpa Angka', email: `y${Date.now()}@c.id`, password: 'sandipanjang', division_id: 1 } })).status === 400);

    // --- batas peran peserta
    check('peserta ditolak dari analitik (403)', (await req(B, 'GET', '/api/overview', { cookie: peserta })).status === 403);
    check('peserta ditolak dari SQL Agent (403)', (await req(B, 'POST', '/api/sql-agent', { cookie: peserta, body: { question: 'x' } })).status === 403);
    check('peserta ditolak dari admin users (403)', (await req(B, 'GET', '/api/admin/users', { cookie: peserta })).status === 403);
    r = await req(B, 'GET', '/api/participant/curriculum?id=1', { cookie: peserta });
    check('peserta tidak bisa menyamar lewat ?id=', r.status === 200 && r.data.employee.id === pesertaId, `dapat id ${r.data?.employee?.id}, seharusnya ${pesertaId}`);
    r = await req(B, 'GET', '/api/participant/curriculum?id=' + pesertaId, { cookie: auditorCookie });
    check('staf boleh menengok kurikulum peserta lain', r.status === 200 && r.data.employee.id === pesertaId);

    // --- kepemilikan sesi kuis (sisip langsung ke DB, tanpa memanggil Groq)
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(TEST_DB);
    const payload = JSON.stringify([{ question: 'q', options: ['a', 'b'], answer_index: 0, explanation: '' }]);
    const orang_lain = db.prepare("SELECT id FROM employees WHERE role='employee' AND id <> ? LIMIT 1").get(pesertaId).id;
    const sesiOrangLain = Number(db.prepare(
      "INSERT INTO quiz_sessions (employee_id, topic_id, payload, num_questions, model, created_at) VALUES (?, 1, ?, 1, 'uji', datetime('now'))"
    ).run(orang_lain, payload).lastInsertRowid);
    db.close();
    r = await req(B, 'POST', '/api/quiz/submit', { cookie: peserta, body: { session_id: sesiOrangLain, answers: [0] } });
    check('tidak bisa mengumpulkan sesi kuis milik orang lain (403)', r.status === 403, `status ${r.status}`);

    // --- administrasi akun
    r = await req(B, 'GET', '/api/admin/users', { cookie: admin });
    check('super admin melihat daftar akun', r.status === 200 && Array.isArray(r.data.users));
    check('super admin tidak bisa menurunkan perannya sendiri', (await req(B, 'POST', `/api/admin/users/${r.data.users.find((u) => u.role === 'super_admin').id}/role`, { cookie: admin, body: { role: 'employee' } })).status === 400);
    check('peran tidak dikenal ditolak', (await req(B, 'POST', `/api/admin/users/${pesertaId}/role`, { cookie: admin, body: { role: 'dewa' } })).status === 400);
    r = await req(B, 'POST', `/api/admin/users/${pesertaId}/role`, { cookie: admin, body: { role: 'auditor' } });
    check('naik peran ke auditor', r.status === 200 && r.data.user.role === 'auditor');
    check('peserta yang naik peran kini boleh membaca analitik', (await req(B, 'GET', '/api/overview', { cookie: peserta })).status === 200);
    r = await req(B, 'POST', `/api/admin/users/${pesertaId}/status`, { cookie: admin, body: { status: 'disabled' } });
    check('nonaktifkan akun', r.status === 200 && r.data.user.status === 'disabled');
    check('sesi akun nonaktif langsung dicabut', (await req(B, 'GET', '/api/auth/me', { cookie: peserta })).status === 401);
    check('akun nonaktif tidak bisa login (403)', (await req(B, 'POST', '/api/auth/login', { body: { email, password: 'Sandi2026' } })).status === 403);

    // --- ganti kata sandi
    check('ganti sandi dengan sandi lama salah ditolak', (await req(B, 'POST', '/api/auth/password', { cookie: admin, body: { current_password: 'salah', new_password: 'Baru12345' } })).status === 401);
    check('sandi baru lemah ditolak', (await req(B, 'POST', '/api/auth/password', { cookie: admin, body: { current_password: 'Auditor#2026', new_password: 'lemah' } })).status === 400);
    check('ganti sandi berhasil', (await req(B, 'POST', '/api/auth/password', { cookie: admin, body: { current_password: 'Auditor#2026', new_password: 'SandiBaru2026' } })).status === 200);
    check('login memakai sandi baru', (await req(B, 'POST', '/api/auth/login', { body: { email: 'admin@company.co.id', password: 'SandiBaru2026' } })).status === 200);
    check('sandi lama tidak berlaku lagi', (await req(B, 'POST', '/api/auth/login', { body: { email: 'admin@company.co.id', password: 'Auditor#2026' } })).status === 401);

    // --- throttle
    const emailThrottle = `throttle.${Date.now()}@company.co.id`;
    for (let i = 0; i < 8; i++) await req(B, 'POST', '/api/auth/login', { body: { email: emailThrottle, password: 'salah' } });
    check('login dibatasi setelah 8 percobaan gagal (429)', (await req(B, 'POST', '/api/auth/login', { body: { email: emailThrottle, password: 'salah' } })).status === 429);

    // --- pra-login & statis
    check('daftar divisi bisa diambil sebelum login', (await req(B, 'GET', '/api/auth/divisions')).status === 200);
    for (const aset of ['/', '/auth.css', '/styles.css', '/app.js']) {
      const rr = await fetch(B + aset);
      check(`aset statis ${aset} tersaji`, rr.status === 200);
    }
    // Yang harus bersih adalah layar masuk itu sendiri. Nama peran masih ada di
    // markup shell dashboard (tersembunyi sampai login) — itu isi produk, bukan
    // bagian dari halaman masuk.
    const html = await (await fetch(B + '/')).text();
    const blokAuth = (html.match(/<div id="auth"[\s\S]*?<!-- ============ APP/) || [''])[0];
    check('layar masuk bersih dari struktur peran',
      blokAuth.length > 1000 && !/Matriks akses|Super Admin|IT Auditor|Direktur|super_admin/.test(blokAuth));
  } finally { srv.kill(); await new Promise((r) => setTimeout(r, 500)); }

  // ---------------------------------------------------- COOKIE_SECURE memaksa
  srv = await startServer(3117, { COOKIE_SECURE: '1' });
  try {
    const r = await req('http://localhost:3117', 'POST', '/api/auth/login', { body: { email: 'auditor@company.co.id', password: 'Auditor#2026' } });
    check('COOKIE_SECURE=1 memaksa Secure walau lewat HTTP', /;\s*Secure/i.test(r.setCookie));
  } finally { srv.kill(); await new Promise((r) => setTimeout(r, 500)); }

  srv = await startServer(3118, { COOKIE_SECURE: '0' });
  try {
    const r = await req('http://localhost:3118', 'POST', '/api/auth/login', {
      body: { email: 'auditor@company.co.id', password: 'Auditor#2026' },
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    check('COOKIE_SECURE=0 menang atas header proxy', !/;\s*Secure/i.test(r.setCookie));
  } finally { srv.kill(); }

  console.log(results.join('\n'));
  console.log(`\n  ${pass} lulus, ${fail} gagal`);
  fs.rmSync(TEST_DB, { force: true });
  ['-wal', '-shm'].forEach((s) => fs.rmSync(TEST_DB + s, { force: true }));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('GAGAL MENJALANKAN:', e.message); process.exit(2); });
