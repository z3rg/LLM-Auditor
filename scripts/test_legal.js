#!/usr/bin/env node
'use strict';
/**
 * Uji dokumen legal: pemotongan, pencarian BM25, pengayaan DeepSeek, dan
 * penyusunan soal yang berdasar pada kutipan.
 *
 *   npm run test:legal
 *
 * AI Gateway DIPALSUKAN lewat global.fetch — uji ini tidak butuh
 * MAKERS_MODELS_KEY dan tidak memanggil model sungguhan. Yang dibuktikan
 * adalah logika aplikasi: kutipan benar-benar masuk ke prompt, label hasil
 * pengayaan benar-benar memengaruhi pencarian, dan soal ditandai berdasar
 * dokumen hanya bila memang disusun dari kutipan. MUTU soal dari model
 * sungguhan tetap harus diperiksa di deployment.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-auditor-legal-'));
process.env.BLOB_LOCAL_DIR = dir;
process.env.EDGEONE_PROJECT_ID = '';
process.env.EDGEONE_BLOB_TOKEN = '';
process.env.MAKERS_MODELS_KEY = 'uji-palsu';

const db = require('../lib/db');
const legal = require('../lib/legal');
const ai = require('../lib/ai');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(` GAGAL ${label}${detail ? ` — ${detail}` : ''}`); }
}

// --- gateway palsu ----------------------------------------------------------
const calls = [];
let enrichReply = null; // fungsi (userPrompt) -> string konten
function reply(content) {
  return new Response(JSON.stringify({
    model: '@makers/uji', choices: [{ message: { content }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const system = body.messages[0].content;
  const user = body.messages[1].content;
  calls.push({ system, user });
  if (/analis regulasi/.test(system)) return reply(enrichReply(user));
  if (/MERENCANAKAN/.test(system)) {
    return reply(JSON.stringify({ thought: 'uji', subtopics: [
      { subconcept: 'Retensi jejak audit' },
      { subconcept: 'Pengujian rencana pemulihan bencana' },
      { subconcept: 'Konsep umum SIEM' },
    ] }));
  }
  // Penyusunan soal: satu soal per blok.
  const blocks = (user.match(/=== BLOK \d+/g) || []).length;
  return reply(JSON.stringify({ questions: Array.from({ length: blocks }, (_, i) => ({
    question: `Soal ${i + 1}?`, options: ['a', 'b', 'c', 'd'], answer_index: 0, explanation: 'uji', block: i + 1,
  })) }));
};

const PAGES = [
  { page: 1, text: 'PERATURAN OTORITAS JASA KEUANGAN\nTENTANG PENYELENGGARAAN TEKNOLOGI INFORMASI\nMenimbang bahwa penyelenggaraan teknologi informasi perlu diatur.' },
  { page: 2, text: 'Pasal 1\nLembaga wajib memastikan ketersediaan jejak audit atas seluruh kegiatan penyelenggaraan sistem elektronik. Jejak audit disimpan paling singkat 5 tahun dan dipantau secara berkala oleh fungsi audit intern. ' + 'Rekaman kegiatan pengguna mencakup waktu, identitas, dan jenis transaksi. '.repeat(12) },
  { page: 3, text: 'Pasal 2\nLembaga wajib memiliki rencana pemulihan bencana dan pusat pemulihan bencana yang diuji paling sedikit satu kali dalam setahun untuk menjamin kelangsungan usaha. ' + 'Pengujian melibatkan pemulihan sistem inti dan data cadangan. '.repeat(12) },
  { page: 4, text: 'PENJELASAN\nATAS PERATURAN OTORITAS JASA KEUANGAN\nPasal 1\nYang dimaksud dengan jejak audit adalah urutan kronologis catatan kegiatan pengguna sistem.' },
];

(async () => {
  try {
    await db.seed();
    const topics = await db.listTopics();
    const logging = topics.find((t) => t.name === 'Audit Logging & Monitoring');
    const bcp = topics.find((t) => t.name === 'Business Continuity & DRP');
    const iam = topics.find((t) => t.name === 'Access Control & IAM');

    console.log('pemotongan');
    const chunks = legal.chunkPages(PAGES);
    ok(chunks.length >= 2, `dokumen dipotong jadi ${chunks.length} potongan`);
    ok(chunks.some((c) => c.pasal === 'Pasal 1') && chunks.some((c) => /^Pasal 2/.test(c.pasal || '')),
      `label pasal terbaca (${chunks.map((c) => c.pasal).join(' | ')})`);
    ok(chunks.some((c) => /^Penjelasan Pasal 1/.test(c.pasal || '')), 'bagian PENJELASAN diberi label terpisah');
    ok(legal.stem('pengamanan') === legal.stem('keamanan'), `stemming konsisten (${legal.stem('pengamanan')})`);

    console.log('\npencarian (sebelum pengayaan)');
    const doc = await legal.createDocument({ title: 'POJK Uji', filename: 'uji.pdf', pages: PAGES, uploadedBy: 'uji' });
    const logHits = await legal.searchTopic(logging);
    ok(logHits.length > 0 && /Pasal 1/.test(logHits[0].pasal || ''), `topik logging -> ${logHits[0] && legal.citation(logHits[0])}`);
    const bcpHits = await legal.searchTopic(bcp);
    ok(bcpHits.length > 0 && /Pasal 2/.test(bcpHits[0].pasal || ''), `topik BCP -> ${bcpHits[0] && legal.citation(bcpHits[0])}`);

    console.log('\npengayaan DeepSeek');
    enrichReply = () => '{"chunks": [ {"i": 0, "topics": [1, 2' ; // terpotong
    let threw = false;
    try { await legal.enrichNext(doc.id, topics, ai.enrichLegalChunks); } catch (_) { threw = true; }
    const untouched = await legal.getChunks(doc.id);
    ok(threw && untouched.every((c) => !c.enriched), 'jawaban terpotong -> galat, tidak ada potongan yang ditandai selesai');

    // Tandai SEMUA potongan dengan topik IAM + kata kunci khusus: pencarian
    // IAM yang tadinya lemah harus menemukan dokumen ini karena labelnya.
    enrichReply = (user) => {
      const ids = [...user.matchAll(/### POTONGAN (\d+)/g)].map((m) => Number(m[1]));
      return JSON.stringify({ chunks: ids.map((i) => ({ i, topics: [iam.id, 999], keywords: ['identity governance', 'hak akses'] })) });
    };
    const before = await legal.searchTopic(iam);
    const out = await legal.enrichNext(doc.id, topics, ai.enrichLegalChunks);
    ok(out.remaining === 0 && out.doc.enrichedCount === out.doc.chunkCount, `pengayaan selesai (${out.doc.enrichedCount}/${out.doc.chunkCount})`);
    const enriched = await legal.getChunks(doc.id);
    ok(enriched.every((c) => c.topics.length === 1 && c.topics[0] === iam.id), 'id topik tak dikenal (999) dibuang');
    const after = await legal.searchTopic(iam);
    ok(after.length > before.length, `label topik memengaruhi pencarian IAM (${before.length} -> ${after.length} hasil)`);

    console.log('\npenyusunan soal berbasis dokumen');
    const pool = await legal.searchTopic(logging);
    const grounding = { pool, assign: (subs) => legal.assignToSubconcepts(pool, subs, logging) };
    calls.length = 0;
    const quiz = await ai.generateQuizPlanned(logging.name, logging.area, 3, grounding);
    const plan = calls.find((c) => /MERENCANAKAN/.test(c.system));
    const gen = calls.find((c) => /=== BLOK/.test(c.user));
    ok(plan && /Organisasi ini tunduk/.test(plan.user) && /POJK Uji/.test(plan.user), 'kutipan ikut membentuk rencana sub-konsep');
    ok(gen && /DASAR KETENTUAN: \[POJK Uji/.test(gen.user), 'kutipan dilampirkan pada blok soal');
    ok(gen && /Jangan menyebut nomor pasal atau angka yang tidak ada di kutipan/.test(gen.user), 'aturan anti-halusinasi pasal ada di prompt');
    ok(quiz.questions.length === 3, `3 soal tersusun (${quiz.questions.length})`);
    const g = quiz.questions.filter((q) => q.grounded);
    ok(g.length >= 1 && g.every((q) => q.source && q.source.startsWith('POJK Uji') && q.excerpt),
      `soal berbasis dokumen membawa sumber (${g.map((q) => q.source).join(' | ')})`);
    ok(quiz.trace.some((t) => t.step === 'grounded'), 'jejak mencatat jumlah soal berbasis dokumen');

    console.log('\ntanpa dokumen');
    calls.length = 0;
    const plain = await ai.generateQuizPlanned(logging.name, logging.area, 2, null);
    ok(plain.questions.every((q) => !q.grounded && !q.source), 'tanpa dokumen: tidak ada soal yang diklaim berbasis dokumen');
    ok(!calls.some((c) => /Organisasi ini tunduk|DASAR KETENTUAN/.test(c.user)), 'tanpa dokumen: prompt sama seperti sebelumnya');

    await legal.deleteDocument(doc.id);
    ok((await legal.searchTopic(logging)).length === 0, 'dokumen dihapus -> pencarian kosong');
  } catch (e) {
    fail++;
    console.log(` GAGAL eksekusi: ${e.stack || e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n  ${pass} lulus, ${fail} gagal\n`);
    process.exit(fail ? 1 : 0);
  }
})();
