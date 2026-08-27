'use strict';
/**
 * Router JSON API LLM Auditor — bebas framework.
 *
 * Dipisahkan dari server.js supaya dua entri bisa memakai handler yang sama:
 *   · cloud-functions/api/[[default]].js — EdgeOne Makers (Express)
 *   · server.js                          — node:http untuk dev lokal
 *
 * Handler hanya bergantung pada bentuk req/res bawaan Node (method, url,
 * headers, writeHead/end), yang juga dipenuhi objek Express.
 */
require('./env').loadEnv();

const db = require('./db');
const ai = require('./ai');
const auth = require('./auth');

// --- helpers ---------------------------------------------------------------
function sendJson(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
    });
  });
}
/** Bentuk publik sebuah akun — tidak pernah membocorkan password_hash. */
function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    division: u.division, divisionId: u.divisionId, status: u.status,
  };
}
const isSuper = (u) => u.role === 'super_admin';
const isStaff = (u) => auth.STAFF_ROLES.includes(u.role);

/** Kurangi k bulan dari string 'YYYY-MM'. */
function monthMinus(ym, k) {
  let [y, m] = ym.split('-').map(Number);
  m -= k;
  while (m <= 0) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Susun payload gap yang dibutuhkan helper AI, dari {scope_type, scope_ref}. */
async function resolveGapData(body) {
  const ref = Number(body.scope_ref);
  if (body.scope_type === 'employee') {
    const g = await db.employeeGaps(ref);
    if (!g) return null;
    return { scopeType: 'employee', label: g.employee.name, refId: ref, ...g };
  }
  if (body.scope_type === 'division') {
    const g = await db.divisionGaps(ref);
    if (!g) return null;
    return { scopeType: 'division', label: g.division.name, refId: ref, ...g };
  }
  return null;
}

// --- rute publik (pra-login) ------------------------------------------------
/** Menangani endpoint yang bisa dicapai tanpa sesi. Mengembalikan true bila
 *  request sudah dijawab, false bila pemanggil harus melanjutkan routing. */
async function publicApi(req, res, p) {
  // Daftar divisi dibutuhkan formulir pendaftaran, sebelum ada sesi.
  if (req.method === 'GET' && p === '/api/auth/divisions') {
    sendJson(res, 200, await db.listDivisions());
    return true;
  }

  if (req.method === 'POST' && p === '/api/auth/register') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const divisionId = Number(body.division_id) || null;
    const errors = await auth.validateRegistration({ name, email, password, divisionId });
    if (errors.length) { sendJson(res, 400, { error: errors[0], errors }); return true; }
    if (await db.findUserByEmail(email)) {
      sendJson(res, 409, { error: 'Email ini sudah terdaftar. Masuk dengan kata sandi Anda.' });
      return true;
    }
    const user = await db.createUser({
      name, email, divisionId, role: 'employee',
      passwordHash: auth.hashPassword(password),
    });
    const { token, expires } = await auth.startSession(user.id, req.headers['user-agent']);
    sendJson(res, 201, { user: publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(token, expires, auth.isSecureRequest(req)) });
    return true;
  }

  if (req.method === 'POST' && p === '/api/auth/login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) { sendJson(res, 400, { error: 'Isi email dan kata sandi.' }); return true; }
    if (await auth.throttled(email)) {
      sendJson(res, 429, { error: 'Terlalu banyak percobaan gagal. Coba lagi dalam 10 menit.' });
      return true;
    }
    const user = await db.findUserByEmail(email);
    if (!user || !user.password_hash || !auth.verifyPassword(password, user.password_hash)) {
      await auth.noteFailure(email);
      sendJson(res, 401, { error: 'Email atau kata sandi salah.' });
      return true;
    }
    if (user.status !== 'active') {
      sendJson(res, 403, { error: 'Akun ini dinonaktifkan. Hubungi Super Admin.' });
      return true;
    }
    await auth.clearFailures(email);
    const { token, expires } = await auth.startSession(user.id, req.headers['user-agent']);
    sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(token, expires, auth.isSecureRequest(req)) });
    return true;
  }

  return false; // bukan rute publik
}

// --- rute API ---------------------------------------------------------------
async function api(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  // Endpoint pra-login -------------------------------------------------------
  if (p.startsWith('/api/auth/') && await publicApi(req, res, p)) return;

  // Semua di bawah ini butuh sesi yang sah -----------------------------------
  const user = await auth.currentUser(req);
  if (!user) {
    if (req.method === 'GET' && p === '/api/auth/me') return sendJson(res, 401, { error: 'Belum masuk.' });
    return sendJson(res, 401, { error: 'Sesi berakhir. Masuk kembali untuk melanjutkan.' });
  }

  if (req.method === 'GET' && p === '/api/auth/me') return sendJson(res, 200, { user: publicUser(user) });
  if (req.method === 'POST' && p === '/api/auth/logout') {
    await auth.endSession(auth.readCookie(req, 'sid'));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(auth.isSecureRequest(req)) });
  }
  if (req.method === 'POST' && p === '/api/auth/password') {
    const body = await readBody(req);
    const current = String(body.current_password || '');
    const next = String(body.new_password || '');
    const full = await db.findUserByEmail(user.email);
    if (!full || !auth.verifyPassword(current, full.password_hash)) {
      return sendJson(res, 401, { error: 'Kata sandi saat ini salah.' });
    }
    if (next.length < 8 || !/\d/.test(next)) {
      return sendJson(res, 400, { error: 'Kata sandi baru minimal 8 karakter dan memuat satu angka.' });
    }
    await db.setPassword(user.id, auth.hashPassword(next));
    return sendJson(res, 200, { ok: true });
  }

  // Administrasi akun (Super Admin) ------------------------------------------
  if (req.method === 'GET' && p === '/api/admin/users') {
    if (!isSuper(user)) return sendJson(res, 403, { error: 'Hanya Super Admin.' });
    return sendJson(res, 200, { users: await db.listAccounts(), roles: auth.ROLES });
  }
  // Rute STATIS: id ada di body, bukan di path.
  //
  // Routing berbasis berkas EdgeOne TIDAK mendaftarkan segmen dinamis berupa
  // DIREKTORI (agents/api/**/[id]/berkas.js) — path seperti
  // /api/admin/users/1/role menjawab 404 HTML dari platform, tidak pernah
  // sampai ke router ini. Bentuk path lama tetap dilayani di bawah supaya dev
  // lokal dan klien lama tidak patah.
  if (req.method === 'POST' && p === '/api/admin/users/role') {
    if (!isSuper(user)) return sendJson(res, 403, { error: 'Hanya Super Admin.' });
    const body = await readBody(req);
    const id = Number(body.id);
    if (!id) return sendJson(res, 400, { error: 'id wajib diisi.' });
    if (!auth.ROLES.includes(body.role)) return sendJson(res, 400, { error: 'Peran tidak dikenal.' });
    if (id === user.id) return sendJson(res, 400, { error: 'Tidak dapat mengubah peran akun sendiri.' });
    const updated = await db.setUserRole(id, body.role);
    if (!updated) return sendJson(res, 404, { error: 'Akun tidak ditemukan.' });
    return sendJson(res, 200, { user: updated });
  }
  if (req.method === 'POST' && p === '/api/admin/users/status') {
    if (!isSuper(user)) return sendJson(res, 403, { error: 'Hanya Super Admin.' });
    const body = await readBody(req);
    const id = Number(body.id);
    if (!id) return sendJson(res, 400, { error: 'id wajib diisi.' });
    if (!['active', 'suspended'].includes(body.status)) return sendJson(res, 400, { error: 'Status tidak dikenal.' });
    if (id === user.id) return sendJson(res, 400, { error: 'Tidak dapat menonaktifkan akun sendiri.' });
    const updated = await db.setUserStatus(id, body.status);
    if (!updated) return sendJson(res, 404, { error: 'Akun tidak ditemukan.' });
    return sendJson(res, 200, { user: updated });
  }
  if (req.method === 'POST' && p === '/api/recommendations/acknowledge') {
    if (user.role !== 'director') return sendJson(res, 403, { error: 'Hanya Direktur yang dapat acknowledge.' });
    const body = await readBody(req);
    const id = Number(body.id);
    if (!id) return sendJson(res, 400, { error: 'id wajib diisi.' });
    const rec = await db.acknowledgeRecommendation(id, user.name, body.ack_note);
    if (!rec) return sendJson(res, 404, { error: 'Rekomendasi tidak ditemukan.' });
    return sendJson(res, 200, rec);
  }

  if (req.method === 'POST' && /^\/api\/admin\/users\/\d+\/role$/.test(p)) {
    if (!isSuper(user)) return sendJson(res, 403, { error: 'Hanya Super Admin.' });
    const id = Number(p.split('/')[4]);
    const body = await readBody(req);
    if (!auth.ROLES.includes(body.role)) return sendJson(res, 400, { error: 'Peran tidak dikenal.' });
    if (id === user.id && body.role !== 'super_admin') {
      return sendJson(res, 400, { error: 'Anda tidak dapat menurunkan peran akun Anda sendiri.' });
    }
    const updated = await db.setUserRole(id, body.role);
    if (!updated) return sendJson(res, 404, { error: 'Akun tidak ditemukan.' });
    return sendJson(res, 200, { user: publicUser(updated) });
  }
  if (req.method === 'POST' && /^\/api\/admin\/users\/\d+\/status$/.test(p)) {
    if (!isSuper(user)) return sendJson(res, 403, { error: 'Hanya Super Admin.' });
    const id = Number(p.split('/')[4]);
    const body = await readBody(req);
    const status = body.status === 'active' ? 'active' : 'disabled';
    if (id === user.id) return sendJson(res, 400, { error: 'Anda tidak dapat menonaktifkan akun Anda sendiri.' });
    const updated = await db.setUserStatus(id, status);
    if (!updated) return sendJson(res, 404, { error: 'Akun tidak ditemukan.' });
    return sendJson(res, 200, { user: publicUser(updated) });
  }

  // Analitik untuk staf; peserta hanya menjangkau data kuisnya sendiri.
  const STAFF_ONLY = ['/api/employees', '/api/overview', '/api/trend', '/api/gaps/employee',
    '/api/gaps/division', '/api/ai/recommendation', '/api/ai/quiz-topics'];
  if ((STAFF_ONLY.includes(p) || p === '/api/recommendations' || /^\/api\/recommendations\/\d+/.test(p)) && !isStaff(user)) {
    return sendJson(res, 403, { error: 'Peran Anda tidak memiliki akses ke data ini.' });
  }

  // Data referensi -----------------------------------------------------------
  if (req.method === 'GET' && p === '/api/divisions') return sendJson(res, 200, await db.listDivisions());
  if (req.method === 'GET' && p === '/api/topics') return sendJson(res, 200, await db.listTopics());
  if (req.method === 'GET' && p === '/api/employees') return sendJson(res, 200, await db.listEmployees());
  if (req.method === 'GET' && p === '/api/overview') return sendJson(res, 200, await db.overviewStats());

  if (req.method === 'GET' && p === '/api/trend') {
    const divisionId = q.get('division') ? Number(q.get('division')) : null;
    const topicId = q.get('topic') ? Number(q.get('topic')) : null;
    const months = /^\d+$/.test(q.get('months') || '') ? Number(q.get('months')) : null;
    let overall = await db.scoreTrend({});
    let filtered = (divisionId || topicId) ? await db.scoreTrend({ divisionId, topicId }) : null;
    // Filter rentang waktu: sisakan `months` bulan kalender terakhir.
    if (months && overall.length) {
      const latest = overall[overall.length - 1].month;
      const cutoff = monthMinus(latest, months - 1); // 'YYYY-MM', bisa dibandingkan leksikografis
      overall = overall.filter((r) => r.month >= cutoff);
      if (filtered) filtered = filtered.filter((r) => r.month >= cutoff);
    }
    let label = 'Keseluruhan';
    if (divisionId) label = (await db.listDivisions()).find((d) => d.id === divisionId)?.name || 'Divisi';
    else if (topicId) label = (await db.listTopics()).find((t) => t.id === topicId)?.name || 'Topik';
    return sendJson(res, 200, { overall, filtered, label, months, gapThreshold: db.GAP_THRESHOLD });
  }

  if (req.method === 'GET' && p === '/api/config') {
    return sendJson(res, 200, {
      user: publicUser(user),
      model: ai.cfg().model,
      hasKey: !!ai.cfg().key,
      aiProvider: ai.cfg().providerLabel,
      gapThreshold: db.GAP_THRESHOLD,
      quizPlanned: await db.getBool('quiz_planned', true),
    });
  }

  // Pengaturan ---------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/settings') {
    return sendJson(res, 200, { quizPlanned: await db.getBool('quiz_planned', true) });
  }
  if (req.method === 'POST' && p === '/api/settings') {
    if (!isSuper(user)) return sendJson(res, 403, { error: 'Hanya Super Admin yang dapat mengubah pengaturan.' });
    const body = await readBody(req);
    if ('quizPlanned' in body) await db.setSetting('quiz_planned', body.quizPlanned ? '1' : '0');
    return sendJson(res, 200, { quizPlanned: await db.getBool('quiz_planned', true) });
  }

  // Analisis gap -------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/gaps/employee') {
    const data = await db.employeeGaps(Number(q.get('id')));
    if (!data) return sendJson(res, 404, { error: 'Employee not found' });
    return sendJson(res, 200, data);
  }
  if (req.method === 'GET' && p === '/api/gaps/division') {
    const data = await db.divisionGaps(Number(q.get('id')));
    if (!data) return sendJson(res, 404, { error: 'Division not found' });
    return sendJson(res, 200, data);
  }

  // Fitur 1: rekomendasi gap pengetahuan ------------------------------------
  if (req.method === 'POST' && p === '/api/ai/recommendation') {
    const body = await readBody(req);
    const gapData = await resolveGapData(body);
    if (!gapData) return sendJson(res, 400, { error: 'scope/ref tidak valid' });
    try {
      const out = await ai.gapRecommendation(gapData);
      return sendJson(res, 200, { markdown: out.content, model: out.model, usage: out.usage, gapData });
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
  }

  // Fitur 2: rekomendasi topik kuis -----------------------------------------
  if (req.method === 'POST' && p === '/api/ai/quiz-topics') {
    const body = await readBody(req);
    const gapData = await resolveGapData(body);
    if (!gapData) return sendJson(res, 400, { error: 'scope/ref tidak valid' });
    try {
      const topics = (await db.listTopics()).map((t) => t.name);
      const out = await ai.quizTopicRecommendation(gapData, topics);
      return sendJson(res, 200, { ...out.parsed, model: out.model, usage: out.usage, gapData });
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
  }

  // Fitur 3: rekomendasi + acknowledgement ---------------------------------
  if (req.method === 'GET' && p === '/api/recommendations') {
    const status = q.get('status') || undefined;
    return sendJson(res, 200, await db.listRecommendations(status));
  }
  if (req.method === 'POST' && p === '/api/recommendations') {
    if (user.role !== 'super_admin' && user.role !== 'auditor') {
      return sendJson(res, 403, { error: 'Hanya Super Admin / Auditor yang dapat mengirim rekomendasi.' });
    }
    const body = await readBody(req);
    if (!body.title || !body.scope_type || !body.scope_ref) {
      return sendJson(res, 400, { error: 'title, scope_type, scope_ref wajib diisi.' });
    }
    // Rekomendasi tanpa isi tidak berguna bagi Direktur yang harus menilainya,
    // dan diam-diam tersimpan bila panggilan AI mengembalikan teks kosong.
    if (!String(body.recommendation || '').trim()) {
      return sendJson(res, 400, { error: 'Isi rekomendasi kosong — jalankan ulang AI Recommendation lebih dulu.' });
    }
    const rec = await db.createRecommendation({
      scope_type: body.scope_type,
      scope_ref: Number(body.scope_ref),
      scope_label: body.scope_label || '',
      title: body.title,
      gap_summary: body.gap_summary,
      recommendation: body.recommendation,
      recommended_topics: body.recommended_topics,
      model: body.model,
      created_by: user.name,
    });
    return sendJson(res, 201, rec);
  }
  if (req.method === 'POST' && /^\/api\/recommendations\/\d+\/acknowledge$/.test(p)) {
    if (user.role !== 'director') return sendJson(res, 403, { error: 'Hanya Direktur yang dapat acknowledge.' });
    const id = Number(p.split('/')[3]);
    const body = await readBody(req);
    const rec = await db.acknowledgeRecommendation(id, user.name, body.ack_note);
    if (!rec) return sendJson(res, 404, { error: 'Rekomendasi tidak ditemukan.' });
    return sendJson(res, 200, rec);
  }

  // Peserta: kurikulum kuis penuh (semua topik, urutan tetap) ----------------
  if (req.method === 'GET' && p === '/api/participant/curriculum') {
    // Peserta selalu melihat kurikulumnya sendiri; staf boleh memeriksa orang lain.
    const target = isStaff(user) && q.get('id') ? Number(q.get('id')) : user.id;
    const data = await db.participantCurriculum(target);
    if (!data) return sendJson(res, 404, { error: 'Peserta tidak ditemukan.' });
    return sendJson(res, 200, data);
  }

  // Peserta: generate kuis perbaikan (LLM) -----------------------------------
  if (req.method === 'POST' && p === '/api/quiz/generate') {
    const body = await readBody(req);
    // Kuis selalu dikerjakan sebagai diri sendiri — klien tidak bisa memilih identitas.
    const employeeId = user.id;
    const topicId = Number(body.topic_id);
    const emp = await db.employeeById(employeeId);
    const topic = await db.topicById(topicId);
    if (!emp || !topic) return sendJson(res, 400, { error: 'employee_id / topic_id tidak valid.' });
    try {
      const planned = await db.getBool('quiz_planned', true);
      let questions = [];
      let model = '';
      let trace = null;
      let lastFinish = '';
      let lastRawLength = 0;
      // Minta 10 (bukan 12): meminta lebih banyak hanya memperbesar peluang
      // jawaban terpotong, dan yang dipakai memang cuma 10.
      for (let attempt = 0; attempt < 2 && questions.length < 10; attempt++) {
        const need = 10 - questions.length;
        const gen = planned && attempt === 0
          ? await ai.generateQuizPlanned(topic.name, topic.area, need)
          : await ai.generateQuiz(topic.name, topic.area, need);
        model = gen.model || model;
        lastFinish = gen.finishReason || lastFinish;
        lastRawLength = gen.rawLength || lastRawLength;
        if (attempt === 0 && gen.trace) trace = gen.trace;
        questions = questions.concat(gen.questions);
      }
      if (questions.length < 10) {
        // Sebutkan SEBABNYA. "Hanya 0 soal valid" tidak memberi tahu apa pun
        // tentang apakah model diam, menolak, atau jawabannya terpotong.
        const why = lastFinish === 'length'
          ? `jawaban model terpotong (finish_reason=length, ${lastRawLength} karakter) — turunkan jumlah soal atau naikkan max_tokens`
          : lastFinish
            ? `model berhenti dengan finish_reason=${lastFinish} (${lastRawLength} karakter)`
            : `model membalas ${lastRawLength} karakter yang tidak memuat JSON soal yang sah`;
        return sendJson(res, 502, {
          error: `Hanya ${questions.length} soal valid yang dihasilkan: ${why}.`,
          model, finish_reason: lastFinish, raw_length: lastRawLength, trace,
        });
      }
      questions = questions.slice(0, 10);
      const sessionId = await db.createQuizSession(employeeId, topicId, questions, model);
      // Buang kunci jawaban sebelum dikirim ke klien.
      const safe = questions.map((it, i) => ({
        i, question: it.question, options: it.options, subconcept: it.subconcept || null,
      }));
      return sendJson(res, 200, {
        session_id: sessionId, topic: topic.name, area: topic.area,
        num_questions: safe.length, questions: safe, model,
        method: planned ? 'planned' : 'direct', trace,
      });
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
  }

  // Peserta: kumpulkan kuis -> nilai -> perbarui skor ------------------------
  if (req.method === 'POST' && p === '/api/quiz/submit') {
    const body = await readBody(req);
    const session = await db.getQuizSession(Number(body.session_id));
    if (!session) return sendJson(res, 404, { error: 'Sesi kuis tidak ditemukan.' });
    if (session.employee_id !== user.id) return sendJson(res, 403, { error: 'Sesi kuis ini milik peserta lain.' });
    if (session.status !== 'open') return sendJson(res, 409, { error: 'Sesi kuis sudah dikumpulkan.' });
    const answers = Array.isArray(body.answers) ? body.answers : [];
    const payload = JSON.parse(session.payload);
    let correct = 0;
    const results = payload.map((it, i) => {
      const chosen = Number.isInteger(answers[i]) ? answers[i] : null;
      const ok = chosen === it.answer_index;
      if (ok) correct += 1;
      return { i, chosen, answer_index: it.answer_index, ok, explanation: it.explanation, options: it.options, question: it.question, grounded: !!it.grounded, source: it.source || null, similarity: it.similarity ?? null, excerpt: it.excerpt || null };
    });
    const total = payload.length;
    const score = Math.round((correct / total) * 100); // maks 100
    // Skor topik = nilai TERBAIK. Hanya simpan attempt ini bila melampaui skor
    // lama; bila tidak, skor lama dipertahankan (tidak diturunkan/ditimpa).
    const prev = await db.bestScoreForEmployee(session.employee_id, session.topic_id);
    const prevBest = prev.best;                       // null bila belum pernah
    const improved = prevBest == null || score > prevBest;
    const today = new Date().toISOString().slice(0, 10);
    if (improved) await db.recordAttempt(session.employee_id, session.topic_id, score, today);
    await db.closeQuizSession(session.id, score);
    const newBest = improved ? score : prevBest;
    const after = await db.bestScoreForEmployee(session.employee_id, session.topic_id);
    const topic = await db.topicById(session.topic_id);
    return sendJson(res, 200, {
      score, correct, total, results,
      topic: topic ? topic.name : '',
      prevBest, newBest, improved, attempts: after.attempts,
    });
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

/**
 * Entri tunggal untuk kedua host (Express & node:http).
 * Selalu menjawab request — error tak terduga dibalas 500 JSON.
 */
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    await api(req, res, url);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
}

module.exports = { handle, api, sendJson };
