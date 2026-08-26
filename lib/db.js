'use strict';
/**
 * Database layer for LLM Auditor — Postgres (Neon) + pgvector.
 *
 * Menggantikan versi node:sqlite. Dua perbedaan yang mengubah cara pakai:
 *
 *   1. SEMUA fungsi di sini async. Tidak ada lagi kueri sinkron.
 *   2. Skema & data awal TIDAK lagi dibuat otomatis saat modul dimuat.
 *      Di lingkungan serverless setiap cold start akan menjalankan DDL, jadi
 *      penyiapan dipindah ke langkah eksplisit: `npm run db:setup`.
 *
 * Placeholder memakai gaya Postgres ($1, $2, …). Agregat di-cast ke int/float8
 * karena driver mengembalikan bigint & numeric sebagai string.
 */
const fs = require('node:fs');
const path = require('node:path');
const pg = require('./pg');

const GAP_THRESHOLD = 70; // rata-rata di bawah ini = gap pengetahuan

// ---------------------------------------------------------------------------
// Skema
// ---------------------------------------------------------------------------
// Dihitung saat dipakai, bukan saat modul dimuat: di bundle Cloud Function
// (satu berkas /var/user/index.mjs) __dirname tidak menunjuk ke repo, dan
// applySchema() memang hanya dipanggil dari skrip lokal, tidak pernah runtime.
function schemaPath() {
  return path.join(__dirname, '..', 'db', 'schema.sql');
}

/** Pecah file SQL jadi pernyataan tunggal — driver HTTP hanya menerima satu
 *  pernyataan per kueri. */
function splitStatements(sqlText) {
  return sqlText
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))   // buang baris komentar
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Terapkan db/schema.sql (idempoten). Dipanggil oleh scripts/db_setup.js. */
async function applySchema() {
  const raw = fs.readFileSync(schemaPath(), 'utf8').replaceAll('{{GAP_THRESHOLD}}', String(GAP_THRESHOLD));
  for (const stmt of splitStatements(raw)) await pg.exec(stmt);
}

// ---------------------------------------------------------------------------
// Data awal (deterministik lewat PRNG ber-seed agar hasilnya bisa diulang)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIVISIONS = [
  'Finance', 'IT', 'Human Resources', 'Operations',
  'Marketing', 'Legal & Compliance', 'Internal Audit', 'Procurement',
];

const TOPICS = [
  { name: 'Access Control & IAM', area: 'Security' },
  { name: 'Network Security', area: 'Security' },
  { name: 'Data Privacy & Protection', area: 'Privacy' },
  { name: 'Incident Response', area: 'Operations' },
  { name: 'Change Management', area: 'Governance' },
  { name: 'Business Continuity & DRP', area: 'Resilience' },
  { name: 'ISO 27001 Compliance', area: 'Compliance' },
  { name: 'IT Risk Management', area: 'Governance' },
  { name: 'Application Controls', area: 'Controls' },
  { name: 'Audit Logging & Monitoring', area: 'Detection' },
];

// Topik yang sengaja lemah di tiap divisi (menghasilkan gap yang realistis).
const DIVISION_WEAKNESS = {
  'Finance': ['Network Security', 'Incident Response'],
  'IT': ['Data Privacy & Protection', 'ISO 27001 Compliance'],
  'Human Resources': ['Access Control & IAM', 'Audit Logging & Monitoring'],
  'Operations': ['Change Management', 'Business Continuity & DRP'],
  'Marketing': ['Data Privacy & Protection', 'Access Control & IAM'],
  'Legal & Compliance': ['Application Controls', 'Network Security'],
  'Internal Audit': ['Application Controls', 'IT Risk Management'],
  'Procurement': ['ISO 27001 Compliance', 'Incident Response'],
};

const NAMES = [
  'Andi Wijaya', 'Budi Santoso', 'Citra Lestari', 'Dewi Anggraini',
  'Eko Prasetyo', 'Fitri Handayani', 'Gunawan Saputra', 'Hesti Rahmawati',
  'Indra Permana', 'Joko Susilo', 'Kartika Sari', 'Lukman Hakim',
  'Maya Puspita', 'Nanda Pratama', 'Oscar Tanuwijaya', 'Putri Maharani',
  'Qori Ramadhan', 'Rina Wulandari', 'Surya Dharma', 'Tia Novita',
  'Umar Faruq', 'Vina Kusuma', 'Wahyu Nugroho', 'Xena Paramita',
  'Yusuf Maulana', 'Zahra Aulia', 'Agus Setiawan', 'Bella Anggita',
  'Candra Kirana', 'Dimas Aryo', 'Elma Safira', 'Farhan Aziz',
];

/** Kosongkan tabel operasional lalu isi ulang. Tabel RAG (pdf_*) tidak disentuh. */
async function reseed() {
  await pg.exec(`
    TRUNCATE sessions, login_attempts, quiz_sessions, quiz_attempts,
             recommendations, employees, topics, divisions
    RESTART IDENTITY CASCADE
  `);
  return seed();
}

/** Isi data dummy bila database masih kosong. */
async function seed() {
  const have = await pg.scalar('SELECT COUNT(*)::int AS c FROM divisions');
  if (have > 0) return null; // sudah terisi

  const rng = mulberry32(20240611);
  const randInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Divisi & topik — satu INSERT multi-baris per tabel (driver HTTP: hemat round trip).
  const divRows = await pg.many(
    `INSERT INTO divisions (name) SELECT unnest($1::text[]) RETURNING id, name`,
    [DIVISIONS]
  );
  const divIds = Object.fromEntries(divRows.map((d) => [d.name, d.id]));

  const topicRows = await pg.many(
    `INSERT INTO topics (name, area)
     SELECT * FROM unnest($1::text[], $2::text[]) RETURNING id, name`,
    [TOPICS.map((t) => t.name), TOPICS.map((t) => t.area)]
  );
  const topicIds = Object.fromEntries(topicRows.map((t) => [t.name, t.id]));

  // Karyawan biasa.
  const empNames = [], empEmails = [], empDivs = [];
  NAMES.forEach((name, i) => {
    const division = DIVISIONS[i % DIVISIONS.length];
    empNames.push(name);
    empEmails.push(
      name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') + '@company.co.id'
    );
    empDivs.push(divIds[division]);
  });
  const empRows = await pg.many(
    `INSERT INTO employees (name, email, role, division_id)
     SELECT n, e, 'employee', d FROM unnest($1::text[], $2::text[], $3::int[]) AS t(n, e, d)
     RETURNING id, name`,
    [empNames, empEmails, empDivs]
  );
  const employees = empRows.map((r, i) => ({
    id: r.id, name: r.name, division: DIVISIONS[i % DIVISIONS.length],
  }));

  // Akun khusus untuk login / alur persetujuan.
  const staff = await pg.many(
    `INSERT INTO employees (name, email, role, division_id)
     SELECT n, e, r, d FROM unnest($1::text[], $2::text[], $3::text[], $4::int[]) AS t(n, e, r, d)
     RETURNING id, role`,
    [
      ['Super Admin', 'Direktur Utama', 'Lead IT Auditor'],
      ['admin@company.co.id', 'director@company.co.id', 'auditor@company.co.id'],
      ['super_admin', 'director', 'auditor'],
      [divIds['IT'], divIds['Internal Audit'], divIds['Internal Audit']],
    ]
  );

  // Attempt kuis: skor = level dasar + bakat personal - kelemahan divisi + derau.
  const aEmp = [], aTopic = [], aScore = [], aWhen = [];
  const today = new Date('2026-06-01T00:00:00Z').getTime();
  for (const emp of employees) {
    const skill = randInt(-12, 12);
    const weak = DIVISION_WEAKNESS[emp.division] || [];
    for (const t of TOPICS) {
      if (rng() < 0.12) continue; // beberapa topik belum diambil
      let base = 78 + skill;
      if (weak.includes(t.name)) base -= 26;
      else if (rng() < 0.2) base += 8;
      const score = clamp(Math.round(base + randInt(-9, 9)), 8, 100);
      const attempts = rng() < 0.35 ? 2 : 1;
      for (let a = 0; a < attempts; a++) {
        const daysAgo = randInt(5, 180);
        aEmp.push(emp.id);
        aTopic.push(topicIds[t.name]);
        aScore.push(a === 0 ? score : clamp(score + randInt(-5, 10), 8, 100));
        aWhen.push(new Date(today - daysAgo * 86400000).toISOString().slice(0, 10));
      }
    }
  }
  await pg.exec(
    `INSERT INTO quiz_attempts (employee_id, topic_id, score, taken_at)
     SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::text[])`,
    [aEmp, aTopic, aScore, aWhen]
  );

  const byRole = Object.fromEntries(staff.map((s) => [s.role, s.id]));
  return { adminId: byRole.super_admin, directorId: byRole.director, auditorId: byRole.auditor };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------
async function listDivisions() {
  return pg.many('SELECT * FROM divisions ORDER BY name');
}
async function listTopics() {
  return pg.many('SELECT * FROM topics ORDER BY name');
}
async function listEmployees() {
  return pg.many(`
    SELECT e.id, e.name, e.email, e.role, d.name AS division
    FROM employees e JOIN divisions d ON d.id = e.division_id
    WHERE e.role = 'employee'
    ORDER BY d.name, e.name
  `);
}

async function overviewStats() {
  const t = await pg.one(`
    SELECT (SELECT COUNT(*)::int FROM employees WHERE role='employee') AS employees,
           (SELECT COUNT(*)::int FROM divisions) AS divisions,
           (SELECT COUNT(*)::int FROM topics) AS topics,
           (SELECT COUNT(*)::int FROM quiz_attempts) AS attempts,
           (SELECT ROUND(AVG(score))::int FROM quiz_attempts) AS "avgScore"
  `);
  const totals = { ...t, avgScore: t.avgScore || 0 };
  const byDivision = await pg.many(`
    SELECT d.name AS division,
           ROUND(AVG(qa.score))::float8 AS avg_score,
           SUM(CASE WHEN qa.score < $1 THEN 1 ELSE 0 END)::int AS gap_attempts,
           COUNT(*)::int AS attempts
    FROM quiz_attempts qa
    JOIN employees e ON e.id = qa.employee_id
    JOIN divisions d ON d.id = e.division_id
    GROUP BY d.id, d.name ORDER BY avg_score ASC
  `, [GAP_THRESHOLD]);
  const byTopic = await pg.many(`
    SELECT t.name AS topic,
           ROUND(AVG(qa.score))::float8 AS avg_score,
           COUNT(*)::int AS attempts
    FROM quiz_attempts qa
    JOIN topics t ON t.id = qa.topic_id
    GROUP BY t.id, t.name ORDER BY avg_score ASC
  `);
  return { totals, byDivision, byTopic, gapThreshold: GAP_THRESHOLD };
}

/** Skor per topik untuk satu karyawan; ditandai gap bila di bawah ambang. */
async function employeeGaps(employeeId) {
  const emp = await pg.one(`
    SELECT e.id, e.name, e.email, d.name AS division
    FROM employees e JOIN divisions d ON d.id = e.division_id
    WHERE e.id = $1
  `, [employeeId]);
  if (!emp) return null;
  // avg_score = nilai TERBAIK (MAX) per topik, konsisten dengan skor peserta.
  const topics = await pg.many(`
    SELECT t.name AS topic, t.area,
           MAX(qa.score) AS avg_score,
           COUNT(*)::int AS attempts,
           MAX(qa.taken_at) AS last_taken
    FROM quiz_attempts qa
    JOIN topics t ON t.id = qa.topic_id
    WHERE qa.employee_id = $1
    GROUP BY t.id, t.name, t.area ORDER BY avg_score ASC
  `, [employeeId]);
  const gaps = topics.filter((t) => t.avg_score < GAP_THRESHOLD);
  const overall = topics.length
    ? Math.round(topics.reduce((s, t) => s + t.avg_score, 0) / topics.length)
    : 0;
  return { employee: emp, overall, topics, gaps, gapThreshold: GAP_THRESHOLD };
}

/** Skor per topik satu divisi = rata-rata nilai TERBAIK tiap karyawan. */
async function divisionGaps(divisionId) {
  const div = await pg.one('SELECT * FROM divisions WHERE id = $1', [divisionId]);
  if (!div) return null;
  const topics = await pg.many(`
    SELECT t.name AS topic, t.area,
           ROUND(AVG(eb.best))::float8 AS avg_score,
           COUNT(*)::int AS employees,
           SUM(eb.attempts)::int AS attempts
    FROM (
      SELECT qa.topic_id, qa.employee_id,
             MAX(qa.score) AS best, COUNT(*)::int AS attempts
      FROM quiz_attempts qa
      JOIN employees e ON e.id = qa.employee_id
      WHERE e.division_id = $1 AND e.role = 'employee'
      GROUP BY qa.employee_id, qa.topic_id
    ) eb
    JOIN topics t ON t.id = eb.topic_id
    GROUP BY t.id, t.name, t.area ORDER BY avg_score ASC
  `, [divisionId]);
  const gaps = topics.filter((t) => t.avg_score < GAP_THRESHOLD);
  const overall = topics.length
    ? Math.round(topics.reduce((s, t) => s + t.avg_score, 0) / topics.length)
    : 0;
  return { division: div, overall, topics, gaps, gapThreshold: GAP_THRESHOLD };
}

/** Rata-rata skor per bulan, opsional difilter divisi/topik. */
async function scoreTrend({ divisionId, topicId } = {}) {
  const where = [];
  const params = [];
  if (divisionId) { params.push(divisionId); where.push(`e.division_id = $${params.length}`); }
  if (topicId) { params.push(topicId); where.push(`qa.topic_id = $${params.length}`); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return pg.many(`
    SELECT substr(qa.taken_at, 1, 7) AS month,
           ROUND(AVG(qa.score))::float8 AS avg_score,
           COUNT(*)::int AS attempts
    FROM quiz_attempts qa
    JOIN employees e ON e.id = qa.employee_id
    ${clause}
    GROUP BY month ORDER BY month
  `, params);
}

// Rekomendasi ---------------------------------------------------------------
async function listRecommendations(status) {
  if (status) {
    return pg.many('SELECT * FROM recommendations WHERE status = $1 ORDER BY created_at DESC', [status]);
  }
  return pg.many('SELECT * FROM recommendations ORDER BY created_at DESC');
}
async function getRecommendation(id) {
  return pg.one('SELECT * FROM recommendations WHERE id = $1', [id]);
}
async function createRecommendation(r) {
  const row = await pg.one(`
    INSERT INTO recommendations
      (scope_type, scope_ref, scope_label, title, gap_summary, recommendation,
       recommended_topics, model, created_by, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
    RETURNING *
  `, [
    r.scope_type, r.scope_ref, r.scope_label, r.title, r.gap_summary || '',
    r.recommendation || '', JSON.stringify(r.recommended_topics || []),
    r.model || '', r.created_by || 'Super Admin', new Date().toISOString(),
  ]);
  return row;
}
async function acknowledgeRecommendation(id, ackBy, ackNote) {
  await pg.exec(`
    UPDATE recommendations
    SET status='acknowledged', ack_by=$1, ack_note=$2, ack_at=$3
    WHERE id=$4 AND status='pending'
  `, [ackBy || 'Direktur', ackNote || '', new Date().toISOString(), id]);
  return getRecommendation(id);
}

// Peserta / kuis -------------------------------------------------------------
async function employeeById(id) {
  return pg.one(`
    SELECT e.id, e.name, e.email, e.role, d.name AS division
    FROM employees e JOIN divisions d ON d.id = e.division_id WHERE e.id = $1
  `, [id]);
}
async function topicById(id) {
  return pg.one('SELECT * FROM topics WHERE id = $1', [id]);
}

/** Kurikulum tetap: setiap peserta melewati SEMUA topik ini, dalam urutan ini. */
const QUIZ_ORDER = [
  'Incident Response',
  'Data Privacy & Protection',
  'ISO 27001 Compliance',
  'Access Control & IAM',
  'Network Security',
  'Application Controls',
  'Business Continuity & DRP',
  'Audit Logging & Monitoring',
  'Change Management',
  'IT Risk Management',
];
const QUESTIONS_PER_TOPIC = 10;

// Ekspresi CASE yang memetakan nama topik ke posisinya di QUIZ_ORDER, supaya
// daftar kembali dalam urutan yang ditentukan (tetap DRY dari QUIZ_ORDER).
const QUIZ_ORDER_CASE =
  'CASE t.name\n' +
  QUIZ_ORDER.map((n, i) => `         WHEN '${n.replace(/'/g, "''")}' THEN ${i + 1}`).join('\n') +
  '\n         ELSE 99 END';

// Seluruh topik dengan status peserta ini: jumlah attempt dan skor TERBAIK
// (NULL bila belum pernah diambil). Skor topik memakai MAX, bukan rata-rata,
// agar mengulang kuis hanya menaikkan nilai ketika hasilnya melampaui yang lama.
const CURRICULUM_SQL =
`SELECT t.id AS topic_id, t.name AS topic, t.area,
       COUNT(qa.id)::int AS attempts,
       MAX(qa.score) AS best_score
  FROM topics t
  LEFT JOIN quiz_attempts qa
         ON qa.topic_id = t.id
        AND qa.employee_id = $1              -- peserta yang sedang login
 GROUP BY t.id, t.name, t.area
 ORDER BY ${QUIZ_ORDER_CASE}`;

async function participantCurriculum(employeeId) {
  const emp = await employeeById(employeeId);
  if (!emp) return null;
  const rows = await pg.many(CURRICULUM_SQL, [employeeId]);
  const topics = rows.map((t) => ({
    topic_id: t.topic_id,
    topic: t.topic,
    area: t.area,
    attempts: t.attempts,
    done: t.attempts > 0,
    best_score: t.attempts > 0 ? t.best_score : null,
  }));
  const doneCount = topics.filter((t) => t.done).length;
  return {
    employee: emp,
    totalTopics: topics.length,
    doneCount,
    undoneCount: topics.length - doneCount,
    questionsPerTopic: QUESTIONS_PER_TOPIC,
    topics,
    sql: CURRICULUM_SQL.replaceAll('$1', String(employeeId)),
  };
}

/** Skor tertinggi karyawan pada satu topik + jumlah attempt. */
async function bestScoreForEmployee(employeeId, topicId) {
  const r = await pg.one(
    'SELECT MAX(score) AS m, COUNT(*)::int AS n FROM quiz_attempts WHERE employee_id = $1 AND topic_id = $2',
    [employeeId, topicId]
  );
  return { best: r.m == null ? null : r.m, attempts: r.n || 0 };
}
async function recordAttempt(employeeId, topicId, score, takenAt) {
  await pg.exec(
    'INSERT INTO quiz_attempts (employee_id, topic_id, score, taken_at) VALUES ($1, $2, $3, $4)',
    [employeeId, topicId, score, takenAt]
  );
}

async function createQuizSession(employeeId, topicId, payload, model) {
  const row = await pg.one(`
    INSERT INTO quiz_sessions (employee_id, topic_id, payload, num_questions, model, created_at)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [employeeId, topicId, JSON.stringify(payload), payload.length, model || '', new Date().toISOString()]);
  return row.id;
}
async function getQuizSession(id) {
  return pg.one('SELECT * FROM quiz_sessions WHERE id = $1', [id]);
}
async function closeQuizSession(id, score) {
  await pg.exec(
    "UPDATE quiz_sessions SET status='submitted', score=$1, submitted_at=$2 WHERE id=$3 AND status='open'",
    [score, new Date().toISOString(), id]
  );
}

// Akun & sesi ----------------------------------------------------------------
// "divisionId" WAJIB dikutip: Postgres melipat identifier tanpa kutip jadi
// huruf kecil, dan frontend membaca properti divisionId.
const ACCOUNT_FIELDS = `
  e.id, e.name, e.email, e.role, e.status, e.created_at,
  e.division_id AS "divisionId", d.name AS division`;

async function findUserByEmail(email) {
  return pg.one(`
    SELECT ${ACCOUNT_FIELDS}, e.password_hash
    FROM employees e JOIN divisions d ON d.id = e.division_id
    WHERE lower(e.email) = lower($1)
  `, [String(email || '').trim()]);
}
async function accountById(id) {
  return pg.one(`
    SELECT ${ACCOUNT_FIELDS}
    FROM employees e JOIN divisions d ON d.id = e.division_id
    WHERE e.id = $1
  `, [id]);
}
async function createUser({ name, email, passwordHash, divisionId, role = 'employee' }) {
  const row = await pg.one(`
    INSERT INTO employees (name, email, role, division_id, password_hash, status, created_at)
    VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING id
  `, [name, email, role, divisionId, passwordHash, new Date().toISOString()]);
  return accountById(row.id);
}
async function setPassword(id, passwordHash) {
  await pg.exec('UPDATE employees SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
}
/** Akun staf bawaan yang belum bisa login (kata sandi belum disetel). */
async function staffWithoutPassword() {
  return pg.many(`
    SELECT id, name, email, role FROM employees
    WHERE role <> 'employee' AND (password_hash IS NULL OR password_hash = '')
    ORDER BY id
  `);
}
/** Semua akun yang bisa masuk. */
async function listAccounts() {
  return pg.many(`
    SELECT ${ACCOUNT_FIELDS},
           (e.password_hash IS NOT NULL AND e.password_hash <> '')::int AS registered,
           (SELECT COUNT(*)::int FROM sessions s
             WHERE s.employee_id = e.id AND s.expires_at > $1) AS active_sessions
    FROM employees e JOIN divisions d ON d.id = e.division_id
    WHERE e.password_hash IS NOT NULL AND e.password_hash <> ''
    ORDER BY (e.role <> 'super_admin'), (e.created_at IS NULL),
             e.created_at DESC NULLS LAST, e.name
  `, [new Date().toISOString()]);
}
async function setUserRole(id, role) {
  await pg.exec('UPDATE employees SET role = $1 WHERE id = $2', [role, id]);
  return accountById(id);
}
async function setUserStatus(id, status) {
  await pg.exec('UPDATE employees SET status = $1 WHERE id = $2', [status, id]);
  if (status !== 'active') await deleteSessionsForUser(id);
  return accountById(id);
}

async function createSession({ tokenHash, employeeId, createdAt, expiresAt, userAgent }) {
  await pg.exec(`
    INSERT INTO sessions (token_hash, employee_id, created_at, expires_at, user_agent)
    VALUES ($1, $2, $3, $4, $5)
  `, [tokenHash, employeeId, createdAt, expiresAt, userAgent || '']);
}
async function sessionUser(tokenHash, nowIso) {
  return pg.one(`
    SELECT ${ACCOUNT_FIELDS}
    FROM sessions s
    JOIN employees e ON e.id = s.employee_id
    JOIN divisions d ON d.id = e.division_id
    WHERE s.token_hash = $1 AND s.expires_at > $2
  `, [tokenHash, nowIso]);
}
async function deleteSession(tokenHash) {
  await pg.exec('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}
async function deleteSessionsForUser(employeeId) {
  await pg.exec('DELETE FROM sessions WHERE employee_id = $1', [employeeId]);
}
async function purgeExpiredSessions(nowIso) {
  await pg.exec('DELETE FROM sessions WHERE expires_at <= $1', [nowIso]);
}

// Throttle login -------------------------------------------------------------
// Versi SQLite menyimpannya di Map in-memory; itu tidak bertahan antar-invocation
// function, sehingga proteksinya hilang. Sekarang beralas tabel.
async function getLoginAttempt(email) {
  return pg.one('SELECT email, count, first_at FROM login_attempts WHERE email = $1', [email]);
}
async function bumpLoginAttempt(email, nowIso, windowStartIso) {
  // Bila catatan lama sudah lewat jendela waktu, mulai hitungan dari satu lagi.
  await pg.exec(`
    INSERT INTO login_attempts (email, count, first_at) VALUES ($1, 1, $2)
    ON CONFLICT (email) DO UPDATE SET
      count    = CASE WHEN login_attempts.first_at <= $3 THEN 1 ELSE login_attempts.count + 1 END,
      first_at = CASE WHEN login_attempts.first_at <= $3 THEN $2 ELSE login_attempts.first_at END
  `, [email, nowIso, windowStartIso]);
}
async function clearLoginAttempts(email) {
  await pg.exec('DELETE FROM login_attempts WHERE email = $1', [email]);
}

// Pengaturan aplikasi (key/value) -------------------------------------------
async function getSetting(key, fallback = null) {
  const r = await pg.one('SELECT value FROM app_settings WHERE key = $1', [key]);
  return r ? r.value : fallback;
}
async function setSetting(key, value) {
  await pg.exec(`
    INSERT INTO app_settings (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `, [key, String(value)]);
  return getSetting(key);
}
async function getBool(key, fallback = true) {
  const v = await getSetting(key, fallback ? '1' : '0');
  return v === '1' || v === 'true';
}

// Kueri mentah read-only untuk SQL Agent.
async function runSelect(sql) {
  return pg.many(sql);
}

function schemaDescription() {
  return `-- BASE TABLES
divisions(id, name)
topics(id, name, area)
employees(id, name, email, role, division_id -> divisions.id)   -- role in (employee, auditor, director, super_admin)
quiz_attempts(id, employee_id -> employees.id, topic_id -> topics.id, score 0..100, taken_at DATE)
recommendations(id, scope_type, scope_ref, scope_label, title, gap_summary, recommendation, recommended_topics, model, created_by, status, ack_by, ack_at, created_at)

-- ANALYTICAL VIEWS (UTAMAKAN view ini untuk pertanyaan skor/gap; is_gap=1 berarti rata-rata < ${GAP_THRESHOLD})
v_employee_topic(employee_id, employee, division, topic_id, topic, avg_score, is_gap, attempts)   -- rata-rata skor per karyawan per topik
v_division_topic(division_id, division, topic_id, topic, avg_score, is_gap, employees, attempts)  -- rata-rata skor per divisi per topik
v_division_score(division_id, division, avg_score, attempts)                                      -- rata-rata skor keseluruhan per divisi
v_topic_score(topic_id, topic, area, avg_score, attempts, is_gap)                                 -- rata-rata skor keseluruhan per topik
v_employee_score(employee_id, employee, division, avg_score, attempts, gap_topics)                -- rata-rata skor + jumlah topik ber-gap per karyawan

-- Dialek: PostgreSQL. Pakai substr(taken_at, 1, 7) untuk bucket bulanan.`;
}

module.exports = {
  GAP_THRESHOLD, applySchema, seed, reseed,
  listDivisions, listTopics, listEmployees,
  overviewStats, employeeGaps, divisionGaps, scoreTrend,
  listRecommendations, getRecommendation, createRecommendation, acknowledgeRecommendation,
  employeeById, topicById, participantCurriculum, bestScoreForEmployee,
  recordAttempt, createQuizSession, getQuizSession, closeQuizSession,
  runSelect, schemaDescription,
  getSetting, setSetting, getBool,
  findUserByEmail, accountById, createUser, setPassword, staffWithoutPassword,
  listAccounts, setUserRole, setUserStatus,
  createSession, sessionUser, deleteSession, deleteSessionsForUser, purgeExpiredSessions,
  getLoginAttempt, bumpLoginAttempt, clearLoginAttempts,
};
