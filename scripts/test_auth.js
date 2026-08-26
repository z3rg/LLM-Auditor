#!/usr/bin/env node
'use strict';
/**
 * Uji regresi LLM Auditor: lapisan data Blob + alur autentikasi end-to-end.
 *
 *   npm run test:auth
 *
 * Menjalankan server sungguhan di atas direktori Blob LOKAL yang sementara,
 * lalu memanggil API lewat HTTP seperti browser. Tidak butuh kredensial apa
 * pun — tidak ada database, tidak memanggil DeepSeek/Gemini.
 *
 * Berbeda dari versi Postgres: dulu uji ini menuntut TEST_DATABASE_URL dan
 * MENGOSONGKAN seluruh tabel di sana. Sekarang datanya hidup di direktori temp
 * yang dibuat dan dihapus sendiri, jadi tidak ada lagi cara untuk keliru
 * menghapus data sungguhan.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3116);
const BASE = `http://127.0.0.1:${PORT}`;
const SEED_PASSWORD = 'Auditor#2026';

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(` GAGAL ${label}${detail ? ` — ${detail}` : ''}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** fetch yang membawa cookie per-"browser". */
function agent() {
  const jar = new Map();
  return {
    cookies: jar,
    async call(pathname, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (options.body) headers['content-type'] = 'application/json';
      const res = await fetch(BASE + pathname, { ...options, headers, redirect: 'manual' });
      for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (/Max-Age=0/i.test(raw) || !value) jar.delete(name); else jar.set(name, value);
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* bukan JSON */ }
      return { status: res.status, json, text, headers: res.headers };
    },
  };
}

async function waitForServer(child, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`server keluar lebih awal (kode ${child.exitCode})`);
    try {
      const res = await fetch(`${BASE}/api/auth/divisions`);
      if (res.ok) return;
    } catch (_) { /* belum siap */ }
    await sleep(150);
  }
  throw new Error('server tidak siap dalam batas waktu');
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-auditor-test-'));
  const env = {
    ...process.env,
    BLOB_LOCAL_DIR: dir,
    EDGEONE_PROJECT_ID: '', EDGEONE_BLOB_TOKEN: '',
    SEED_PASSWORD, PORT: String(PORT), COOKIE_SECURE: '0',
  };
  console.log(`\n  Blob sementara: ${dir}\n`);

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });

  try {
    await waitForServer(child);

    console.log('data awal');
    const anon = agent();
    const divs = await anon.call('/api/auth/divisions');
    ok(divs.status === 200 && divs.json.length === 8, `8 divisi tersedia pra-login (${divs.json && divs.json.length})`);
    const cfgAnon = await anon.call('/api/config');
    ok(cfgAnon.status === 401, 'endpoint terlindungi menolak anonim', `status ${cfgAnon.status}`);

    console.log('\nmasuk sebagai staf');
    const admin = agent();
    const bad = await admin.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@company.co.id', password: 'salah' }) });
    ok(bad.status === 401, 'kata sandi salah ditolak', `status ${bad.status}`);
    const login = await admin.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@company.co.id', password: SEED_PASSWORD }) });
    ok(login.status === 200 && login.json.user.role === 'super_admin', `super_admin masuk (${login.json && login.json.user && login.json.user.role})`);
    ok(admin.cookies.has('sid'), 'cookie sesi dipasang');
    const me = await admin.call('/api/auth/me');
    ok(me.status === 200 && me.json.user.email === 'admin@company.co.id', 'sesi bertahan antar-request');

    console.log('\nanalitik');
    const ov = await admin.call('/api/overview');
    ok(ov.status === 200 && ov.json.totals.employees === 32, `overview: ${ov.json && ov.json.totals && ov.json.totals.employees} peserta`);
    ok(ov.json.totals.attempts > 300, `attempt ter-seed: ${ov.json.totals.attempts}`);
    ok(Array.isArray(ov.json.byDivision) && ov.json.byDivision.length === 8, 'ringkasan per divisi lengkap');
    const gaps = await admin.call('/api/gaps/division?id=2');
    ok(gaps.status === 200 && gaps.json.topics.length === 10, `gap divisi: ${gaps.json && gaps.json.topics && gaps.json.topics.length} topik`);
    ok(gaps.json.gaps.length > 0, `gap terdeteksi di divisi IT: ${gaps.json.gaps.map((g) => g.topic).join(', ')}`);
    const trend = await admin.call('/api/trend');
    ok(trend.status === 200 && trend.json.overall.length > 0, `tren: ${trend.json && trend.json.overall && trend.json.overall.length} bulan`);

    console.log('\npendaftaran peserta');
    const peserta = agent();
    const reg = await peserta.call('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Peserta Uji', email: 'peserta.uji@company.co.id', password: 'rahasia123', division_id: 2 }),
    });
    ok(reg.status === 201, `pendaftaran diterima (status ${reg.status})`, reg.json && reg.json.error);
    ok(reg.json.user && reg.json.user.role === 'employee', 'peran baru selalu employee, bukan pilihan klien');
    const dup = await agent().call('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Peserta Lain', email: 'PESERTA.UJI@company.co.id', password: 'rahasia123', division_id: 2 }),
    });
    ok(dup.status === 409, `email ganda ditolak tanpa memandang huruf besar-kecil (status ${dup.status})`);

    console.log('\nkontrol peran');
    const curr = await peserta.call('/api/participant/curriculum');
    ok(curr.status === 200 && curr.json.totalTopics === 10, `kurikulum peserta: ${curr.json && curr.json.totalTopics} topik`);
    const forbidden = await peserta.call('/api/admin/users');
    ok(forbidden.status === 403, 'peserta tidak bisa membaca daftar akun', `status ${forbidden.status}`);
    const accounts = await admin.call('/api/admin/users');
    const users = (accounts.json && accounts.json.users) || [];
    ok(accounts.status === 200 && users.length >= 4, `super admin melihat ${users.length} akun`);
    const target = users.find((a) => a.email === 'peserta.uji@company.co.id');
    ok(!!target && target.active_sessions === 1, `sesi aktif peserta terhitung: ${target && target.active_sessions}`);

    console.log('\nubah peran & status (rute STATIS — bentuk yang dipakai produksi)');
    // Sengaja memakai /api/admin/users/role, bukan /api/admin/users/<id>/role:
    // segmen dinamis berupa direktori tidak didaftarkan EdgeOne, dan uji yang
    // memakai bentuk lama akan lulus di lokal sambil produksi 404.
    const promote = await admin.call('/api/admin/users/role', { method: 'POST', body: JSON.stringify({ id: target.id, role: 'auditor' }) });
    ok(promote.status === 200 && promote.json.user.role === 'auditor', 'peran dinaikkan jadi auditor');
    const suspend = await admin.call('/api/admin/users/status', { method: 'POST', body: JSON.stringify({ id: target.id, status: 'suspended' }) });
    ok(suspend.status === 200, 'akun ditangguhkan');
    const afterSuspend = await peserta.call('/api/auth/me');
    ok(afterSuspend.status === 401, 'penangguhan langsung mencabut sesi', `status ${afterSuspend.status}`);

    console.log('\nrekomendasi & acknowledge');
    const recRes = await admin.call('/api/recommendations', {
      method: 'POST',
      body: JSON.stringify({
        scope_type: 'division', scope_ref: 2, scope_label: 'IT',
        title: 'Rekomendasi uji', recommendation: '## Isi rekomendasi uji',
        recommended_topics: ['Network Security'], model: 'uji',
      }),
    });
    ok(recRes.status === 201 && recRes.json.id, `rekomendasi dibuat (id ${recRes.json && recRes.json.id})`);
    ok((recRes.json.recommendation || '').length > 0, 'isi rekomendasi tersimpan, tidak kosong');
    const empty = await admin.call('/api/recommendations', {
      method: 'POST',
      body: JSON.stringify({ scope_type: 'division', scope_ref: 2, title: 'Kosong', recommendation: '   ' }),
    });
    ok(empty.status === 400, `rekomendasi tanpa isi ditolak (status ${empty.status})`);

    const direktur = agent();
    await direktur.call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'director@company.co.id', password: SEED_PASSWORD }) });
    const notDirector = await admin.call('/api/recommendations/acknowledge', { method: 'POST', body: JSON.stringify({ id: recRes.json.id }) });
    ok(notDirector.status === 403, 'hanya Direktur yang boleh acknowledge');
    const ack = await direktur.call('/api/recommendations/acknowledge', {
      method: 'POST', body: JSON.stringify({ id: recRes.json.id, ack_note: 'setuju' }),
    });
    ok(ack.status === 200 && ack.json.status === 'acknowledged', `acknowledge berhasil (${ack.json && ack.json.status})`);
    ok(ack.json.ack_by === 'Direktur Utama' && ack.json.ack_note === 'setuju', 'nama & catatan direktur tercatat');
    const missing = await direktur.call('/api/recommendations/acknowledge', { method: 'POST', body: JSON.stringify({ id: 999 }) });
    ok(missing.status === 404, `id tidak dikenal -> 404 JSON (status ${missing.status})`);

    console.log('\nthrottle login');
    let blocked = 0;
    for (let i = 0; i < 10; i++) {
      const r = await agent().call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'director@company.co.id', password: 'salah' }) });
      if (r.status === 429) blocked++;
    }
    ok(blocked > 0, `percobaan berulang akhirnya diblokir (${blocked}x status 429)`);

    console.log('\nkeluar');
    const out = await admin.call('/api/auth/logout', { method: 'POST' });
    ok(out.status === 200, 'logout berhasil');
    ok((await admin.call('/api/auth/me')).status === 401, 'sesi mati setelah logout');
  } catch (e) {
    fail++;
    console.log(`\n GAGAL  ${e.message}`);
    if (serverLog) console.log(`\n--- log server ---\n${serverLog.slice(-1500)}`);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n  ${pass} lulus, ${fail} gagal\n`);
  process.exit(fail ? 1 : 0);
})();
