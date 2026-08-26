'use strict';
/**
 * Wrapper tipis untuk Chat Completions ber-skema OpenAI, plus tiga fitur AI:
 *   1. Rekomendasi gap pengetahuan
 *   2. Rekomendasi topik kuis
 *   3. SQL Agent (bahasa natural -> SQL read-only)
 *
 * Provider default adalah **AI Gateway EdgeOne Makers**, yang menyediakan model
 * bawaan tanpa perlu kunci vendor sendiri. Groq dipertahankan sebagai jalur
 * alternatif karena skemanya identik — keduanya OpenAI-compatible, jadi
 * perbedaannya hanya base URL, nama kunci, dan id model.
 *
 * Pemilihan provider:
 *   1. AI_PROVIDER=makers|groq bila ingin memaksa,
 *   2. selain itu: 'makers' bila MAKERS_MODELS_KEY ada, jika tidak 'groq'.
 *
 * Catatan: gateway ini hanya melayani chat completion. Embedding RAG tetap
 * memakai Gemini (lihat lib/embedder.js) karena tidak ada endpoint embeddings.
 */
const PROVIDERS = {
  makers: {
    label: 'EdgeOne Makers',
    url: 'https://ai-gateway.edgeone.link/v1/chat/completions',
    keyEnv: 'MAKERS_MODELS_KEY',
    modelEnv: 'MAKERS_MODEL',
    defaultModel: '@makers/deepseek-v4-flash',
    keyHint: 'Ambil di konsol Makers → Models → API Key, lalu set MAKERS_MODELS_KEY.',
  },
  groq: {
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    defaultModel: 'llama-3.3-70b-versatile',
    keyHint: 'Ambil di https://console.groq.com/keys, lalu set GROQ_API_KEY.',
  },
};

function provider() {
  const forced = String(process.env.AI_PROVIDER || '').toLowerCase();
  if (PROVIDERS[forced]) return { name: forced, ...PROVIDERS[forced] };
  const name = process.env.MAKERS_MODELS_KEY ? 'makers' : 'groq';
  return { name, ...PROVIDERS[name] };
}

function cfg() {
  const p = provider();
  return {
    provider: p.name,
    providerLabel: p.label,
    key: process.env[p.keyEnv],
    keyEnv: p.keyEnv,
    model: process.env[p.modelEnv] || p.defaultModel,
  };
}

async function chat(messages, opts = {}) {
  const p = provider();
  const { key, model } = cfg();
  if (!key) throw new Error(`${p.keyEnv} belum disetel. ${p.keyHint}`);
  const body = {
    model: opts.model || model,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 1200,
    messages,
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  const res = await fetch(p.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${p.label} API ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    model: data.model,
    usage: data.usage,
  };
}

function safeJson(str) {
  try { return JSON.parse(str); } catch (_) {}
  const m = str.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// ---------------------------------------------------------------------------
// Feature 1: Knowledge-gap recommendation
// ---------------------------------------------------------------------------
async function gapRecommendation(gapData) {
  const { label, scopeType, overall, topics, gaps, gapThreshold } = gapData;
  const topicLines = topics
    .map((t) => `- ${t.topic} (area ${t.area || '-'}): avg ${t.avg_score}/100`)
    .join('\n');
  const gapNames = gaps.map((g) => g.topic).join(', ') || 'tidak ada gap signifikan';

  const messages = [
    {
      role: 'system',
      content:
        'Anda adalah konsultan IT Audit & GRC senior. Berikan analisis dan rekomendasi ' +
        'yang ringkas, konkret, dan actionable dalam Bahasa Indonesia. Gunakan istilah ' +
        'audit yang tepat (ISO 27001, COBIT, NIST). Jangan mengarang data di luar yang diberikan.',
    },
    {
      role: 'user',
      content:
`Berikut hasil kuis IT Auditor untuk ${scopeType === 'division' ? 'divisi' : 'karyawan'} "${label}".
Skor rata-rata keseluruhan: ${overall}/100. Ambang gap (knowledge gap) = di baw${''}ah ${gapThreshold}.
Topik dengan gap: ${gapNames}.

Rincian skor per topik:
${topicLines}

Tugas:
1. Ringkas kondisi pengetahuan (2-3 kalimat), soroti area paling berisiko untuk audit IT.
2. Berikan 3-5 rekomendasi perbaikan yang spesifik dan dapat dieksekusi (training, kontrol, kebijakan).
3. Sebutkan prioritas (Tinggi/Sedang/Rendah) untuk tiap rekomendasi.
4. Nilai tingkat risiko keseluruhan (Tinggi/Sedang/Rendah) beserta alasan singkat.

Format jawaban dengan heading markdown yang rapi.`,
    },
  ];
  const out = await chat(messages, { temperature: 0.35, max_tokens: 1100 });
  return out;
}

// ---------------------------------------------------------------------------
// Feature 2: Quiz-topic recommendation (structured JSON)
// ---------------------------------------------------------------------------
async function quizTopicRecommendation(gapData, availableTopics) {
  const { label, scopeType, gaps, topics, gapThreshold } = gapData;
  const weakLines = topics
    .filter((t) => t.avg_score < 85)
    .map((t) => `- ${t.topic}: avg ${t.avg_score}/100`)
    .join('\n') || '(semua topik kuat)';

  const messages = [
    {
      role: 'system',
      content:
        'Anda perancang kurikulum pelatihan IT Audit. Keluarkan HANYA JSON valid sesuai skema. ' +
        'Semua teks naratif dalam Bahasa Indonesia.',
    },
    {
      role: 'user',
      content:
`Untuk ${scopeType === 'division' ? 'divisi' : 'karyawan'} "${label}", berdasarkan gap berikut:
${weakLines}

Daftar topik kuis yang tersedia: ${availableTopics.join(', ')}.
Ambang gap = ${gapThreshold}/100.

Rekomendasikan kuis prioritas untuk menutup gap. Boleh menyarankan sub-topik baru yang relevan.
Keluarkan JSON dengan skema PERSIS:
{
  "summary": "ringkasan 1 kalimat",
  "recommended_quizzes": [
    {
      "topic": "nama topik",
      "priority": "Tinggi|Sedang|Rendah",
      "reason": "alasan singkat berbasis skor",
      "suggested_subtopics": ["...", "..."],
      "target_score": 85
    }
  ]
}`,
    },
  ];
  const out = await chat(messages, { temperature: 0.3, json: true, max_tokens: 1000 });
  const parsed = safeJson(out.content) || { summary: '', recommended_quizzes: [] };
  return { ...out, parsed };
}

// ---------------------------------------------------------------------------
// Feature 3: SQL Agent (NL -> read-only SQL)
// ---------------------------------------------------------------------------
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate|grant|revoke)\b/i;

function sanitizeSql(raw) {
  let sql = (raw || '').trim();
  // strip code fences / leading "sql"
  sql = sql.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  sql = sql.replace(/;+\s*$/g, '').trim();
  if (!/^(select|with)\b/i.test(sql)) {
    throw new Error('Hanya query SELECT (atau CTE WITH … SELECT) yang diizinkan oleh SQL Agent.');
  }
  if (sql.includes(';')) {
    throw new Error('Hanya satu statement yang diizinkan (tidak boleh ada ";").');
  }
  if (FORBIDDEN.test(sql)) {
    throw new Error('Query mengandung operasi yang tidak diizinkan (read-only saja).');
  }
  if (!/\blimit\b/i.test(sql)) sql += ' LIMIT 200'; // safety cap
  return sql;
}

function sqlSystemPrompt(schema, gapThreshold = 70) {
  return (
`Anda SQL Agent untuk database SQLite READ-ONLY berisi hasil kuis IT Audit.
Ubah pertanyaan pengguna (Bahasa Indonesia atau Inggris) menjadi SATU query SQLite yang valid.

ATURAN:
- Hanya SELECT (boleh diawali CTE "WITH ... SELECT"). JANGAN pernah mengubah data.
- Gunakan HANYA tabel/kolom yang ada pada skema.
- Selalu beri alias kolom yang ramah-dibaca, dan bulatkan rata-rata: ROUND(AVG(qa.score), 1).
- Keluarkan HANYA JSON valid: {"sql": "...", "explanation": "penjelasan singkat Bahasa Indonesia"}.

PENGETAHUAN DOMAIN (penting):
- Skor kuis = quiz_attempts.score (0..100). "skor rata-rata" = AVG(score).
- "gap pengetahuan" / "knowledge gap" / "lemah" = rata-rata skor DI BAWAH ambang gap = ${gapThreshold}.
- WAJIB: untuk pertanyaan tentang skor rata-rata atau gap, GUNAKAN VIEW yang sudah disediakan
  (v_employee_topic, v_division_topic, v_division_score, v_topic_score, v_employee_score).
  Di view tersebut, kolom is_gap=1 menandakan gap. Filter gap cukup dengan WHERE is_gap = 1.
  JANGAN menghitung ulang AVG dari quiz_attempts untuk gap — pakai view agar hasilnya benar.
- "karyawan" = role='employee' (view sudah memfilter ini).
- Tren/"per bulan": GROUP BY substr(taken_at, 1, 7) dari quiz_attempts.

SKEMA:
${schema}

CONTOH:
Q: divisi dengan skor rata-rata terendah
A: {"sql":"SELECT division AS divisi, avg_score AS skor_rata FROM v_division_score ORDER BY avg_score ASC LIMIT 5","explanation":"Rata-rata skor tiap divisi diurut menaik."}
Q: topik mana yang menjadi gap pengetahuan
A: {"sql":"SELECT topic AS topik, avg_score AS skor_rata FROM v_topic_score WHERE is_gap = 1 ORDER BY avg_score ASC","explanation":"Topik dengan rata-rata di bawah ambang gap."}
Q: divisi dengan jumlah gap terbanyak
A: {"sql":"SELECT division AS divisi, COUNT(*) AS jumlah_gap FROM v_division_topic WHERE is_gap = 1 GROUP BY division ORDER BY jumlah_gap DESC","explanation":"Menghitung topik ber-gap per divisi."}
Q: karyawan dengan gap terbanyak
A: {"sql":"SELECT employee AS karyawan, division AS divisi, gap_topics AS jumlah_gap FROM v_employee_score ORDER BY gap_topics DESC LIMIT 10","explanation":"Karyawan dengan jumlah topik ber-gap terbanyak."}
Q: gap pengetahuan di divisi IT
A: {"sql":"SELECT topic AS topik, avg_score AS skor_rata FROM v_division_topic WHERE division = 'IT' AND is_gap = 1 ORDER BY avg_score ASC","explanation":"Topik ber-gap pada divisi IT."}`
  );
}

async function sqlAgent(question, schema, gapThreshold = 70) {
  const messages = [
    { role: 'system', content: sqlSystemPrompt(schema, gapThreshold) },
    { role: 'user', content: question },
  ];
  const out = await chat(messages, { temperature: 0, json: true, max_tokens: 700 });
  const parsed = safeJson(out.content) || {};
  if (!parsed.sql) throw new Error('SQL Agent gagal menghasilkan query dari pertanyaan tersebut.');
  const sql = sanitizeSql(parsed.sql);
  return { sql, explanation: parsed.explanation || '', model: out.model, usage: out.usage };
}

/** Ask the model to repair a query that failed to execute. */
async function repairSql(question, schema, badSql, error, gapThreshold = 70) {
  const messages = [
    { role: 'system', content: sqlSystemPrompt(schema, gapThreshold) },
    { role: 'user', content: question },
    { role: 'assistant', content: JSON.stringify({ sql: badSql }) },
    {
      role: 'user',
      content:
        `Query di atas GAGAL dijalankan dengan error SQLite: "${error}". ` +
        'Perbaiki query (tetap satu SELECT/CTE read-only, hanya kolom yang ada di skema). ' +
        'Keluarkan HANYA JSON {"sql":"...","explanation":"..."}.',
    },
  ];
  const out = await chat(messages, { temperature: 0, json: true, max_tokens: 700 });
  const parsed = safeJson(out.content) || {};
  if (!parsed.sql) throw new Error('SQL Agent gagal memperbaiki query.');
  const sql = sanitizeSql(parsed.sql);
  return { sql, explanation: parsed.explanation || '', model: out.model, usage: out.usage };
}

// ---------------------------------------------------------------------------
// Quiz generation (multiple-choice questions per topic/area)
// ---------------------------------------------------------------------------
function validQuestions(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((q) =>
    q && typeof q.question === 'string' && q.question.trim() &&
    Array.isArray(q.options) && q.options.length === 4 &&
    q.options.every((o) => typeof o === 'string' && o.trim()) &&
    Number.isInteger(q.answer_index) && q.answer_index >= 0 && q.answer_index < 4
  ).map((q) => ({
    question: q.question.trim(),
    options: q.options.map((o) => o.trim()),
    answer_index: q.answer_index,
    explanation: typeof q.explanation === 'string' ? q.explanation.trim() : '',
  }));
}

const QUIZ_SYSTEM =
  'Anda penyusun soal sertifikasi IT Audit. Buat soal PILIHAN GANDA berkualitas, tingkat ' +
  'menengah, dalam Bahasa Indonesia. Tepat 4 opsi per soal dan TEPAT SATU jawaban benar. ' +
  'Keluarkan HANYA JSON valid sesuai skema.';

const QUIZ_SCHEMA_HINT =
`Skema JSON PERSIS:
{"questions":[{"question":"...","options":["opsi A","opsi B","opsi C","opsi D"],"answer_index":0,"explanation":"alasan singkat"}]}
answer_index adalah indeks 0..3 dari opsi yang BENAR.`;

async function generateQuiz(topic, area, n = 10) {
  const messages = [
    { role: 'system', content: QUIZ_SYSTEM },
    {
      role: 'user',
      content:
`Buat ${n} soal pilihan ganda untuk topik audit IT "${topic}" (area: ${area || '-'}).
Variasikan sub-konsep dalam topik. Hindari soal duplikat. Jawaban harus tidak ambigu.
${QUIZ_SCHEMA_HINT}`,
    },
  ];
  const out = await chat(messages, { temperature: 0.5, json: true, max_tokens: 3800 });
  const parsed = safeJson(out.content) || {};
  return { questions: validQuestions(parsed.questions), model: out.model };
}

// ---------------------------------------------------------------------------
// Quiz generation — framework ReAct (Reason + Act) dengan RAG (pgvector)
// ---------------------------------------------------------------------------
// Model menalar lalu MENGAMBIL TINDAKAN memanggil tool `search_knowledge`
// untuk menarik materi dari PDF yang diimpor, baru menyusun kuis yang
// "grounded" pada materi tersebut. Trace Thought/Action/Observation
// dikembalikan agar bisa ditampilkan di UI.

function fmtObservation(results) {
  if (!results || !results.length) return '(tidak ada materi relevan di basis pengetahuan)';
  return results
    .map((r, i) => `[#${i + 1} · sumber: ${r.source} · skor ${r.similarity}]\n${String(r.content).slice(0, 600)}`)
    .join('\n\n');
}

async function safeSearch(search, query) {
  try { return (await search(query)) || []; } catch (_) { return []; }
}

/** Susun kuis dari konteks PDF yang sudah terkumpul (panggilan JSON terfokus). */
async function groundedGenerate(topic, area, n, contextChunks) {
  const ctx = (contextChunks || [])
    .slice(0, 8)
    .map((c, i) => `[Sumber ${i + 1} — ${c.source}]\n${String(c.content).slice(0, 700)}`)
    .join('\n\n')
    .slice(0, 6500);
  const grounding = ctx
    ? `Gunakan KONTEKS dari dokumen PDF yang diimpor sebagai sumber UTAMA. Utamakan fakta, ` +
      `definisi, dan istilah dari konteks. Bila konteks kurang lengkap, lengkapi dengan ` +
      `pengetahuan umum IT audit yang benar.\n\n=== KONTEKS PDF ===\n${ctx}\n=== AKHIR KONTEKS ===\n\n`
    : '';
  const messages = [
    { role: 'system', content: QUIZ_SYSTEM },
    {
      role: 'user',
      content:
`${grounding}Buat ${n} soal pilihan ganda untuk topik audit IT "${topic}" (area: ${area || '-'}).
Variasikan sub-konsep. Hindari soal duplikat. Jawaban harus tidak ambigu.
${QUIZ_SCHEMA_HINT}`,
    },
  ];
  const out = await chat(messages, { temperature: 0.5, json: true, max_tokens: 3800 });
  const parsed = safeJson(out.content) || {};
  return { questions: validQuestions(parsed.questions), model: out.model };
}

function reactSystemPrompt(hasKB) {
  return (
`Anda agen penyusun soal IT Audit yang bekerja dengan pola ReAct (Reasoning + Acting).
Anda memiliki SATU tool:
- search_knowledge(query): mencari materi relevan dari dokumen PDF yang diimpor (basis pengetahuan RAG).

Pada SETIAP langkah, balas HANYA dengan satu objek JSON:
  {"thought":"penalaran singkat", "action":"search_knowledge"|"generate_quiz", "action_input":"..."}
- action "search_knowledge": action_input = string query pencarian. Gunakan untuk mengumpulkan fakta/definisi/istilah dari materi sebelum membuat soal.
- action "generate_quiz": action_input = string singkat penanda siap (mis. "materi cukup"). Pilih ini bila materi sudah memadai; sistem akan menyusun soal final dari materi yang terkumpul.

ATURAN:
- ${hasKB ? 'WAJIB lakukan 1–2 kali search_knowledge dulu agar soal benar-benar berbasis materi PDF.' : 'Basis pengetahuan KOSONG; observasi akan kosong. Lakukan satu langkah lalu pilih generate_quiz (memakai pengetahuan umum IT audit).'}
- Jangan menulis soal di dalam action_input; cukup kumpulkan materi lalu pilih generate_quiz.
- Maksimal beberapa langkah; jangan bertele-tele.`
  );
}

/**
 * Generate kuis dengan ReAct + RAG.
 * @param {string} topic
 * @param {string} area
 * @param {number} n
 * @param {object} opts { search?: (q)=>Promise<chunk[]>, maxSteps?, hasKB? }
 * @returns {{questions, model, trace, sources}}
 */
async function generateQuizReAct(topic, area, n = 10, opts = {}) {
  const search = opts.search || null;
  const useKB = !!search && opts.hasKB !== false;
  const maxSteps = opts.maxSteps || 4;
  const trace = [];
  const contextChunks = [];
  const seen = new Set();
  const addCtx = (arr) => { for (const c of arr) if (!seen.has(c.id)) { seen.add(c.id); contextChunks.push(c); } };

  const messages = [
    { role: 'system', content: reactSystemPrompt(useKB) },
    { role: 'user', content: `Tugas: susun ${n} soal pilihan ganda untuk topik "${topic}" (area: ${area || '-'}). Mulai dengan menalar dan, bila perlu, panggil search_knowledge.` },
  ];

  let model = '';
  for (let step = 0; step < maxSteps; step++) {
    let obj = {};
    try {
      const out = await chat(messages, { temperature: 0.3, json: true, max_tokens: 500 });
      model = out.model;
      obj = safeJson(out.content) || {};
    } catch (_) { break; }

    const action = String(obj.action || '').toLowerCase();
    const thought = String(obj.thought || '').slice(0, 400);

    if (useKB && action.includes('search') && obj.action_input) {
      const query = String(obj.action_input).slice(0, 200);
      const results = await safeSearch(search, query);
      addCtx(results);
      const observation = fmtObservation(results);
      trace.push({ thought, action: 'search_knowledge', action_input: query, observation });
      messages.push({ role: 'assistant', content: JSON.stringify({ thought, action: 'search_knowledge', action_input: query }) });
      messages.push({ role: 'user', content: `Observation:\n${observation}\n\nLanjutkan. Bila materi cukup, balas dengan action "generate_quiz".` });
      continue;
    }

    // generate_quiz / selesai / aksi tak dikenal → keluar dari loop
    trace.push({ thought, action: 'generate_quiz', action_input: String(obj.action_input || 'materi cukup'), observation: '' });
    break;
  }

  // Seed retrieval bila model tak pernah memanggil search (jaminan grounding).
  if (useKB && !contextChunks.length) {
    addCtx(await safeSearch(search, `${topic} ${area || ''}`.trim()));
  }

  const gen = await groundedGenerate(topic, area, n, contextChunks);
  const sources = dedupeSources(contextChunks);
  trace.push({ thought: `Menyusun ${gen.questions.length} soal final berbasis ${contextChunks.length} potongan materi.`, action: 'final_answer', action_input: '', observation: '' });
  return { questions: gen.questions, model: gen.model || model, trace, sources };
}

function dedupeSources(chunks) {
  const m = new Map();
  for (const c of chunks || []) m.set(c.source, (m.get(c.source) || 0) + 1);
  return [...m.entries()].map(([source, chunks]) => ({ source, chunks }));
}

// ---------------------------------------------------------------------------
// Quiz generation — ReAct + RAG PER SOAL (retrieval & grounding tiap soal)
// ---------------------------------------------------------------------------
// Berbeda dari generateQuizReAct (satu retrieval pooled → N soal), versi ini:
//   1. ReAct "plan": menalar N sub-konsep berbeda + query pencarian per soal.
//   2. Retrieval pgvector TERPISAH untuk tiap sub-konsep (1 soal = 1 blok materi).
//   3. groundedGeneratePerQuestion: tepat 1 soal per blok, di-grounding ke materinya.
//   4. Blend + tandai: bila materi sebuah blok tipis (< GROUND_MIN), soal disusun dari
//      pengetahuan umum dan ditandai grounded=false (source=null).

// Ambang similarity (cosine) agar sebuah soal dianggap benar-benar "grounded" oleh RAG.
// Catatan: embedding Gemini memampatkan similarity ke pita sempit & tinggi — pada KB POJK,
// query OFF-topic pun ~0.60 sedangkan ON-topic ~0.67–0.68. Maka ambang harus DI ATAS lantai
// noise (~0.60), bukan 0.5. Bisa disetel via env QUIZ_GROUND_MIN bila KB/embedding berbeda.
const GROUND_MIN = Number(process.env.QUIZ_GROUND_MIN) || 0.63;

/** Field-validate questions but PRESERVE the `block` mapping field. */
function validQuestionsWithBlock(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const q of arr) {
    if (!q || typeof q.question !== 'string' || !q.question.trim()) continue;
    if (!Array.isArray(q.options) || q.options.length !== 4) continue;
    if (!q.options.every((o) => typeof o === 'string' && o.trim())) continue;
    if (!Number.isInteger(q.answer_index) || q.answer_index < 0 || q.answer_index > 3) continue;
    out.push({
      question: q.question.trim(),
      options: q.options.map((o) => o.trim()),
      answer_index: q.answer_index,
      explanation: typeof q.explanation === 'string' ? q.explanation.trim() : '',
      block: Number.isInteger(q.block) ? q.block : null,
    });
  }
  return out;
}

/** ReAct planning step: reason about n distinct sub-concepts + a search query each. */
async function planQuizSubtopics(topic, area, n, hasKB) {
  const messages = [
    {
      role: 'system',
      content:
`Anda agen ReAct (Reasoning + Acting) penyusun soal IT Audit. Tugas Anda MERENCANAKAN materi sebelum membuat soal.
Rencanakan ${n} sub-konsep BERBEDA untuk topik, dan untuk tiap sub-konsep tulis SATU query pencarian (Bahasa Indonesia) yang akan dipakai memanggil tool search_knowledge guna menarik materi dari dokumen regulasi (PDF/POJK) di basis pengetahuan RAG.
${hasKB
  ? 'Basis pengetahuan berisi dokumen regulasi; buat query spesifik (istilah/pasal/proses) agar retrieval relevan.'
  : 'Basis pengetahuan mungkin kosong; query tetap berguna sebagai penanda variasi sub-konsep.'}
Keluarkan HANYA JSON: {"thought":"penalaran singkat","subtopics":[{"subconcept":"...","query":"..."}]} dengan TEPAT ${n} item.`,
    },
    { role: 'user', content: `Topik: "${topic}" (area: ${area || '-'}). Rencanakan ${n} sub-konsep + query pencarian.` },
  ];
  const out = await chat(messages, { temperature: 0.4, json: true, max_tokens: 900 });
  const parsed = safeJson(out.content) || {};
  const subs = (Array.isArray(parsed.subtopics) ? parsed.subtopics : [])
    .filter((s) => s && (s.subconcept || s.query))
    .map((s) => ({
      subconcept: String(s.subconcept || s.query || topic).slice(0, 120),
      query: String(s.query || s.subconcept || topic).slice(0, 200),
    }));
  return { thought: String(parsed.thought || '').slice(0, 400), subtopics: subs, model: out.model };
}

/** Render the retrieved context for one question-block. */
function blockContext(chunks) {
  if (!chunks || !chunks.length) return '(tidak ada materi relevan di basis pengetahuan)';
  return chunks.slice(0, 3).map((c) => String(c.content).slice(0, 700)).join('\n---\n').slice(0, 1800);
}

/** Generate exactly one question per block, grounded on that block's retrieved context. */
async function groundedGeneratePerQuestion(topic, area, items) {
  const n = items.length;
  const blocks = items
    .map((it, i) => `=== BLOK ${i + 1} — sub-konsep: ${it.subconcept || topic} ===\nKONTEKS:\n${blockContext(it.context)}`)
    .join('\n\n')
    .slice(0, 12000);

  const messages = [
    { role: 'system', content: QUIZ_SYSTEM },
    {
      role: 'user',
      content:
`Buat TEPAT ${n} soal pilihan ganda untuk topik audit IT "${topic}" (area: ${area || '-'}).
Buat tepat SATU soal untuk SETIAP blok di bawah. Soal untuk blok-k HARUS membahas sub-konsep blok itu.
- Bila KONTEKS blok berisi materi relevan, soal WAJIB berbasis fakta/definisi/istilah dari KONTEKS blok itu (jangan memakai konteks blok lain, jangan mengarang).
- Bila KONTEKS blok kosong/tidak relevan, susun soal dari pengetahuan umum IT audit yang benar.
Sertakan field "block" (nomor blok 1..${n}) pada tiap soal agar dapat dipetakan ke materinya.

${blocks}

${QUIZ_SCHEMA_HINT}
Tambahan WAJIB: tiap objek soal punya "block": <nomor blok 1..${n}> sesuai blok yang menjadi dasarnya.`,
    },
  ];
  const out = await chat(messages, { temperature: 0.45, json: true, max_tokens: 4200 });
  const parsed = safeJson(out.content) || {};
  return { questions: validQuestionsWithBlock(parsed.questions), model: out.model };
}

/**
 * Generate kuis dengan ReAct + RAG per-soal.
 * @param {object} opts { search?: (q)=>Promise<chunk[]>, hasKB? }
 * @returns {{questions, model, trace, sources, groundedCount}}
 *   tiap question memuat: grounded(boolean), source(string|null), similarity, subconcept.
 */
async function generateQuizReActPerQuestion(topic, area, n = 10, opts = {}) {
  const search = opts.search || null;
  const useKB = !!search && opts.hasKB !== false;
  const trace = [];
  let model = '';

  // 1) ReAct planning — reason about n sub-concepts + per-question search queries.
  let plan;
  try { plan = await planQuizSubtopics(topic, area, n, useKB); model = plan.model; }
  catch (_) { plan = { thought: '', subtopics: [], model: '' }; }

  // Guarantee exactly n plan items (pad if the model returned fewer).
  const subs = plan.subtopics.slice(0, n);
  while (subs.length < n) {
    subs.push({ subconcept: `${topic} — aspek ${subs.length + 1}`, query: `${topic} ${area || ''}`.trim() });
  }
  trace.push({
    thought: plan.thought || `Merencanakan ${n} sub-konsep untuk "${topic}".`,
    action: 'plan_subtopics',
    action_input: subs.map((s) => s.subconcept).join(' · ').slice(0, 220),
    observation: '',
  });

  // 2) Per-question retrieval — one search_knowledge call per sub-concept.
  const items = [];
  const allChunks = [];
  for (const s of subs) {
    const results = useKB ? await safeSearch(search, s.query) : [];
    const top = results[0] || null;
    const grounded = !!(top && top.similarity >= GROUND_MIN);
    const strong = results.filter((r) => r.similarity >= GROUND_MIN);
    const ctx = strong.length ? strong : (results.length ? results.slice(0, 1) : []); // beri sedikit konteks walau di bawah ambang
    items.push({
      subconcept: s.subconcept,
      query: s.query,
      context: ctx,
      grounded,
      source: grounded ? top.source : null,
      similarity: top ? top.similarity : null,
    });
    for (const c of ctx) allChunks.push(c);
    if (useKB) {
      trace.push({
        thought: `Sub-konsep: ${s.subconcept}`,
        action: 'search_knowledge',
        action_input: s.query,
        observation: results.length
          ? `${results.length} hasil · top: ${top.source} (skor ${top.similarity})${grounded ? '' : ' — di bawah ambang, di-blend dengan pengetahuan umum'}`
          : '(tidak ada materi relevan)',
      });
    }
  }

  // 3) Grounded generation — exactly one question per block.
  const gen = await groundedGeneratePerQuestion(topic, area, items);
  model = gen.model || model;

  // Map each generated question back to its block's grounding/source (by `block`, else positional).
  const questions = gen.questions.map((q, i) => {
    const bi = (q.block && q.block >= 1 && q.block <= items.length) ? q.block - 1 : i;
    const it = items[bi] || items[i] || {};
    const topChunk = (it.context && it.context[0]) || null;
    return {
      question: q.question,
      options: q.options,
      answer_index: q.answer_index,
      explanation: q.explanation,
      grounded: !!it.grounded,
      source: it.grounded ? it.source : null,
      similarity: it.similarity ?? null,
      subconcept: it.subconcept || '',
      // Kutipan materi RAG yang menjadi dasar soal (untuk expander "lihat kutipan sumber").
      excerpt: (it.grounded && topChunk) ? String(topChunk.content).slice(0, 800) : null,
    };
  });

  const uniqChunks = [...new Map(allChunks.map((c) => [c.id, c])).values()];
  const sources = dedupeSources(uniqChunks);
  const groundedCount = questions.filter((q) => q.grounded).length;
  trace.push({
    thought: `Menyusun ${questions.length} soal — ${groundedCount} berbasis materi PDF, ${questions.length - groundedCount} dari pengetahuan umum (di-blend & ditandai).`,
    action: 'final_answer', action_input: '', observation: '',
  });

  return { questions, model, trace, sources, groundedCount };
}

module.exports = {
  chat, cfg,
  gapRecommendation, quizTopicRecommendation,
  sqlAgent, repairSql, sanitizeSql,
  generateQuiz, generateQuizReAct, groundedGenerate,
  generateQuizReActPerQuestion,
};
