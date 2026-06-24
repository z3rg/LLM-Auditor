'use strict';
/**
 * LLM Auditor — zero-dependency HTTP server (Node built-ins only).
 * Serves the dashboard and the JSON API for gap analysis, the three AI
 * features, and the Super Admin -> SQL Agent -> Director acknowledgement flow.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// --- tiny .env loader (no dotenv dependency) -------------------------------
(function loadEnv() {
  try {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (_) {}
})();

const db = require('./lib/db');
const ai = require('./lib/groq');
const vec = require('./lib/vec');
const pdf = require('./lib/pdf');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- helpers ---------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
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
/** Read a raw binary request body (for PDF upload). */
function readRawBody(req, maxBytes = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > maxBytes) { req.destroy(); reject(new Error('Berkas terlalu besar (maks 30MB).')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

// --- API routes ------------------------------------------------------------
async function api(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  // Reference data ----------------------------------------------------------
  if (req.method === 'GET' && p === '/api/divisions') return sendJson(res, 200, db.listDivisions());
  if (req.method === 'GET' && p === '/api/topics') return sendJson(res, 200, db.listTopics());
  if (req.method === 'GET' && p === '/api/employees') return sendJson(res, 200, db.listEmployees());
  if (req.method === 'GET' && p === '/api/overview') return sendJson(res, 200, db.overviewStats());

  if (req.method === 'GET' && p === '/api/trend') {
    const divisionId = q.get('division') ? Number(q.get('division')) : null;
    const topicId = q.get('topic') ? Number(q.get('topic')) : null;
    const months = /^\d+$/.test(q.get('months') || '') ? Number(q.get('months')) : null;
    let overall = db.scoreTrend({});
    let filtered = (divisionId || topicId) ? db.scoreTrend({ divisionId, topicId }) : null;
    // Time-range filter: keep only the last `months` calendar months of data.
    if (months && overall.length) {
      const latest = overall[overall.length - 1].month;
      const cutoff = monthMinus(latest, months - 1); // 'YYYY-MM', lexicographically comparable
      overall = overall.filter((r) => r.month >= cutoff);
      if (filtered) filtered = filtered.filter((r) => r.month >= cutoff);
    }
    let label = 'Keseluruhan';
    if (divisionId) label = db.listDivisions().find((d) => d.id === divisionId)?.name || 'Divisi';
    else if (topicId) label = db.listTopics().find((t) => t.id === topicId)?.name || 'Topik';
    return sendJson(res, 200, { overall, filtered, label, months, gapThreshold: db.GAP_THRESHOLD });
  }

  if (req.method === 'GET' && p === '/api/config') {
    return sendJson(res, 200, {
      model: ai.cfg().model,
      hasKey: !!ai.cfg().key,
      gapThreshold: db.GAP_THRESHOLD,
      rag: vec.stats(),
      quizUseReact: db.getBool('quiz_use_react', true),
      quizUseRag: db.getBool('quiz_use_rag', true),
    });
  }

  // Settings + RAG / PDF importer ------------------------------------------
  if (req.method === 'GET' && p === '/api/settings') {
    return sendJson(res, 200, {
      quizUseReact: db.getBool('quiz_use_react', true),
      quizUseRag: db.getBool('quiz_use_rag', true),
      pdfLegalMode: db.getBool('pdf_legal_mode', true),
      rag: vec.stats(),
    });
  }
  if (req.method === 'POST' && p === '/api/settings') {
    if (req.headers['x-role'] !== 'super_admin') return sendJson(res, 403, { error: 'Hanya Super Admin yang dapat mengubah pengaturan.' });
    const body = await readBody(req);
    if ('quizUseReact' in body) db.setSetting('quiz_use_react', body.quizUseReact ? '1' : '0');
    if ('quizUseRag' in body) db.setSetting('quiz_use_rag', body.quizUseRag ? '1' : '0');
    if ('pdfLegalMode' in body) db.setSetting('pdf_legal_mode', body.pdfLegalMode ? '1' : '0');
    return sendJson(res, 200, {
      quizUseReact: db.getBool('quiz_use_react', true),
      quizUseRag: db.getBool('quiz_use_rag', true),
      pdfLegalMode: db.getBool('pdf_legal_mode', true),
    });
  }

  // Embedding backend configuration -----------------------------------------
  if (req.method === 'GET' && p === '/api/settings/embed') {
    if (req.headers['x-role'] !== 'super_admin') return sendJson(res, 403, { error: 'Hanya Super Admin.' });
    const active = require('./lib/embedder').active();
    return sendJson(res, 200, {
      backend: 'gemini',
      geminiModel: db.getSetting('embed_gemini_model') || process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001',
      hasGeminiKey: !!(db.getSetting('embed_gemini_key') || process.env.GEMINI_API_KEY),
      legalMode: db.getBool('pdf_legal_mode', true),
      current: active ? { name: active.name, dim: active.dim, kind: active.kind } : null,
      rag: vec.stats(),
    });
  }
  if (req.method === 'POST' && p === '/api/settings/embed') {
    if (req.headers['x-role'] !== 'super_admin') return sendJson(res, 403, { error: 'Hanya Super Admin.' });
    const body = await readBody(req);
    try {
      const embedder = require('./lib/embedder');
      await embedder.reconfigure({
        geminiKey:   typeof body.geminiKey === 'string' ? body.geminiKey : undefined,
        geminiModel: body.geminiModel,
      });
      vec.resetEmbedder();
      if ('legalMode' in body) db.setSetting('pdf_legal_mode', body.legalMode ? '1' : '0');
      const active = embedder.active();
      return sendJson(res, 200, {
        ok: true,
        current: active ? { name: active.name, dim: active.dim, kind: active.kind } : null,
        rag: vec.stats(),
      });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  if (req.method === 'GET' && p === '/api/pdf/documents') {
    return sendJson(res, 200, { documents: vec.listDocuments(), rag: vec.stats() });
  }
  if (req.method === 'POST' && p === '/api/pdf/import') {
    if (req.headers['x-role'] !== 'super_admin') return sendJson(res, 403, { error: 'Hanya Super Admin yang dapat mengunggah PDF.' });
    let buf;
    try { buf = await readRawBody(req); } catch (e) { return sendJson(res, 413, { error: e.message }); }
    const filename = decodeURIComponent(req.headers['x-filename'] || 'document.pdf').replace(/[\r\n]/g, '');
    if (!buf || buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return sendJson(res, 400, { error: 'Berkas bukan PDF yang valid.' });
    }
    try {
      const { text, numPages } = pdf.extractText(buf);
      if (!text || text.trim().length < 30) {
        return sendJson(res, 422, { error: 'PDF tidak mengandung teks yang dapat diekstrak (kemungkinan hasil scan/gambar). Gunakan PDF berbasis teks.' });
      }
      const title = filename.replace(/\.pdf$/i, '');
      const legalMode = db.getBool('pdf_legal_mode', true);
      const doc = await vec.addDocument({ filename, title, text, numPages, bytes: buf.length, legalMode });
      return sendJson(res, 201, { document: doc, rag: vec.stats() });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (req.method === 'DELETE' && /^\/api\/pdf\/documents\/\d+$/.test(p)) {
    if (req.headers['x-role'] !== 'super_admin') return sendJson(res, 403, { error: 'Hanya Super Admin yang dapat menghapus dokumen.' });
    const id = Number(p.split('/').pop());
    const ok = vec.deleteDocument(id);
    if (!ok) return sendJson(res, 404, { error: 'Dokumen tidak ditemukan.' });
    return sendJson(res, 200, { deleted: id, rag: vec.stats() });
  }
  if (req.method === 'POST' && p === '/api/pdf/search') {
    if (req.headers['x-role'] !== 'super_admin') return sendJson(res, 403, { error: 'Hanya Super Admin yang dapat menguji pencarian.' });
    const body = await readBody(req);
    const query = (body.query || '').trim();
    if (!query) return sendJson(res, 400, { error: 'Query kosong.' });
    const results = await vec.search(query, Number(body.k) || 5);
    return sendJson(res, 200, { query, results, rag: vec.stats() });
  }

  // Gap analysis ------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/gaps/employee') {
    const data = db.employeeGaps(Number(q.get('id')));
    if (!data) return sendJson(res, 404, { error: 'Employee not found' });
    return sendJson(res, 200, data);
  }
  if (req.method === 'GET' && p === '/api/gaps/division') {
    const data = db.divisionGaps(Number(q.get('id')));
    if (!data) return sendJson(res, 404, { error: 'Division not found' });
    return sendJson(res, 200, data);
  }

  // Feature 1: AI knowledge-gap recommendation ------------------------------
  if (req.method === 'POST' && p === '/api/ai/recommendation') {
    const body = await readBody(req);
    const gapData = resolveGapData(body);
    if (!gapData) return sendJson(res, 400, { error: 'scope/ref tidak valid' });
    try {
      const out = await ai.gapRecommendation(gapData);
      return sendJson(res, 200, { markdown: out.content, model: out.model, usage: out.usage, gapData });
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
  }

  // Feature 2: AI quiz-topic recommendation ---------------------------------
  if (req.method === 'POST' && p === '/api/ai/quiz-topics') {
    const body = await readBody(req);
    const gapData = resolveGapData(body);
    if (!gapData) return sendJson(res, 400, { error: 'scope/ref tidak valid' });
    try {
      const topics = db.listTopics().map((t) => t.name);
      const out = await ai.quizTopicRecommendation(gapData, topics);
      return sendJson(res, 200, { ...out.parsed, model: out.model, usage: out.usage, gapData });
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
  }

  // Feature 3a: SQL Agent (super admin) -------------------------------------
  if (req.method === 'POST' && p === '/api/sql-agent') {
    const role = req.headers['x-role'];
    if (role !== 'super_admin') return sendJson(res, 403, { error: 'Hanya Super Admin yang dapat menggunakan SQL Agent.' });
    const body = await readBody(req);
    const question = (body.question || '').trim();
    if (!question) return sendJson(res, 400, { error: 'Pertanyaan kosong.' });
    try {
      const schema = db.schemaDescription();
      let gen = await ai.sqlAgent(question, schema, db.GAP_THRESHOLD);
      let rows = [];
      let runError = null;
      let repaired = false;
      try { rows = db.runSelect(gen.sql); }
      catch (e) { runError = e.message; }
      // One-shot self-repair if the generated query failed to execute.
      if (runError) {
        try {
          const fix = await ai.repairSql(question, schema, gen.sql, runError, db.GAP_THRESHOLD);
          const fixedRows = db.runSelect(fix.sql);
          gen = fix; rows = fixedRows; runError = null; repaired = true;
        } catch (e2) { runError = e2.message; }
      }
      return sendJson(res, 200, {
        sql: gen.sql, explanation: gen.explanation, model: gen.model, repaired,
        columns: rows.length ? Object.keys(rows[0]) : [],
        rows, rowCount: rows.length, runError,
      });
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
  }

  // Feature 3b: recommendations + acknowledgement ---------------------------
  if (req.method === 'GET' && p === '/api/recommendations') {
    const status = q.get('status') || undefined;
    return sendJson(res, 200, db.listRecommendations(status));
  }
  if (req.method === 'POST' && p === '/api/recommendations') {
    const role = req.headers['x-role'];
    if (role !== 'super_admin' && role !== 'auditor') {
      return sendJson(res, 403, { error: 'Hanya Super Admin / Auditor yang dapat mengirim rekomendasi.' });
    }
    const body = await readBody(req);
    if (!body.title || !body.scope_type || !body.scope_ref) {
      return sendJson(res, 400, { error: 'title, scope_type, scope_ref wajib diisi.' });
    }
    const rec = db.createRecommendation({
      scope_type: body.scope_type,
      scope_ref: Number(body.scope_ref),
      scope_label: body.scope_label || '',
      title: body.title,
      gap_summary: body.gap_summary,
      recommendation: body.recommendation,
      recommended_topics: body.recommended_topics,
      model: body.model,
      created_by: body.created_by || (role === 'auditor' ? 'Lead IT Auditor' : 'Super Admin'),
    });
    return sendJson(res, 201, rec);
  }
  if (req.method === 'POST' && /^\/api\/recommendations\/\d+\/acknowledge$/.test(p)) {
    const role = req.headers['x-role'];
    if (role !== 'director') return sendJson(res, 403, { error: 'Hanya Direktur yang dapat acknowledge.' });
    const id = Number(p.split('/')[3]);
    const body = await readBody(req);
    const rec = db.acknowledgeRecommendation(id, body.ack_by || 'Direktur Utama', body.ack_note);
    if (!rec) return sendJson(res, 404, { error: 'Rekomendasi tidak ditemukan.' });
    return sendJson(res, 200, rec);
  }

  // Participant: full quiz curriculum (all topics, fixed order) — SQL driven --
  if (req.method === 'GET' && p === '/api/participant/curriculum') {
    const data = db.participantCurriculum(Number(q.get('id')));
    if (!data) return sendJson(res, 404, { error: 'Peserta tidak ditemukan.' });
    return sendJson(res, 200, data);
  }

  // Participant: generate an improvement quiz (Groq) -------------------------
  if (req.method === 'POST' && p === '/api/quiz/generate') {
    const body = await readBody(req);
    const employeeId = Number(body.employee_id);
    const topicId = Number(body.topic_id);
    const emp = db.employeeById(employeeId);
    const topic = db.topicById(topicId);
    if (!emp || !topic) return sendJson(res, 400, { error: 'employee_id / topic_id tidak valid.' });
    try {
      const useReact = db.getBool('quiz_use_react', true);
      const useRag = db.getBool('quiz_use_rag', true);
      const hasKB = vec.stats().chunks > 0;
      const ragOn = useRag && hasKB;
      let questions = [];
      let model = '';
      let trace = null;
      let sources = null;
      // Request with buffer; top up once if fewer than 10 valid questions.
      for (let attempt = 0; attempt < 2 && questions.length < 10; attempt++) {
        if (useReact) {
          // ReAct + RAG per-soal: rencanakan sub-konsep, retrieval per soal via sqlite-vec,
          // lalu grounded-generate (1 soal/blok). Tiap soal membawa grounded/source sendiri.
          const gen = await ai.generateQuizReActPerQuestion(topic.name, topic.area, 12, {
            search: ragOn ? (q) => vec.search(q, 4) : null,
            hasKB: ragOn,
          });
          model = gen.model;
          if (attempt === 0) { trace = gen.trace; sources = gen.sources; }
          questions = questions.concat(gen.questions);
        } else {
          const gen = await ai.generateQuiz(topic.name, topic.area, 12);
          model = gen.model;
          questions = questions.concat(gen.questions);
        }
      }
      if (questions.length < 10) {
        return sendJson(res, 502, { error: `Hanya ${questions.length} soal valid yang dihasilkan, coba lagi.` });
      }
      questions = questions.slice(0, 10);
      const groundedCount = questions.filter((q) => q.grounded).length;
      const sessionId = db.createQuizSession(employeeId, topicId, questions, model);
      // Strip correct answers; keep per-question grounding/source for the UI.
      const safe = questions.map((it, i) => ({
        i, question: it.question, options: it.options,
        grounded: !!it.grounded, source: it.source || null,
        similarity: it.similarity ?? null, excerpt: it.excerpt || null,
      }));
      return sendJson(res, 200, {
        session_id: sessionId, topic: topic.name, area: topic.area,
        num_questions: safe.length, questions: safe, model,
        method: useReact ? 'ReAct' : 'direct',
        grounded: groundedCount > 0, groundedCount, trace, sources,
      });
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
  }

  // Participant: submit quiz -> grade -> update score ------------------------
  if (req.method === 'POST' && p === '/api/quiz/submit') {
    const body = await readBody(req);
    const session = db.getQuizSession(Number(body.session_id));
    if (!session) return sendJson(res, 404, { error: 'Sesi kuis tidak ditemukan.' });
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
    const score = Math.round((correct / total) * 100); // max 100
    // Skor topik = nilai TERBAIK. Hanya simpan attempt ini bila melampaui skor
    // lama; bila tidak, skor lama dipertahankan (tidak diturunkan/ditimpa).
    const prev = db.bestScoreForEmployee(session.employee_id, session.topic_id);
    const prevBest = prev.best;                       // null bila belum pernah
    const improved = prevBest == null || score > prevBest;
    const today = new Date().toISOString().slice(0, 10);
    if (improved) db.recordAttempt(session.employee_id, session.topic_id, score, today);
    db.closeQuizSession(session.id, score);
    const newBest = improved ? score : prevBest;
    const after = db.bestScoreForEmployee(session.employee_id, session.topic_id);
    const topic = db.topicById(session.topic_id);
    return sendJson(res, 200, {
      score, correct, total, results,
      topic: topic ? topic.name : '',
      prevBest, newBest, improved, attempts: after.attempts,
    });
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

/** Subtract k months from a 'YYYY-MM' string, returning 'YYYY-MM'. */
function monthMinus(ym, k) {
  let [y, m] = ym.split('-').map(Number);
  m -= k;
  while (m <= 0) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Build the gap payload the AI helpers expect, from {scope_type, scope_ref}. */
function resolveGapData(body) {
  const ref = Number(body.scope_ref);
  if (body.scope_type === 'employee') {
    const g = db.employeeGaps(ref);
    if (!g) return null;
    return { scopeType: 'employee', label: g.employee.name, refId: ref, ...g };
  }
  if (body.scope_type === 'division') {
    const g = db.divisionGaps(ref);
    if (!g) return null;
    return { scopeType: 'division', label: g.division.name, refId: ref, ...g };
  }
  return null;
}

// --- server ----------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
  serveStatic(res, url.pathname);
});

(async () => {
  // Hangatkan embedder RAG (muat model lokal & rekonsiliasi index) sebelum melayani.
  try { await vec.ready(); } catch (e) { console.warn('  RAG init warning:', e.message); }
  server.listen(PORT, () => {
    const r = vec.stats();
    console.log(`\n  LLM Auditor running:  http://localhost:${PORT}`);
    console.log(`  Groq model:           ${ai.cfg().model}`);
    console.log(`  Groq key loaded:      ${ai.cfg().key ? 'yes' : 'NO — set GROQ_API_KEY in .env'}`);
    console.log(`  RAG embedder:         ${r.embedder} (dim ${r.dim})`);
    console.log(`  RAG vector store:     ${r.backend}\n`);
  });
})();
