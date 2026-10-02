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
 *     Penggantinya ada di lib/legal.js: vektor BM25 lokal atas PDF legal yang
 *     diunggah, diperkaya DeepSeek lewat enrichLegalChunks() di bawah.
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
  defaultModel: '@makers/deepseek-v4-pro',
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

  // Batas waktu WAJIB ada: tanpa ini panggilan yang menggantung menahan
  // request sampai batas platform (300 detik) lalu mati tanpa keterangan —
  // persis yang terjadi saat generate kuis "diam" berpuluh detik lalu gagal.
  const controller = new AbortController();
  // 60 detik, bukan lebih: mode terencana bisa memanggil model sampai tiga kali
  // (rencana, susun, cadangan). Pada 90 detik, tiga panggilan yang sama-sama
  // lambat sudah melewati batas agent 300 detik dan mati tanpa keterangan.
  const timeoutMs = Number(opts.timeoutMs || process.env.LLM_TIMEOUT_MS || 60_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(p.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`${p.label} tidak menjawab dalam ${Math.round(timeoutMs / 1000)} detik (model ${body.model}).`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${p.label} API ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  // Model penalar (deepseek-v4) memisahkan penalaran dari jawaban. Bila
  // anggaran token habis di penalaran, `content` bisa kosong sementara
  // `reasoning_content` terisi — balasan 200 yang isinya hampa.
  const message = choice?.message || {};
  const content = message.content ?? '';
  return {
    content,
    reasoning: message.reasoning_content || message.reasoning || '',
    // finish_reason 'length' berarti jawabannya TERPOTONG — penyebab paling
    // sering "0 soal valid", karena JSON yang terpotong tidak bisa di-parse.
    finishReason: choice?.finish_reason || '',
    model: data.model,
    usage: data.usage,
  };
}

/**
 * Balasan kosong adalah KEGAGALAN, bukan hasil.
 *
 * Tanpa ini panggilan yang mengembalikan 200 dengan content kosong mengalir
 * diam-diam sampai ke basis data, dan pengguna melihat rekomendasi hampa tanpa
 * satu pun pesan galat — persis bug yang dilaporkan.
 */
function assertNotEmpty(out, label) {
  if (out && typeof out.content === 'string' && out.content.trim()) return;
  const why = out && out.finishReason === 'length'
    ? 'anggaran token habis sebelum jawaban ditulis (finish_reason=length)'
    : out && out.reasoning
      ? 'model hanya mengembalikan penalaran tanpa jawaban akhir'
      : `model membalas kosong (finish_reason=${(out && out.finishReason) || 'tidak diketahui'})`;
  throw new Error(`${label} gagal: ${why}.`);
}

// ---------------------------------------------------------------------------
// Bahasa keluaran (id | en)
// ---------------------------------------------------------------------------
// Prompt tetap ditulis dalam Bahasa Indonesia — model memahaminya dengan baik —
// tetapi BAHASA JAWABAN ditentukan pengguna. Aturan bahasa diletakkan di akhir
// pesan user karena di posisi itulah model paling konsisten mematuhinya.
const LANGS = ['id', 'en'];
function normLang(lang) { return LANGS.includes(lang) ? lang : 'id'; }
function langName(lang) { return normLang(lang) === 'en' ? 'Bahasa Inggris (English)' : 'Bahasa Indonesia'; }
function langRule(lang, { legal = false } = {}) {
  if (normLang(lang) === 'en') {
    return '\n\nOUTPUT LANGUAGE: ENGLISH. Write every human-readable text value in English. ' +
      'Keep JSON keys exactly as specified.' +
      (legal
        ? ' Source excerpts may be in Indonesian: translate their content faithfully into English, ' +
          'but keep document titles and article numbers (e.g. "Pasal 12") as cited.'
        : '');
  }
  return '\n\nBAHASA KELUARAN: BAHASA INDONESIA. Tulis seluruh teks yang dibaca manusia dalam Bahasa Indonesia. ' +
    'Nama kunci JSON tetap persis seperti skema.';
}

function safeJson(str) {
  try { return JSON.parse(str); } catch (_) {}
  const m = str.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  const salvaged = salvageQuestions(str);
  return salvaged.length ? { questions: salvaged } : null;
}

/**
 * Ambil objek soal yang UTUH dari JSON yang terpotong.
 *
 * Jawaban model sering terpotong di tengah ketika max_tokens habis, dan
 * JSON.parse menolak seluruhnya — sepuluh soal bagus terbuang hanya karena
 * soal kesebelas separuh jadi. Di sini tiap objek `{...}` yang seimbang
 * dipungut satu per satu, sehingga yang sudah lengkap tetap terpakai.
 */
function salvageQuestions(str) {
  return salvageObjects(str, (obj) => typeof obj.question === 'string' && Array.isArray(obj.options));
}

/** Pungut setiap objek `{...}` yang utuh dan lolos `accept`, dari JSON yang mungkin terpotong. */
function salvageObjects(str, accept) {
  const out = [];
  // Tumpukan indeks '{' yang masih terbuka. Objek soal berada DI DALAM
  // pembungkus {"questions":[...]}, jadi menangkap hanya objek terluar tidak
  // akan pernah berhasil pada jawaban terpotong — pembungkusnya justru yang
  // tidak pernah tertutup.
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { stack.push(i); continue; }
    if (c === '}' && stack.length) {
      const from = stack.pop();
      try {
        const obj = JSON.parse(str.slice(from, i + 1));
        if (obj && accept(obj)) out.push(obj);
      } catch (_) { /* potongan ini tidak utuh */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fitur 1: rekomendasi gap pengetahuan
// ---------------------------------------------------------------------------
async function gapRecommendation(gapData, { lang } = {}) {
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
        `yang ringkas, konkret, dan actionable dalam ${langName(lang)}. Gunakan istilah ` +
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

Format jawaban dengan heading markdown yang rapi.${langRule(lang)}${normLang(lang) === 'en' ? ' Use High/Medium/Low for priority and risk levels.' : ''}`,
    },
  ];
  // 1100 terlalu ketat untuk model penalar: penalarannya sendiri bisa
  // menghabiskan seluruh anggaran sehingga jawabannya kosong.
  const out = await chat(messages, { temperature: 0.35, max_tokens: 4000 });
  assertNotEmpty(out, 'Rekomendasi gap');
  return out;
}

// ---------------------------------------------------------------------------
// Fitur 2: rekomendasi topik kuis (JSON terstruktur)
// ---------------------------------------------------------------------------
async function quizTopicRecommendation(gapData, availableTopics, { lang } = {}) {
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
        `Semua teks naratif dalam ${langName(lang)}.`,
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
      "priority": "${normLang(lang) === 'en' ? 'High|Medium|Low' : 'Tinggi|Sedang|Rendah'}",
      "reason": "alasan singkat berbasis skor",
      "suggested_subtopics": ["...", "..."],
      "target_score": 85
    }
  ]
}${langRule(lang)}`,
    },
  ];
  const out = await chat(messages, { temperature: 0.3, json: true, max_tokens: 4000 });
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

function quizSystem(lang) {
  return 'Anda penyusun soal sertifikasi IT Audit. Buat soal PILIHAN GANDA berkualitas, tingkat ' +
    `menengah, dalam ${langName(lang)}. Tepat 4 opsi per soal dan TEPAT SATU jawaban benar. ` +
    'Keluarkan HANYA JSON valid sesuai skema.';
}

const QUIZ_SCHEMA_HINT =
`Skema JSON PERSIS:
{"questions":[{"question":"...","options":["opsi A","opsi B","opsi C","opsi D"],"answer_index":0,"explanation":"alasan singkat"}]}
answer_index adalah indeks 0..3 dari opsi yang BENAR.`;

// ---------------------------------------------------------------------------
// Anggaran waktu kuis
// ---------------------------------------------------------------------------
// Batas 60 detik PER PANGGILAN terlalu pendek untuk deepseek-v4-pro menulis
// sepuluh soal (model penalar: berpikir dulu, baru menulis). Batas yang
// sebenarnya adalah watchdog agent (280 detik) untuk SELURUH request, jadi
// tiap panggilan mendapat sisa waktu menuju tenggat bersama, bukan angka tetap.
const MIN_CALL_MS = 20_000; // di bawah ini panggilan hampir pasti gagal — jangan dimulai

/** Batas waktu satu panggilan: `cap`, tetapi tidak melewati tenggat request. */
function callTimeout(deadline, cap) {
  if (!deadline) return cap;
  // Minimal 1 detik: chat() membaca 0 sebagai "pakai bawaan 60 detik".
  return Math.max(1_000, Math.min(cap, deadline - Date.now() - 2_000));
}
function hasTime(deadline, need = MIN_CALL_MS) {
  return !deadline || deadline - Date.now() - 2_000 >= need;
}

async function generateQuiz(topic, area, n = 10, { deadline, lang } = {}) {
  const messages = [
    { role: 'system', content: quizSystem(lang) },
    {
      role: 'user',
      content:
`Buat ${n} soal pilihan ganda untuk topik audit IT "${topic}" (area: ${area || '-'}).
Variasikan sub-konsep dalam topik. Hindari soal duplikat. Jawaban harus tidak ambigu.
${QUIZ_SCHEMA_HINT}${langRule(lang)}`,
    },
  ];
  const out = await chat(messages, {
    temperature: 0.5, json: true, max_tokens: 8000,
    timeoutMs: callTimeout(deadline, 180_000),
  });
  const parsed = safeJson(out.content) || {};
  return {
    questions: validQuestions(parsed.questions),
    model: out.model,
    finishReason: out.finishReason,
    rawLength: (out.content || '').length,
  };
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

/** Kutipan dokumen legal sebagai teks prompt, dipotong agar prompt tetap ringkas. */
function excerptBlock(x, max = 900) {
  const cite = [x.docTitle, x.page ? `hlm. ${x.page}` : null, x.pasal].filter(Boolean).join(', ');
  const text = x.text.length > max ? `${x.text.slice(0, max)}…` : x.text;
  return `[${cite}]\n${text.replace(/\s+/g, ' ').trim()}`;
}

/** Langkah 1: pecah topik jadi n sub-konsep berbeda. */
async function planQuizSubtopics(topic, area, n, legalContext = [], { deadline, lang } = {}) {
  // Dengan dokumen legal, rencana diarahkan ke kewajiban yang benar-benar
  // diatur di sana — inilah titik dokumen memengaruhi CAKUPAN kuis, bukan
  // sekadar menempelkan kutipan pada soal yang sudah jadi.
  const legalNote = legalContext.length
    ? `\nOrganisasi ini tunduk pada ketentuan berikut. Utamakan sub-konsep yang DIATUR di dalamnya
(kewajiban, batas waktu, pihak yang bertanggung jawab, pelaporan); sisanya boleh dari praktik IT audit umum.

${legalContext.map((x, i) => `K${i + 1}. ${excerptBlock(x, 600)}`).join('\n\n')}\n`
    : '';
  const messages = [
    {
      role: 'system',
      content:
`Anda penyusun kurikulum sertifikasi IT Audit. Tugas Anda MERENCANAKAN cakupan sebelum soal dibuat.
Rencanakan ${n} sub-konsep BERBEDA yang penting untuk topik tersebut, berurutan dari fondasi ke penerapan.
Hindari sub-konsep yang tumpang tindih.
Keluarkan HANYA JSON: {"thought":"penalaran singkat","subtopics":[{"subconcept":"..."}]} dengan TEPAT ${n} item.`,
    },
    { role: 'user', content: `Topik: "${topic}" (area: ${area || '-'}). Rencanakan ${n} sub-konsep.${legalNote}${langRule(lang, { legal: legalContext.length > 0 })}` },
  ];
  // Rencana dibatasi 60 detik: bila gagal, soal tetap bisa disusun dengan
  // sub-konsep generik, jadi waktu lebih berharga untuk langkah penyusunan.
  const out = await chat(messages, {
    temperature: 0.4, json: true, max_tokens: legalContext.length ? 2500 : 900,
    timeoutMs: callTimeout(deadline, 60_000),
  });
  const parsed = safeJson(out.content) || {};
  const subs = (Array.isArray(parsed.subtopics) ? parsed.subtopics : [])
    .filter((s) => s && (s.subconcept || s.query))
    .map((s) => ({ subconcept: String(s.subconcept || s.query || topic).slice(0, 120) }));
  return { thought: String(parsed.thought || '').slice(0, 400), subtopics: subs, model: out.model };
}

/** Langkah 2: tepat satu soal per sub-konsep yang direncanakan. */
async function generatePerSubtopic(topic, area, items, { deadline, lang } = {}) {
  const n = items.length;
  const grounded = items.some((it) => it.excerpt);
  const blocks = items
    .map((it, i) => {
      const head = `=== BLOK ${i + 1} \u2014 sub-konsep: ${it.subconcept || topic} ===`;
      return it.excerpt ? `${head}\nDASAR KETENTUAN: ${excerptBlock(it.excerpt)}` : head;
    })
    .join('\n\n');
  const legalRules = grounded
    ? `
Untuk blok yang memiliki DASAR KETENTUAN:
- Soal HARUS menguji isi ketentuan itu (kewajiban, syarat, batas waktu, pihak, atau pengecualian yang tertulis).
- Jawaban benar harus dapat dibuktikan langsung dari kutipan; pengecoh harus masuk akal tetapi bertentangan dengan kutipan.
- "explanation" menyebut dasar ketentuannya (judul dokumen dan pasal) dengan singkat.
- Jangan menyebut nomor pasal atau angka yang tidak ada di kutipan.
Blok tanpa DASAR KETENTUAN disusun dari pengetahuan IT audit umum.`
    : '';

  const messages = [
    { role: 'system', content: quizSystem(lang) },
    {
      role: 'user',
      content:
`Buat TEPAT ${n} soal pilihan ganda untuk topik audit IT "${topic}" (area: ${area || '-'}).
Buat tepat SATU soal untuk SETIAP blok di bawah. Soal untuk blok-k HARUS membahas sub-konsep blok itu.
Susun soal dari pengetahuan IT audit yang benar dan tidak ambigu. Jangan mengarang standar atau pasal.
Sertakan field "block" (nomor blok 1..${n}) pada tiap soal.${legalRules}

${blocks}

${QUIZ_SCHEMA_HINT}
Tambahan WAJIB: tiap objek soal punya "block": <nomor blok 1..${n}> sesuai blok yang menjadi dasarnya.${langRule(lang, { legal: grounded })}`,
    },
  ];
  const out = await chat(messages, {
    temperature: grounded ? 0.3 : 0.45, json: true, max_tokens: 6000,
    timeoutMs: callTimeout(deadline, 180_000),
  });
  const parsed = safeJson(out.content) || {};
  return {
    questions: validQuestionsWithBlock(parsed.questions),
    model: out.model,
    finishReason: out.finishReason,
    rawLength: (out.content || '').length,
  };
}

/**
 * Kuis terencana: rencanakan n sub-konsep, lalu satu soal per sub-konsep.
 * Jatuh kembali ke generateQuiz() bila perencanaan gagal, supaya kegagalan
 * satu panggilan tidak membuat peserta kehilangan kuisnya.
 * @returns {{questions, model, trace}}
 */
async function generateQuizPlanned(topic, area, n = 10, grounding = null, { deadline, lang } = {}) {
  const trace = [];
  const pool = (grounding && grounding.pool) || [];
  if (pool.length) trace.push({ step: 'legal', found: pool.length });
  let plan;
  try {
    plan = await planQuizSubtopics(topic, area, n, pool.slice(0, 6), { deadline, lang });
  } catch (e) {
    trace.push({ step: 'plan', error: String(e.message || e) });
    plan = { thought: '', subtopics: [], model: '' };
  }
  if (plan.thought) trace.push({ step: 'plan', thought: plan.thought });

  // Pastikan tepat n item; lengkapi bila model mengembalikan lebih sedikit.
  const items = plan.subtopics.slice(0, n);
  const aspect = normLang(lang) === 'en' ? 'aspect' : 'aspek';
  while (items.length < n) items.push({ subconcept: `${topic} \u2014 ${aspect} ${items.length + 1}` });
  // Tiap sub-konsep mendapat kutipan paling cocok dari kumpulan kandidat.
  if (pool.length && grounding.assign) {
    const picks = await grounding.assign(items.map((it) => it.subconcept));
    picks.forEach((x, i) => { if (x) items[i].excerpt = x; });
  }
  trace.push({ step: 'subtopics', subtopics: items.map((i) => i.subconcept) });

  if (!hasTime(deadline)) {
    throw new Error('Waktu habis setelah merencanakan sub-konsep — model terlalu lambat. Coba lagi, atau pakai model yang lebih cepat.');
  }

  // Dua panggilan PARALEL masing-masing ≤5 soal: model penalar menulis jauh
  // lebih lama untuk sepuluh soal sekaligus, dan waktu tunggunya kini kira-kira
  // separuh. Nomor blok tiap kelompok dikembalikan ke nomor global.
  const size = n > 5 ? Math.ceil(n / 2) : n;
  const groups = [];
  for (let at = 0; at < n; at += size) groups.push({ at, items: items.slice(at, at + size) });
  const settled = await Promise.allSettled(
    groups.map((g) => generatePerSubtopic(topic, area, g.items, { deadline, lang })),
  );
  let questions = [];
  let gen = { model: '', finishReason: '', rawLength: 0 };
  let lastError = null;
  settled.forEach((r, k) => {
    if (r.status === 'rejected') {
      lastError = r.reason;
      trace.push({ step: 'generate', group: k + 1, error: String((r.reason && r.reason.message) || r.reason) });
      return;
    }
    const g = r.value;
    gen = { model: g.model || gen.model, finishReason: g.finishReason || gen.finishReason, rawLength: gen.rawLength + (g.rawLength || 0) };
    trace.push({ step: 'generate', group: k + 1, finishReason: g.finishReason, rawLength: g.rawLength, valid: g.questions.length });
    const offset = groups[k].at;
    // Blok di luar rentang kelompoknya dianggap tanpa blok, bukan dipetakan ke
    // sub-konsep (dan kutipan) kelompok lain.
    for (const q of g.questions) {
      const ok = q.block && q.block >= 1 && q.block <= groups[k].items.length;
      questions.push({ ...q, block: ok ? offset + q.block : null });
    }
  });
  if (questions.length < n) {
    if (hasTime(deadline, 45_000)) {
      trace.push({ step: 'fallback', reason: `hanya ${questions.length}/${n} soal lolos validasi` });
      try {
        const extra = await generateQuiz(topic, area, n - questions.length, { deadline, lang });
        questions = questions.concat(extra.questions);
      } catch (e) { lastError = e; trace.push({ step: 'fallback', error: String(e.message || e) }); }
    } else {
      trace.push({ step: 'fallback', reason: 'dilewati — sisa waktu tidak cukup' });
    }
  }
  // Tidak ada satu soal pun: teruskan galat model yang sebenarnya (mis. batas
  // waktu) agar pesannya sampai ke pengguna, bukan "0 soal valid".
  if (!questions.length && lastError) throw lastError;
  questions = questions.slice(0, n).map((q, i) => {
    // Soal cadangan (dari generateQuiz) tidak punya blok, jadi tidak diklaim
    // berbasis dokumen meski posisinya kebetulan sejajar dengan blok berkutipan.
    const item = q.block ? items[q.block - 1] : null;
    const excerpt = item && item.excerpt;
    return {
      ...q,
      subconcept: item ? item.subconcept : (items[i] ? items[i].subconcept : null),
      grounded: !!excerpt,
      source: excerpt ? [excerpt.docTitle, excerpt.page ? `hlm. ${excerpt.page}` : null, excerpt.pasal].filter(Boolean).join(' · ') : null,
      excerpt: excerpt ? excerpt.text.slice(0, 700) : null,
      similarity: excerpt ? excerpt.score : null,
    };
  });
  const groundedCount = questions.filter((q) => q.grounded).length;
  if (pool.length) trace.push({ step: 'grounded', count: groundedCount });
  return { questions, model: gen.model || plan.model, trace, finishReason: gen.finishReason, rawLength: gen.rawLength };
}

// ---------------------------------------------------------------------------
// Fitur 4: pengayaan potongan dokumen legal (pengganti embedding)
// ---------------------------------------------------------------------------
/**
 * Beri tiap potongan kata kunci Indonesia+Inggris dan petakan ke topik kuis.
 * Hasilnya ikut dihitung dalam vektor BM25 lib/legal.js, sehingga kueri
 * berbahasa Inggris ("Incident Response") menemukan pasal berbahasa Indonesia.
 *
 * Jawaban yang TERPOTONG (finish_reason=length) tidak dibuang: deepseek-v4
 * adalah model penalar yang menghabiskan anggaran di reasoning_content lebih
 * dulu, jadi pemotongan adalah kejadian normal. Label yang sudah utuh
 * dikembalikan dengan `truncated: true`; sisanya diproses panggilan berikutnya.
 * @returns {Promise<{tags:{i:number, keywords:string[], topics:number[]}[], truncated:boolean}>}
 */
async function enrichLegalChunks(chunks, topics) {
  const topicList = topics.map((t) => `${t.id}. ${t.name} (${t.area || '-'})`).join('\n');
  const body = chunks
    .map((c) => `### POTONGAN ${c.i}${c.pasal ? ` (${c.pasal})` : ''}\n${c.text.replace(/\s+/g, ' ').slice(0, 900)}`)
    .join('\n\n');
  const messages = [
    {
      role: 'system',
      content:
        'Anda analis regulasi TI dan audit. Untuk tiap potongan peraturan, tentukan topik audit TI ' +
        'yang relevan dan kata kunci pencarian. Keluarkan HANYA JSON valid.',
    },
    {
      role: 'user',
      content:
`Daftar topik (id. nama):
${topicList}

Untuk SETIAP potongan di bawah:
- "topics": id topik yang BENAR-BENAR dibahas (0-3 id; kosong bila tidak ada, mis. pembukaan atau ketentuan peralihan).
- "keywords": 6-10 kata kunci/frasa pendek — campur istilah Indonesia dan padanan Inggrisnya
  (mis. "jejak audit", "audit trail", "rencana pemulihan bencana", "disaster recovery").
Tugas ini klasifikasi sederhana: putuskan cepat, jangan menganalisis panjang.

Skema PERSIS: {"chunks":[{"i":<nomor potongan>,"topics":[1,4],"keywords":["...","..."]}]}

${body}`,
    },
  ];
  const out = await chat(messages, {
    temperature: 0.1, json: true, max_tokens: 8000,
    // Model terpisah boleh dipilih untuk pengayaan (mis. varian flash yang lebih cepat).
    model: process.env.MAKERS_ENRICH_MODEL || undefined,
    // Satu panggilan per request; dua kali ini (dengan percobaan ulang di
    // lib/legal.js) masih di bawah watchdog agent 280 detik.
    timeoutMs: 120_000,
  });
  let list = null;
  try { const parsed = JSON.parse(out.content); if (Array.isArray(parsed.chunks)) list = parsed.chunks; } catch (_) {}
  const truncated = !list;
  if (!list) {
    list = salvageObjects(out.content || '', (x) => Number.isInteger(x.i) && Array.isArray(x.keywords));
  }
  // Tanpa satu label pun: GAGAL, bukan "tanpa label" — kalau tidak, satu
  // jawaban kosong menandai seluruh kelompok selesai tanpa tag.
  if (!list.length) {
    const why = out.finishReason === 'length'
      ? 'anggaran token habis sebelum label pertama selesai (finish_reason=length)'
      : `jawaban model bukan JSON yang sah (finish_reason=${out.finishReason || '-'})`;
    const err = new Error(`Pengayaan dokumen gagal: ${why}.`);
    err.truncated = true;
    throw err;
  }
  const tags = list
    .filter((x) => x && Number.isInteger(x.i))
    .map((x) => ({
      i: x.i,
      topics: (Array.isArray(x.topics) ? x.topics : []).map(Number).filter(Number.isInteger).slice(0, 3),
      keywords: (Array.isArray(x.keywords) ? x.keywords : [])
        .filter((k) => typeof k === 'string' && k.trim())
        .map((k) => k.trim().slice(0, 60)),
    }));
  return { tags, truncated };
}

module.exports = {
  chat, cfg, enrichLegalChunks, normLang, LANGS,
  gapRecommendation, quizTopicRecommendation,
  generateQuiz, generateQuizPlanned,
};
