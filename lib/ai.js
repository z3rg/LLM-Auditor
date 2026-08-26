'use strict';
/**
 * Wrapper tipis untuk Chat Completions ber-skema OpenAI, plus dua fitur AI:
 *   1. Rekomendasi gap pengetahuan (halaman Rekomendasi)
 *   2. Generator kuis
 *
 * Provider TUNGGAL: **AI Gateway EdgeOne Makers**, dengan model DeepSeek
 * bawaan. Tidak ada jalur vendor kedua — gateway sudah OpenAI-compatible dan
 * menyediakan model tanpa perlu akun DeepSeek sendiri, jadi satu-satunya
 * rahasia yang dibutuhkan aplikasi ini adalah MAKERS_MODELS_KEY.
 *
 * Yang DIBUANG dari versi sebelumnya, dan alasannya:
 *   · SQL Agent — state pindah ke EdgeOne Blob, dan Blob adalah object store
 *     tanpa mesin kueri. Tidak ada SQL untuk dieksekusi.
 *   · RAG / retrieval (pgvector + embedding Gemini) — dibuang bersama
 *     Postgres. Gateway Makers pun tidak punya endpoint embeddings.
 *
 * Yang DIPERTAHANKAN: perencanaan sub-konsep sebelum menyusun soal. Langkah
 * itu tidak pernah membutuhkan basis pengetahuan — ia hanya memaksa model
 * memecah topik jadi n sub-konsep berbeda lebih dulu, sehingga soalnya tidak
 * berputar di konsep yang sama. Membuangnya akan menurunkan mutu kuis tanpa
 * ada hubungannya dengan pemindahan penyimpanan.
 */
const PROVIDER = {
  label: 'EdgeOne Makers (DeepSeek)',
  url: 'https://ai-gateway.edgeone.link/v1/chat/completions',
  keyEnv: 'MAKERS_MODELS_KEY',
  modelEnv: 'MAKERS_MODEL',
  defaultModel: '@makers/deepseek-v4-flash',
  keyHint: 'Ambil di konsol Makers \u2192 Models \u2192 API Key, lalu set MAKERS_MODELS_KEY.',
};

function provider() {
  return { name: 'makers', ...PROVIDER };
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
// Fitur 1: rekomendasi gap pengetahuan
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
// Fitur 2: rekomendasi topik kuis (JSON terstruktur)
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
// Fitur 3: generator kuis
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
// Generator kuis — dua langkah: rencanakan sub-konsep, lalu susun soal
// ---------------------------------------------------------------------------
// Langkah rencana bukan sisa dari RAG: tanpa itu model cenderung menghasilkan
// sepuluh soal yang mengitari satu-dua konsep saja. Dengan memaksa n
// sub-konsep berbeda lebih dulu, cakupan soal jadi merata.

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

/** Langkah 1: pecah topik jadi n sub-konsep berbeda. */
async function planQuizSubtopics(topic, area, n) {
  const messages = [
    {
      role: 'system',
      content:
`Anda penyusun kurikulum sertifikasi IT Audit. Tugas Anda MERENCANAKAN cakupan sebelum soal dibuat.
Rencanakan ${n} sub-konsep BERBEDA yang penting untuk topik tersebut, berurutan dari fondasi ke penerapan.
Hindari sub-konsep yang tumpang tindih.
Keluarkan HANYA JSON: {"thought":"penalaran singkat","subtopics":[{"subconcept":"..."}]} dengan TEPAT ${n} item.`,
    },
    { role: 'user', content: `Topik: "${topic}" (area: ${area || '-'}). Rencanakan ${n} sub-konsep.` },
  ];
  const out = await chat(messages, { temperature: 0.4, json: true, max_tokens: 900 });
  const parsed = safeJson(out.content) || {};
  const subs = (Array.isArray(parsed.subtopics) ? parsed.subtopics : [])
    .filter((s) => s && (s.subconcept || s.query))
    .map((s) => ({ subconcept: String(s.subconcept || s.query || topic).slice(0, 120) }));
  return { thought: String(parsed.thought || '').slice(0, 400), subtopics: subs, model: out.model };
}

/** Langkah 2: tepat satu soal per sub-konsep yang direncanakan. */
async function generatePerSubtopic(topic, area, items) {
  const n = items.length;
  const blocks = items
    .map((it, i) => `=== BLOK ${i + 1} \u2014 sub-konsep: ${it.subconcept || topic} ===`)
    .join('\n');

  const messages = [
    { role: 'system', content: QUIZ_SYSTEM },
    {
      role: 'user',
      content:
`Buat TEPAT ${n} soal pilihan ganda untuk topik audit IT "${topic}" (area: ${area || '-'}).
Buat tepat SATU soal untuk SETIAP blok di bawah. Soal untuk blok-k HARUS membahas sub-konsep blok itu.
Susun soal dari pengetahuan IT audit yang benar dan tidak ambigu. Jangan mengarang standar atau pasal.
Sertakan field "block" (nomor blok 1..${n}) pada tiap soal.

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
 * Kuis terencana: rencanakan n sub-konsep, lalu satu soal per sub-konsep.
 * Jatuh kembali ke generateQuiz() bila perencanaan gagal, supaya kegagalan
 * satu panggilan tidak membuat peserta kehilangan kuisnya.
 * @returns {{questions, model, trace}}
 */
async function generateQuizPlanned(topic, area, n = 10) {
  const trace = [];
  let plan;
  try {
    plan = await planQuizSubtopics(topic, area, n);
  } catch (e) {
    trace.push({ step: 'plan', error: String(e.message || e) });
    plan = { thought: '', subtopics: [], model: '' };
  }
  if (plan.thought) trace.push({ step: 'plan', thought: plan.thought });

  // Pastikan tepat n item; lengkapi bila model mengembalikan lebih sedikit.
  const items = plan.subtopics.slice(0, n);
  while (items.length < n) items.push({ subconcept: `${topic} \u2014 aspek ${items.length + 1}` });
  trace.push({ step: 'subtopics', subtopics: items.map((i) => i.subconcept) });

  const gen = await generatePerSubtopic(topic, area, items);
  let questions = gen.questions;
  if (questions.length < n) {
    trace.push({ step: 'fallback', reason: `hanya ${questions.length}/${n} soal lolos validasi` });
    const extra = await generateQuiz(topic, area, n - questions.length);
    questions = questions.concat(extra.questions);
  }
  questions = questions.slice(0, n).map((q, i) => ({
    ...q,
    subconcept: items[(q.block || i + 1) - 1] ? items[(q.block || i + 1) - 1].subconcept : null,
  }));
  return { questions, model: gen.model || plan.model, trace };
}

module.exports = {
  chat, cfg,
  gapRecommendation, quizTopicRecommendation,
  generateQuiz, generateQuizPlanned,
};
