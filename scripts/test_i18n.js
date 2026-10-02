#!/usr/bin/env node
'use strict';
/**
 * Uji bahasa (Indonesia / English):
 *   1. Kamus public/i18n.js lengkap — setiap kunci ada di `id` DAN `en`, dan
 *      setiap kunci yang dipakai index.html / app.js memang ada di kamus.
 *   2. Bahasa soal kuis sampai ke prompt model — aturan bahasa keluaran yang
 *      benar untuk 'en', 'id', dan nilai tak dikenal (jatuh ke 'id').
 *
 *   npm run test:i18n
 *
 * AI Gateway DIPALSUKAN lewat global.fetch — tidak butuh MAKERS_MODELS_KEY.
 * Apakah model sungguhan benar-benar menulis dalam bahasa yang diminta tetap
 * harus diperiksa di deployment.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  GAGAL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- 1. Kamus --------------------------------------------------------------
const root = path.join(__dirname, '..', 'public');
const src = fs.readFileSync(path.join(root, 'i18n.js'), 'utf8');
const sandbox = { localStorage: { getItem: () => null, setItem() {} }, document: { addEventListener() {} } };
vm.createContext(sandbox);
vm.runInContext(`${src}\nthis.I18N = I18N;`, sandbox);
const { I18N } = sandbox;
const idKeys = Object.keys(I18N.id);
const enKeys = Object.keys(I18N.en);
const missingEn = idKeys.filter((k) => !(k in I18N.en));
const missingId = enKeys.filter((k) => !(k in I18N.id));
check('setiap kunci id ada di en', !missingEn.length, missingEn.join(', '));
check('setiap kunci en ada di id', !missingId.length, missingId.join(', '));

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const htmlKeys = [...html.matchAll(/data-i18n(?:-html|-placeholder|-aria-label)?="([^"]+)"/g)].map((m) => m[1]);
const badHtml = [...new Set(htmlKeys.filter((k) => !(k in I18N.id)))];
check(`kunci di index.html terdaftar (${htmlKeys.length})`, !badHtml.length, badHtml.join(', '));

const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const appKeys = [...app.matchAll(/\bt\('([a-z]+\.[A-Za-z0-9_]+)'/g)].map((m) => m[1]);
const badApp = [...new Set(appKeys.filter((k) => !(k in I18N.id)))];
check(`kunci t() di app.js terdaftar (${appKeys.length})`, !badApp.length, badApp.join(', '));

// Placeholder {x} harus sama di kedua bahasa, supaya t() tidak meninggalkan {x} mentah.
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const badVars = idKeys.filter((k) => k in I18N.en && vars(I18N.id[k]) !== vars(I18N.en[k]));
check('placeholder {var} sama di id dan en', !badVars.length, badVars.join(', '));

// --- 2. Prompt kuis --------------------------------------------------------
process.env.MAKERS_MODELS_KEY = 'uji-palsu';
const ai = require('../lib/ai');
const seen = [];
global.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  seen.push(body.messages);
  const user = body.messages[1].content;
  let content;
  if (/Rencanakan/.test(user)) {
    content = JSON.stringify({ thought: 't', subtopics: Array.from({ length: 10 }, (_, i) => ({ subconcept: `S${i}` })) });
  } else {
    const n = (user.match(/=== BLOK/g) || []).length || 10;
    content = JSON.stringify({ questions: Array.from({ length: n }, (_, i) => ({
      question: `Q${i}`, options: ['a', 'b', 'c', 'd'], answer_index: 0, explanation: 'e', block: i + 1,
    })) });
  }
  return { ok: true, json: async () => ({ model: 'palsu', choices: [{ message: { content }, finish_reason: 'stop' }] }) };
};

(async () => {
  const cases = [['en', /OUTPUT LANGUAGE: ENGLISH/], ['id', /BAHASA KELUARAN: BAHASA INDONESIA/], ['xx', /BAHASA KELUARAN: BAHASA INDONESIA/]];
  for (const [lang, rule] of cases) {
    seen.length = 0;
    const out = await ai.generateQuizPlanned('Incident Response', 'Operations', 10, null, { lang, deadline: Date.now() + 200_000 });
    check(`kuis terencana lang=${lang}: 10 soal`, out.questions.length === 10, `dapat ${out.questions.length}`);
    check(`kuis terencana lang=${lang}: semua prompt memuat aturan bahasa`, seen.length > 0 && seen.every((m) => rule.test(m[1].content)));
  }
  seen.length = 0;
  await ai.generateQuiz('Network Security', 'Security', 5, { lang: 'en' });
  check('kuis langsung lang=en memuat aturan bahasa', /OUTPUT LANGUAGE: ENGLISH/.test(seen[0][1].content));

  seen.length = 0;
  await ai.gapRecommendation({ label: 'IT', scopeType: 'division', overall: 60, topics: [], gaps: [], gapThreshold: 70 }, { lang: 'en' });
  check('rekomendasi gap lang=en: system & aturan bahasa', /English/.test(seen[0][0].content) && /OUTPUT LANGUAGE: ENGLISH/.test(seen[0][1].content));

  seen.length = 0;
  await ai.quizTopicRecommendation({ label: 'IT', scopeType: 'division', topics: [], gaps: [], gapThreshold: 70 }, ['A'], { lang: 'en' });
  check('rekomendasi topik lang=en: prioritas High|Medium|Low', /High\|Medium\|Low/.test(seen[0][1].content));

  check('normLang menolak nilai asing', ai.normLang('fr') === 'id' && ai.normLang('en') === 'en');

  console.log(`\n  ${pass} lulus, ${fail} gagal\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
