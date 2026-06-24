'use strict';
/**
 * Database layer for LLM Auditor.
 * Uses Node's built-in node:sqlite (no native compilation needed).
 * Holds dummy IT-audit quiz data and the recommendation/acknowledgement state.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// DB_PATH dapat di-override (mis. ke volume Docker /app/data/auditor.db).
// Default lokal: ./data/auditor.db (direktori dibuat otomatis di bawah).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'auditor.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); // pastikan direktori ada
// allowExtension: izinkan memuat ekstensi sqlite-vec (lihat lib/vec.js).
const db = new DatabaseSync(DB_PATH, { allowExtension: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const GAP_THRESHOLD = 70; // average score below this = knowledge gap

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS divisions (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS topics (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      area TEXT
    );
    CREATE TABLE IF NOT EXISTS employees (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT,
      role        TEXT NOT NULL DEFAULT 'employee',  -- employee | auditor | director | super_admin
      division_id INTEGER NOT NULL REFERENCES divisions(id)
    );
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id          INTEGER PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      topic_id    INTEGER NOT NULL REFERENCES topics(id),
      score       INTEGER NOT NULL,   -- 0..100
      taken_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recommendations (
      id                  INTEGER PRIMARY KEY,
      scope_type          TEXT NOT NULL,            -- employee | division
      scope_ref           INTEGER NOT NULL,
      scope_label         TEXT NOT NULL,
      title               TEXT NOT NULL,
      gap_summary         TEXT,
      recommendation      TEXT,
      recommended_topics  TEXT,                     -- JSON string
      model               TEXT,
      created_by          TEXT,
      status              TEXT NOT NULL DEFAULT 'pending', -- pending | acknowledged
      ack_by              TEXT,
      ack_note            TEXT,
      ack_at              TEXT,
      created_at          TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quiz_sessions (
      id            INTEGER PRIMARY KEY,
      employee_id   INTEGER NOT NULL REFERENCES employees(id),
      topic_id      INTEGER NOT NULL REFERENCES topics(id),
      payload       TEXT NOT NULL,        -- JSON: questions w/ answer_index + explanation
      num_questions INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',  -- open | submitted
      score         INTEGER,
      model         TEXT,
      created_at    TEXT NOT NULL,
      submitted_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Analytical VIEWs that bake the "gap" semantics (avg score < threshold) into
  // the data layer, so the SQL Agent can answer gap questions reliably.
  db.exec(`
    DROP VIEW IF EXISTS v_employee_topic;
    DROP VIEW IF EXISTS v_division_topic;
    DROP VIEW IF EXISTS v_division_score;
    DROP VIEW IF EXISTS v_topic_score;
    DROP VIEW IF EXISTS v_employee_score;

    -- Skor seorang karyawan pada satu topik = nilai TERBAIK (MAX) attempt-nya,
    -- konsisten dengan tampilan peserta & logika retake (hanya nilai lebih
    -- tinggi yang disimpan). is_gap=1 bila nilai terbaik < ambang gap.
    CREATE VIEW v_employee_topic AS
      SELECT e.id AS employee_id, e.name AS employee, d.name AS division,
             t.id AS topic_id, t.name AS topic,
             MAX(qa.score) AS avg_score,
             CASE WHEN MAX(qa.score) < ${GAP_THRESHOLD} THEN 1 ELSE 0 END AS is_gap,
             COUNT(*) AS attempts
      FROM quiz_attempts qa
      JOIN employees e ON e.id = qa.employee_id
      JOIN divisions d ON d.id = e.division_id
      JOIN topics t ON t.id = qa.topic_id
      WHERE e.role = 'employee'
      GROUP BY e.id, t.id;

    -- Agregat berikut diturunkan dari v_employee_topic sehingga "avg_score"
    -- berarti rata-rata dari nilai TERBAIK tiap karyawan (bukan rata-rata semua
    -- attempt) — agar perbaikan skor peserta langsung tercermin di analisis gap.
    CREATE VIEW v_division_topic AS
      SELECT d.id AS division_id, et.division, et.topic_id, et.topic,
             ROUND(AVG(et.avg_score), 1) AS avg_score,
             CASE WHEN AVG(et.avg_score) < ${GAP_THRESHOLD} THEN 1 ELSE 0 END AS is_gap,
             COUNT(*) AS employees, SUM(et.attempts) AS attempts
      FROM v_employee_topic et
      JOIN divisions d ON d.name = et.division
      GROUP BY d.id, et.topic_id;

    CREATE VIEW v_division_score AS
      SELECT d.id AS division_id, et.division,
             ROUND(AVG(et.avg_score), 1) AS avg_score, SUM(et.attempts) AS attempts
      FROM v_employee_topic et
      JOIN divisions d ON d.name = et.division
      GROUP BY d.id;

    CREATE VIEW v_topic_score AS
      SELECT et.topic_id, et.topic, t.area,
             ROUND(AVG(et.avg_score), 1) AS avg_score, SUM(et.attempts) AS attempts,
             CASE WHEN AVG(et.avg_score) < ${GAP_THRESHOLD} THEN 1 ELSE 0 END AS is_gap
      FROM v_employee_topic et
      JOIN topics t ON t.id = et.topic_id
      GROUP BY et.topic_id;

    -- Built from v_employee_topic (already one row per employee-topic) to avoid
    -- row multiplication; avg_score is the mean of per-topic BEST scores.
    CREATE VIEW v_employee_score AS
      SELECT et.employee_id, et.employee, et.division,
             ROUND(AVG(et.avg_score), 1) AS avg_score,
             SUM(et.attempts) AS attempts,
             SUM(et.is_gap) AS gap_topics
      FROM v_employee_topic et
      GROUP BY et.employee_id;
  `);
}

// ---------------------------------------------------------------------------
// Seed data (deterministic via a seeded PRNG so results are reproducible)
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

// Topics each division is intentionally weak at (drives realistic gaps).
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

function reseed() {
  db.exec(`
    DELETE FROM quiz_sessions;
    DELETE FROM quiz_attempts;
    DELETE FROM recommendations;
    DELETE FROM employees;
    DELETE FROM topics;
    DELETE FROM divisions;
  `);
  seed();
}

function seed() {
  const haveDivisions = db.prepare('SELECT COUNT(*) c FROM divisions').get().c;
  if (haveDivisions > 0) return; // already seeded

  const rng = mulberry32(20240611);
  const randInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const insDiv = db.prepare('INSERT INTO divisions (name) VALUES (?)');
  const divIds = {};
  for (const d of DIVISIONS) divIds[d] = Number(insDiv.run(d).lastInsertRowid);

  const insTopic = db.prepare('INSERT INTO topics (name, area) VALUES (?, ?)');
  const topicIds = {};
  for (const t of TOPICS) topicIds[t.name] = Number(insTopic.run(t.name, t.area).lastInsertRowid);

  // Employees: distribute names across divisions; assign special roles.
  const insEmp = db.prepare(
    'INSERT INTO employees (name, email, role, division_id) VALUES (?, ?, ?, ?)'
  );
  const employees = [];
  NAMES.forEach((name, i) => {
    const division = DIVISIONS[i % DIVISIONS.length];
    const email =
      name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') +
      '@company.co.id';
    const id = Number(insEmp.run(name, email, 'employee', divIds[division]).lastInsertRowid);
    employees.push({ id, name, division });
  });

  // Special accounts used for login / workflow.
  const adminId = Number(
    insEmp.run('Super Admin', 'admin@company.co.id', 'super_admin', divIds['IT']).lastInsertRowid
  );
  const directorId = Number(
    insEmp.run('Direktur Utama', 'director@company.co.id', 'director', divIds['Internal Audit']).lastInsertRowid
  );
  const auditorId = Number(
    insEmp.run('Lead IT Auditor', 'auditor@company.co.id', 'auditor', divIds['Internal Audit']).lastInsertRowid
  );

  // Quiz attempts: every regular employee takes most topics; scores reflect
  // a base level + personal skill + division weakness + noise.
  const insAttempt = db.prepare(
    'INSERT INTO quiz_attempts (employee_id, topic_id, score, taken_at) VALUES (?, ?, ?, ?)'
  );
  const today = new Date('2026-06-01T00:00:00Z').getTime();
  for (const emp of employees) {
    const skill = randInt(-12, 12); // personal aptitude
    const weak = DIVISION_WEAKNESS[emp.division] || [];
    for (const t of TOPICS) {
      if (rng() < 0.12) continue; // a few topics not yet taken
      let base = 78 + skill;
      if (weak.includes(t.name)) base -= 26;          // division blind spot
      else if (rng() < 0.2) base += 8;                 // occasional strength
      const score = clamp(Math.round(base + randInt(-9, 9)), 8, 100);
      // 1..2 attempts spread across the last ~6 months
      const attempts = rng() < 0.35 ? 2 : 1;
      for (let a = 0; a < attempts; a++) {
        const daysAgo = randInt(5, 180);
        const when = new Date(today - daysAgo * 86400000).toISOString().slice(0, 10);
        const s = a === 0 ? score : clamp(score + randInt(-5, 10), 8, 100);
        insAttempt.run(emp.id, topicIds[t.name], s, when);
      }
    }
  }

  return { adminId, directorId, auditorId };
}

migrate();
seed();

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------
function listDivisions() {
  return db.prepare('SELECT * FROM divisions ORDER BY name').all();
}
function listTopics() {
  return db.prepare('SELECT * FROM topics ORDER BY name').all();
}
function listEmployees() {
  return db.prepare(`
    SELECT e.id, e.name, e.email, e.role, d.name AS division
    FROM employees e JOIN divisions d ON d.id = e.division_id
    WHERE e.role = 'employee'
    ORDER BY d.name, e.name
  `).all();
}

function overviewStats() {
  const totals = {
    employees: db.prepare("SELECT COUNT(*) c FROM employees WHERE role='employee'").get().c,
    divisions: db.prepare('SELECT COUNT(*) c FROM divisions').get().c,
    topics: db.prepare('SELECT COUNT(*) c FROM topics').get().c,
    attempts: db.prepare('SELECT COUNT(*) c FROM quiz_attempts').get().c,
    avgScore: Math.round(db.prepare('SELECT AVG(score) a FROM quiz_attempts').get().a || 0),
  };
  const byDivision = db.prepare(`
    SELECT d.name AS division,
           ROUND(AVG(qa.score)) AS avg_score,
           SUM(CASE WHEN qa.score < ${GAP_THRESHOLD} THEN 1 ELSE 0 END) AS gap_attempts,
           COUNT(*) AS attempts
    FROM quiz_attempts qa
    JOIN employees e ON e.id = qa.employee_id
    JOIN divisions d ON d.id = e.division_id
    GROUP BY d.id ORDER BY avg_score ASC
  `).all();
  const byTopic = db.prepare(`
    SELECT t.name AS topic,
           ROUND(AVG(qa.score)) AS avg_score,
           COUNT(*) AS attempts
    FROM quiz_attempts qa
    JOIN topics t ON t.id = qa.topic_id
    GROUP BY t.id ORDER BY avg_score ASC
  `).all();
  return { totals, byDivision, byTopic, gapThreshold: GAP_THRESHOLD };
}

/** Per-topic average for one employee, flagged as gap when below threshold. */
function employeeGaps(employeeId) {
  const emp = db.prepare(`
    SELECT e.id, e.name, e.email, d.name AS division
    FROM employees e JOIN divisions d ON d.id = e.division_id
    WHERE e.id = ?
  `).get(employeeId);
  if (!emp) return null;
  // avg_score = nilai TERBAIK (MAX) per topik, konsisten dengan skor peserta.
  const topics = db.prepare(`
    SELECT t.name AS topic, t.area,
           MAX(qa.score) AS avg_score,
           COUNT(*) AS attempts,
           MAX(qa.taken_at) AS last_taken
    FROM quiz_attempts qa
    JOIN topics t ON t.id = qa.topic_id
    WHERE qa.employee_id = ?
    GROUP BY t.id ORDER BY avg_score ASC
  `).all(employeeId);
  const gaps = topics.filter((t) => t.avg_score < GAP_THRESHOLD);
  const overall = topics.length
    ? Math.round(topics.reduce((s, t) => s + t.avg_score, 0) / topics.length)
    : 0;
  return { employee: emp, overall, topics, gaps, gapThreshold: GAP_THRESHOLD };
}

/** Per-topic score for a whole division = rata-rata dari nilai TERBAIK tiap
 *  karyawan pada topik tersebut (bukan rata-rata semua attempt). */
function divisionGaps(divisionId) {
  const div = db.prepare('SELECT * FROM divisions WHERE id = ?').get(divisionId);
  if (!div) return null;
  const topics = db.prepare(`
    SELECT t.name AS topic, t.area,
           ROUND(AVG(eb.best)) AS avg_score,
           COUNT(*) AS employees,
           SUM(eb.attempts) AS attempts
    FROM (
      SELECT qa.topic_id, qa.employee_id,
             MAX(qa.score) AS best, COUNT(*) AS attempts
      FROM quiz_attempts qa
      JOIN employees e ON e.id = qa.employee_id
      WHERE e.division_id = ? AND e.role = 'employee'
      GROUP BY qa.employee_id, qa.topic_id
    ) eb
    JOIN topics t ON t.id = eb.topic_id
    GROUP BY t.id ORDER BY avg_score ASC
  `).all(divisionId);
  const gaps = topics.filter((t) => t.avg_score < GAP_THRESHOLD);
  const overall = topics.length
    ? Math.round(topics.reduce((s, t) => s + t.avg_score, 0) / topics.length)
    : 0;
  return { division: div, overall, topics, gaps, gapThreshold: GAP_THRESHOLD };
}

/** Monthly average score over time, optionally filtered by division/topic. */
function scoreTrend({ divisionId, topicId } = {}) {
  const where = [];
  const params = [];
  if (divisionId) { where.push('e.division_id = ?'); params.push(divisionId); }
  if (topicId) { where.push('qa.topic_id = ?'); params.push(topicId); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`
    SELECT substr(qa.taken_at, 1, 7) AS month,
           ROUND(AVG(qa.score)) AS avg_score,
           COUNT(*) AS attempts
    FROM quiz_attempts qa
    JOIN employees e ON e.id = qa.employee_id
    ${clause}
    GROUP BY month ORDER BY month
  `).all(...params);
}

// Recommendations -----------------------------------------------------------
function listRecommendations(status) {
  if (status) {
    return db.prepare('SELECT * FROM recommendations WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return db.prepare('SELECT * FROM recommendations ORDER BY created_at DESC').all();
}
function getRecommendation(id) {
  return db.prepare('SELECT * FROM recommendations WHERE id = ?').get(id);
}
function createRecommendation(r) {
  const stmt = db.prepare(`
    INSERT INTO recommendations
      (scope_type, scope_ref, scope_label, title, gap_summary, recommendation,
       recommended_topics, model, created_by, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const id = Number(stmt.run(
    r.scope_type, r.scope_ref, r.scope_label, r.title, r.gap_summary || '',
    r.recommendation || '', JSON.stringify(r.recommended_topics || []),
    r.model || '', r.created_by || 'Super Admin', new Date().toISOString()
  ).lastInsertRowid);
  return getRecommendation(id);
}
function acknowledgeRecommendation(id, ackBy, ackNote) {
  db.prepare(`
    UPDATE recommendations
    SET status='acknowledged', ack_by=?, ack_note=?, ack_at=?
    WHERE id=? AND status='pending'
  `).run(ackBy || 'Direktur', ackNote || '', new Date().toISOString(), id);
  return getRecommendation(id);
}

// Participant / quiz ---------------------------------------------------------
function employeeById(id) {
  return db.prepare(`
    SELECT e.id, e.name, e.email, e.role, d.name AS division
    FROM employees e JOIN divisions d ON d.id = e.division_id WHERE e.id = ?
  `).get(id);
}
function topicById(id) {
  return db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
}

/** Fixed quiz curriculum: every participant — new or returning — goes through
 *  ALL of these topics, in this exact order, with QUESTIONS_PER_TOPIC each. */
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

// CASE expression that maps each topic name to its position in QUIZ_ORDER,
// so the list comes back in the prescribed sequence (kept DRY from QUIZ_ORDER).
const QUIZ_ORDER_CASE =
  'CASE t.name\n' +
  QUIZ_ORDER.map((n, i) => `         WHEN '${n.replace(/'/g, "''")}' THEN ${i + 1}`).join('\n') +
  '\n         ELSE 99 END';

// All topics (the full curriculum) with this participant's status: how many
// attempts and their BEST score (NULL when never taken), in fixed order.
// Skor topik = nilai TERBAIK (MAX), bukan rata-rata, agar mengulang kuis hanya
// menaikkan nilai ketika hasilnya melampaui skor lama.
const CURRICULUM_SQL =
`SELECT t.id AS topic_id, t.name AS topic, t.area,
       COUNT(qa.id) AS attempts,
       MAX(qa.score) AS best_score
  FROM topics t
  LEFT JOIN quiz_attempts qa
         ON qa.topic_id = t.id
        AND qa.employee_id = ?              -- peserta yang sedang login
 GROUP BY t.id
 ORDER BY ${QUIZ_ORDER_CASE}`;

function participantCurriculum(employeeId) {
  const emp = employeeById(employeeId);
  if (!emp) return null;
  const topics = db.prepare(CURRICULUM_SQL).all(employeeId).map((t) => ({
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
    sql: CURRICULUM_SQL.replace(/\?/g, String(employeeId)),
  };
}

/** Best (highest) score this employee has on a topic, plus attempt count.
 *  best = null when the topic has never been attempted. */
function bestScoreForEmployee(employeeId, topicId) {
  const r = db.prepare(
    'SELECT MAX(score) m, COUNT(*) n FROM quiz_attempts WHERE employee_id = ? AND topic_id = ?'
  ).get(employeeId, topicId);
  return { best: r.m == null ? null : r.m, attempts: r.n || 0 };
}
function recordAttempt(employeeId, topicId, score, takenAt) {
  db.prepare('INSERT INTO quiz_attempts (employee_id, topic_id, score, taken_at) VALUES (?, ?, ?, ?)')
    .run(employeeId, topicId, score, takenAt);
}

function createQuizSession(employeeId, topicId, payload, model) {
  const id = Number(db.prepare(`
    INSERT INTO quiz_sessions (employee_id, topic_id, payload, num_questions, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(employeeId, topicId, JSON.stringify(payload), payload.length, model || '', new Date().toISOString()).lastInsertRowid);
  return id;
}
function getQuizSession(id) {
  return db.prepare('SELECT * FROM quiz_sessions WHERE id = ?').get(id);
}
function closeQuizSession(id, score) {
  db.prepare("UPDATE quiz_sessions SET status='submitted', score=?, submitted_at=? WHERE id=? AND status='open'")
    .run(score, new Date().toISOString(), id);
}

// App settings (key/value) — mis. toggle ReAct & RAG untuk generate kuis.
function getSetting(key, fallback = null) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
  return getSetting(key);
}
function getBool(key, fallback = true) {
  const v = getSetting(key, fallback ? '1' : '0');
  return v === '1' || v === 'true';
}

// Raw read-only query for the SQL Agent.
function runSelect(sql) {
  return db.prepare(sql).all();
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
v_employee_score(employee_id, employee, division, avg_score, attempts, gap_topics)                -- rata-rata skor + jumlah topik ber-gap per karyawan`;
}

module.exports = {
  db, GAP_THRESHOLD, reseed,
  listDivisions, listTopics, listEmployees,
  overviewStats, employeeGaps, divisionGaps, scoreTrend,
  listRecommendations, getRecommendation, createRecommendation, acknowledgeRecommendation,
  employeeById, topicById, participantCurriculum, bestScoreForEmployee,
  recordAttempt, createQuizSession, getQuizSession, closeQuizSession,
  runSelect, schemaDescription,
  getSetting, setSetting, getBool,
};
