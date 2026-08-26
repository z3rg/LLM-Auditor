'use strict';
/**
 * Lapisan data LLM Auditor — di atas EdgeOne Pages Blob.
 *
 * Menggantikan Postgres (Neon) + pgvector. Kontrak fungsi di modul ini
 * SENGAJA dipertahankan sama persis seperti versi Postgres, sehingga
 * lib/auth.js tidak berubah sama sekali dan lib/api.js hanya kehilangan rute
 * fitur yang memang dibuang (SQL Agent & RAG).
 *
 * Yang berubah secara mendasar: tidak ada mesin kueri. Semua agregasi —
 * analitik gap, tren bulanan, overview — dihitung di JavaScript dari objek
 * yang dibaca dari Blob. Semantiknya dijaga identik dengan view SQL lama:
 *
 *   · Skor seorang karyawan pada satu topik = nilai TERBAIK (MAX), bukan
 *     rata-rata. Mengulang kuis hanya menaikkan nilai.
 *   · Gap = skor < GAP_THRESHOLD.
 *   · Rata-rata divisi per topik = rata-rata dari nilai TERBAIK tiap karyawan
 *     (bukan rata-rata seluruh attempt).
 *   · overviewStats SENGAJA berbeda: di sana rata-rata dihitung dari SELURUH
 *     attempt, persis seperti view lama. Jangan "diseragamkan".
 *
 * Tata kunci (satu entitas = satu kunci; lihat lib/blob.js):
 *   divisions.json                       [{id, name}]
 *   topics.json                          [{id, name, area}]
 *   users/<id>.json                      akun + password_hash
 *   users-by-email/<hash>.json           {id}   indeks unik, ditulis onlyIfNew
 *   attempts/<employeeId>.json           [{id, topicId, score, takenAt}]
 *   sessions/<tokenHash>.json            {employeeId, expiresAt, indexKey, …}
 *   sessions-by-user/<empId>/<exp>-<h>   penanda kosong; kedaluwarsa ada di
 *                                        NAMA kunci agar bisa dihitung tanpa
 *                                        membaca isinya
 *   login-attempts/<hash>.json           {email, count, first_at}
 *   recommendations/<id>.json
 *   quiz-sessions/<id>.json
 *   settings/<key>.json                  {value}
 *   meta/seed.json                       penanda sudah di-seed
 */
const blob = require('./blob');

const GAP_THRESHOLD = 70; // rata-rata di bawah ini = gap pengetahuan

const K = {
  divisions: 'divisions.json',
  topics: 'topics.json',
  seed: 'meta/seed.json',
  user: (id) => `users/${id}.json`,
  userByEmail: (email) => `users-by-email/${blob.keyHash(email)}.json`,
  attempts: (empId) => `attempts/${empId}.json`,
  session: (h) => `sessions/${h}.json`,
  sessionIndex: (empId, expiresAt, h) =>
    `sessions-by-user/${empId}/${Date.parse(expiresAt) || 0}-${h}.json`,
  loginAttempt: (email) => `login-attempts/${blob.keyHash(email)}.json`,
  recommendation: (id) => `recommendations/${id}.json`,
  quizSession: (id) => `quiz-sessions/${id}.json`,
  setting: (key) => `settings/${String(key).replace(/[^\w.-]/g, '_')}.json`,
};

const P = {
  users: 'users/',
  attempts: 'attempts/',
  sessions: 'sessions/',
  sessionsByUser: 'sessions-by-user/',
  recommendations: 'recommendations/',
};

/**
 * Id numerik baru.
 *
 * Postgres dulu memakai sequence. Blob tidak punya penghitung, jadi id diambil
 * dari jam. Tetap numerik (rute API mencocokkan \d+), dan tabrakan hanya
 * mungkin dalam milidetik yang sama — penulisnya memakai createJSON
 * (onlyIfNew) lalu menaikkan id, sehingga tabrakan pun tidak pernah menimpa.
 */
function newId() { return Date.now(); }

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

// ---------------------------------------------------------------------------
// Pemuat dasar (dengan cache pendek dalam proses)
// ---------------------------------------------------------------------------
async function listDivisions() {
  return blob.cached('divisions', async () => (await blob.getJSON(K.divisions, [])), 60_000);
}
async function listTopics() {
  return blob.cached('topics', async () => (await blob.getJSON(K.topics, [])), 60_000);
}

/** Seluruh akun (termasuk staf & password_hash). Dipakai internal. */
async function allUsers() {
  return blob.cached('users', async () => {
    const rows = await blob.getAllUnder(P.users);
    return rows.filter((u) => u && typeof u.id === 'number');
  });
}

/**
 * Seluruh attempt kuis, diratakan jadi satu larik.
 *
 * employeeId TIDAK disimpan di dalam tiap baris — pemiliknya sudah tercermin
 * dari nama kunci (attempts/<employeeId>.json), jadi nilainya dipasang di sini
 * saat memuat. Semua agregasi di bawah bergantung pada field ini.
 */
async function allAttempts() {
  return blob.cached('attempts', async () => {
    const keys = await blob.listKeys(P.attempts);
    const lists = await blob.getManyJSON(keys);
    const out = [];
    keys.forEach((key, i) => {
      const employeeId = Number(key.slice(P.attempts.length).replace(/\.json$/, ''));
      const list = lists[i];
      if (!Number.isFinite(employeeId) || !Array.isArray(list)) return;
      for (const row of list) out.push({ ...row, employeeId });
    });
    return out;
  });
}

async function divisionName(id) {
  const d = (await listDivisions()).find((x) => x.id === Number(id));
  return d ? d.name : null;
}

/** Bentuk akun yang dipakai API — nama divisi ikut, password_hash tidak. */
async function publicAccount(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return { ...rest, division: await divisionName(u.divisionId) };
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
/** Hapus seluruh data aplikasi, lalu isi ulang. */
async function reseed() {
  const prefixes = [P.users, 'users-by-email/', P.attempts, P.sessions, P.sessionsByUser,
                    'login-attempts/', P.recommendations, 'quiz-sessions/', 'settings/'];
  for (const prefix of prefixes) {
    const keys = await blob.listKeys(prefix);
    for (const key of keys) await blob.del(key);
  }
  await blob.del(K.divisions);
  await blob.del(K.topics);
  await blob.del(K.seed);
  blob.invalidate();
  return seed();
}

/** Isi data awal bila store masih kosong. Idempoten. */
async function seed() {
  if (await blob.getJSON(K.seed, null)) return null; // sudah terisi

  const rng = mulberry32(20240611);
  const randInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const divisions = DIVISIONS.map((name, i) => ({ id: i + 1, name }));
  const topics = TOPICS.map((t, i) => ({ id: i + 1, name: t.name, area: t.area }));
  await blob.putJSON(K.divisions, divisions);
  await blob.putJSON(K.topics, topics);

  const divIds = Object.fromEntries(divisions.map((d) => [d.name, d.id]));
  const topicIds = Object.fromEntries(topics.map((t) => [t.name, t.id]));

  // Peserta. Id 1..N dipakai supaya data demo punya id yang rapi dan stabil.
  const employees = NAMES.map((name, i) => {
    const division = DIVISIONS[i % DIVISIONS.length];
    return {
      id: i + 1,
      name,
      email: name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') + '@company.co.id',
      role: 'employee',
      divisionId: divIds[division],
      division,
      password_hash: null,
      status: 'active',
      created_at: null,
    };
  });

  // Akun staf untuk login & alur persetujuan. Kata sandinya disetel pertama
  // kali oleh auth.bootstrap(), bukan di sini.
  const staff = [
    { name: 'Super Admin', email: 'admin@company.co.id', role: 'super_admin', divisionId: divIds['IT'] },
    { name: 'Direktur Utama', email: 'director@company.co.id', role: 'director', divisionId: divIds['Internal Audit'] },
    { name: 'Lead IT Auditor', email: 'auditor@company.co.id', role: 'auditor', divisionId: divIds['Internal Audit'] },
  ].map((s, i) => ({
    ...s, id: NAMES.length + i + 1, password_hash: null, status: 'active', created_at: null,
  }));

  for (const u of [...employees, ...staff]) {
    const { division, ...record } = u;
    await blob.putJSON(K.user(record.id), record);
    await blob.putJSON(K.userByEmail(record.email), { id: record.id });
  }

  // Attempt kuis: skor = level dasar + bakat personal - kelemahan divisi + derau.
  const today = new Date('2026-06-01T00:00:00Z').getTime();
  for (const emp of employees) {
    const skill = randInt(-12, 12);
    const weak = DIVISION_WEAKNESS[emp.division] || [];
    const rows = [];
    for (const t of TOPICS) {
      if (rng() < 0.12) continue; // beberapa topik belum diambil
      let base = 78 + skill;
      if (weak.includes(t.name)) base -= 26;
      else if (rng() < 0.2) base += 8;
      const score = clamp(Math.round(base + randInt(-9, 9)), 8, 100);
      const attempts = rng() < 0.35 ? 2 : 1;
      for (let a = 0; a < attempts; a++) {
        const daysAgo = randInt(5, 180);
        rows.push({
          id: `${emp.id}-${topicIds[t.name]}-${a}`,
          topicId: topicIds[t.name],
          score: a === 0 ? score : clamp(score + randInt(-5, 10), 8, 100),
          takenAt: new Date(today - daysAgo * 86400000).toISOString().slice(0, 10),
        });
      }
    }
    if (rows.length) await blob.putJSON(K.attempts(emp.id), rows);
  }

  await blob.putJSON(K.seed, { seededAt: new Date().toISOString(), version: 3 });
  blob.invalidate();

  const byRole = Object.fromEntries(staff.map((s) => [s.role, s.id]));
  return { adminId: byRole.super_admin, directorId: byRole.director, auditorId: byRole.auditor };
}

// ---------------------------------------------------------------------------
// Daftar & analitik
// ---------------------------------------------------------------------------
async function listEmployees() {
  const [users, divisions] = await Promise.all([allUsers(), listDivisions()]);
  const divName = Object.fromEntries(divisions.map((d) => [d.id, d.name]));
  return users
    .filter((u) => u.role === 'employee')
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, division: divName[u.divisionId] || null }))
    .sort((a, b) => (a.division || '').localeCompare(b.division || '') || a.name.localeCompare(b.name));
}

const round1 = (n) => Math.round(n * 10) / 10;
const avg = (nums) => (nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0);

/**
 * Nilai TERBAIK tiap (karyawan, topik) — padanan view v_employee_topic.
 * Hanya memperhitungkan akun ber-role 'employee', seperti view lama.
 */
async function employeeTopicBests() {
  const [users, attempts] = await Promise.all([allUsers(), allAttempts()]);
  const employees = new Map(users.filter((u) => u.role === 'employee').map((u) => [u.id, u]));
  const byPair = new Map();
  for (const a of attempts) {
    if (!employees.has(a.employeeId)) continue;
    const key = `${a.employeeId}|${a.topicId}`;
    const cur = byPair.get(key);
    if (!cur) byPair.set(key, { employeeId: a.employeeId, topicId: a.topicId, best: a.score, attempts: 1 });
    else { cur.best = Math.max(cur.best, a.score); cur.attempts += 1; }
  }
  return { employees, bests: [...byPair.values()] };
}

async function overviewStats() {
  const [users, attempts, divisions, topics] = await Promise.all([
    allUsers(), allAttempts(), listDivisions(), listTopics(),
  ]);
  const employees = new Map(users.filter((u) => u.role === 'employee').map((u) => [u.id, u]));
  const divName = Object.fromEntries(divisions.map((d) => [d.id, d.name]));
  const topicName = Object.fromEntries(topics.map((t) => [t.id, t.name]));

  const totals = {
    employees: employees.size,
    divisions: divisions.length,
    topics: topics.length,
    attempts: attempts.length,
    avgScore: attempts.length ? Math.round(avg(attempts.map((a) => a.score))) : 0,
  };

  // Rata-rata di sini memakai SELURUH attempt (bukan nilai terbaik), persis
  // seperti view lama — jangan diseragamkan dengan analitik gap.
  const divBuckets = new Map();
  const topicBuckets = new Map();
  for (const a of attempts) {
    const emp = employees.get(a.employeeId);
    if (!emp) continue;
    const dn = divName[emp.divisionId] || '(tanpa divisi)';
    if (!divBuckets.has(dn)) divBuckets.set(dn, { division: dn, scores: [], gap_attempts: 0 });
    const db = divBuckets.get(dn);
    db.scores.push(a.score);
    if (a.score < GAP_THRESHOLD) db.gap_attempts += 1;

    const tn = topicName[a.topicId] || '?';
    if (!topicBuckets.has(tn)) topicBuckets.set(tn, { topic: tn, scores: [] });
    topicBuckets.get(tn).scores.push(a.score);
  }

  const byDivision = [...divBuckets.values()]
    .map((d) => ({ division: d.division, avg_score: Math.round(avg(d.scores)), gap_attempts: d.gap_attempts, attempts: d.scores.length }))
    .sort((a, b) => a.avg_score - b.avg_score);
  const byTopic = [...topicBuckets.values()]
    .map((t) => ({ topic: t.topic, avg_score: Math.round(avg(t.scores)), attempts: t.scores.length }))
    .sort((a, b) => a.avg_score - b.avg_score);

  return { totals, byDivision, byTopic, gapThreshold: GAP_THRESHOLD };
}

/** Skor per topik untuk satu karyawan; ditandai gap bila di bawah ambang. */
async function employeeGaps(employeeId) {
  const emp = await employeeById(employeeId);
  if (!emp) return null;
  const [attempts, topics] = await Promise.all([attemptsFor(employeeId), listTopics()]);
  const topicMeta = Object.fromEntries(topics.map((t) => [t.id, t]));

  const byTopic = new Map();
  for (const a of attempts) {
    const cur = byTopic.get(a.topicId);
    if (!cur) byTopic.set(a.topicId, { topicId: a.topicId, best: a.score, attempts: 1, last: a.takenAt });
    else {
      cur.best = Math.max(cur.best, a.score);
      cur.attempts += 1;
      if (String(a.takenAt) > String(cur.last)) cur.last = a.takenAt;
    }
  }
  const list = [...byTopic.values()]
    .map((r) => ({
      topic: topicMeta[r.topicId] ? topicMeta[r.topicId].name : '?',
      area: topicMeta[r.topicId] ? topicMeta[r.topicId].area : null,
      avg_score: r.best,
      attempts: r.attempts,
      last_taken: r.last,
    }))
    .sort((a, b) => a.avg_score - b.avg_score);

  const gaps = list.filter((t) => t.avg_score < GAP_THRESHOLD);
  const overall = list.length ? Math.round(avg(list.map((t) => t.avg_score))) : 0;
  return { employee: emp, overall, topics: list, gaps, gapThreshold: GAP_THRESHOLD };
}

/** Skor per topik satu divisi = rata-rata nilai TERBAIK tiap karyawan. */
async function divisionGaps(divisionId) {
  const div = (await listDivisions()).find((d) => d.id === Number(divisionId));
  if (!div) return null;
  const [{ employees, bests }, topics] = await Promise.all([employeeTopicBests(), listTopics()]);
  const topicMeta = Object.fromEntries(topics.map((t) => [t.id, t]));

  const byTopic = new Map();
  for (const b of bests) {
    const emp = employees.get(b.employeeId);
    if (!emp || emp.divisionId !== div.id) continue;
    if (!byTopic.has(b.topicId)) byTopic.set(b.topicId, { topicId: b.topicId, bests: [], attempts: 0 });
    const t = byTopic.get(b.topicId);
    t.bests.push(b.best);
    t.attempts += b.attempts;
  }
  const list = [...byTopic.values()]
    .map((r) => ({
      topic: topicMeta[r.topicId] ? topicMeta[r.topicId].name : '?',
      area: topicMeta[r.topicId] ? topicMeta[r.topicId].area : null,
      avg_score: Math.round(avg(r.bests)),
      employees: r.bests.length,
      attempts: r.attempts,
    }))
    .sort((a, b) => a.avg_score - b.avg_score);

  const gaps = list.filter((t) => t.avg_score < GAP_THRESHOLD);
  const overall = list.length ? Math.round(avg(list.map((t) => t.avg_score))) : 0;
  return { division: div, overall, topics: list, gaps, gapThreshold: GAP_THRESHOLD };
}

/** Rata-rata skor per bulan, opsional difilter divisi/topik. */
async function scoreTrend({ divisionId, topicId } = {}) {
  const [users, attempts] = await Promise.all([allUsers(), allAttempts()]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const buckets = new Map();
  for (const a of attempts) {
    const emp = byId.get(a.employeeId);
    if (!emp) continue;
    if (divisionId && emp.divisionId !== Number(divisionId)) continue;
    if (topicId && a.topicId !== Number(topicId)) continue;
    const month = String(a.takenAt).slice(0, 7);
    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month).push(a.score);
  }
  return [...buckets.entries()]
    .map(([month, scores]) => ({ month, avg_score: Math.round(avg(scores)), attempts: scores.length }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// ---------------------------------------------------------------------------
// Rekomendasi
// ---------------------------------------------------------------------------
async function listRecommendations(status) {
  const rows = await blob.getAllUnder(P.recommendations);
  return rows
    .filter((r) => (status ? r.status === status : true))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
async function getRecommendation(id) {
  return blob.getJSON(K.recommendation(Number(id)), null);
}
async function createRecommendation(r) {
  const row = {
    id: newId(),
    scope_type: r.scope_type,
    scope_ref: r.scope_ref,
    scope_label: r.scope_label,
    title: r.title,
    gap_summary: r.gap_summary || '',
    recommendation: r.recommendation || '',
    recommended_topics: JSON.stringify(r.recommended_topics || []),
    model: r.model || '',
    created_by: r.created_by || 'Super Admin',
    status: 'pending',
    ack_by: null,
    ack_note: null,
    ack_at: null,
    created_at: new Date().toISOString(),
  };
  await blob.putJSON(K.recommendation(row.id), row);
  return row;
}
async function acknowledgeRecommendation(id, ackBy, ackNote) {
  const row = await getRecommendation(id);
  if (!row) return null;
  if (row.status !== 'pending') return row; // sudah di-acknowledge, jangan timpa
  const updated = {
    ...row,
    status: 'acknowledged',
    ack_by: ackBy || 'Direktur',
    ack_note: ackNote || '',
    ack_at: new Date().toISOString(),
  };
  await blob.putJSON(K.recommendation(updated.id), updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Peserta & kuis
// ---------------------------------------------------------------------------
async function employeeById(id) {
  const u = await blob.getJSON(K.user(Number(id)), null);
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    division: await divisionName(u.divisionId),
  };
}
async function topicById(id) {
  return (await listTopics()).find((t) => t.id === Number(id)) || null;
}

async function attemptsFor(employeeId) {
  const rows = await blob.getJSON(K.attempts(Number(employeeId)), []);
  return Array.isArray(rows) ? rows.map((r) => ({ ...r, employeeId: Number(employeeId) })) : [];
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

async function participantCurriculum(employeeId) {
  const emp = await employeeById(employeeId);
  if (!emp) return null;
  const [topics, attempts] = await Promise.all([listTopics(), attemptsFor(employeeId)]);

  const stat = new Map();
  for (const a of attempts) {
    const cur = stat.get(a.topicId);
    if (!cur) stat.set(a.topicId, { attempts: 1, best: a.score });
    else { cur.attempts += 1; cur.best = Math.max(cur.best, a.score); }
  }
  const order = Object.fromEntries(QUIZ_ORDER.map((n, i) => [n, i + 1]));
  const list = topics
    .map((t) => {
      const s = stat.get(t.id);
      return {
        topic_id: t.id,
        topic: t.name,
        area: t.area,
        attempts: s ? s.attempts : 0,
        done: !!s,
        best_score: s ? s.best : null,
      };
    })
    .sort((a, b) => (order[a.topic] || 99) - (order[b.topic] || 99));

  const doneCount = list.filter((t) => t.done).length;
  return {
    employee: emp,
    totalTopics: list.length,
    doneCount,
    undoneCount: list.length - doneCount,
    questionsPerTopic: QUESTIONS_PER_TOPIC,
    topics: list,
  };
}

/** Skor tertinggi karyawan pada satu topik + jumlah attempt. */
async function bestScoreForEmployee(employeeId, topicId) {
  const rows = (await attemptsFor(employeeId)).filter((a) => a.topicId === Number(topicId));
  if (!rows.length) return { best: null, attempts: 0 };
  return { best: Math.max(...rows.map((r) => r.score)), attempts: rows.length };
}

async function recordAttempt(employeeId, topicId, score, takenAt) {
  const key = K.attempts(Number(employeeId));
  // Baca-ubah-tulis, tetapi HANYA pada blob milik satu peserta: dua peserta
  // berbeda tidak pernah menulis kunci yang sama, dan satu orang tidak
  // menyerahkan dua kuis dalam waktu bersamaan.
  const rows = await blob.getJSON(key, []);
  rows.push({ id: newId(), topicId: Number(topicId), score: Number(score), takenAt });
  await blob.putJSON(key, rows);
  blob.invalidate('attempts');
}

async function createQuizSession(employeeId, topicId, payload, model) {
  const row = {
    id: newId(),
    employee_id: Number(employeeId),
    topic_id: Number(topicId),
    payload: JSON.stringify(payload),
    num_questions: payload.length,
    status: 'open',
    score: null,
    model: model || '',
    created_at: new Date().toISOString(),
    submitted_at: null,
  };
  await blob.putJSON(K.quizSession(row.id), row);
  return row.id;
}
async function getQuizSession(id) {
  return blob.getJSON(K.quizSession(Number(id)), null);
}
async function closeQuizSession(id, score) {
  const row = await getQuizSession(id);
  if (!row || row.status !== 'open') return;
  await blob.putJSON(K.quizSession(row.id), {
    ...row, status: 'submitted', score: Number(score), submitted_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Akun
// ---------------------------------------------------------------------------
async function findUserByEmail(email) {
  const pointer = await blob.getJSON(K.userByEmail(email), null);
  if (!pointer) return null;
  const u = await blob.getJSON(K.user(pointer.id), null);
  if (!u) return null;
  return { ...(await publicAccount(u)), password_hash: u.password_hash || null };
}
async function accountById(id) {
  return publicAccount(await blob.getJSON(K.user(Number(id)), null));
}

async function createUser({ name, email, passwordHash, divisionId, role = 'employee' }) {
  // Keunikan email dijaga oleh tulis bersyarat, bukan oleh cek-lalu-tulis:
  // hanya createJSON yang atomik di Blob.
  let id = newId();
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await blob.createJSON(K.user(id), { id, name, email, role, divisionId: Number(divisionId),
      password_hash: passwordHash || null, status: 'active', created_at: new Date().toISOString() })) break;
    id += 1; // id sudah dipakai (milidetik yang sama) — coba berikutnya
    if (attempt === 4) throw new Error('Gagal mengalokasikan id akun baru.');
  }
  if (!(await blob.createJSON(K.userByEmail(email), { id }))) {
    await blob.del(K.user(id)); // batalkan; email sudah dimiliki akun lain
    throw new Error('Email sudah terdaftar.');
  }
  blob.invalidate('users');
  return accountById(id);
}

async function updateUser(id, patch) {
  const u = await blob.getJSON(K.user(Number(id)), null);
  if (!u) return null;
  const updated = { ...u, ...patch };
  await blob.putJSON(K.user(updated.id), updated);
  blob.invalidate('users');
  return updated;
}

async function setPassword(id, passwordHash) {
  await updateUser(id, { password_hash: passwordHash });
}

/** Akun staf bawaan yang belum bisa login (kata sandi belum disetel). */
async function staffWithoutPassword() {
  return (await allUsers())
    .filter((u) => u.role !== 'employee' && !u.password_hash)
    .sort((a, b) => a.id - b.id)
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
}

/** Semua akun yang bisa masuk. */
async function listAccounts() {
  const [users, divisions] = await Promise.all([allUsers(), listDivisions()]);
  const divName = Object.fromEntries(divisions.map((d) => [d.id, d.name]));
  const now = Date.now();

  const rows = await Promise.all(users
    .filter((u) => !!u.password_hash)
    .map(async (u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, status: u.status,
      created_at: u.created_at, divisionId: u.divisionId, division: divName[u.divisionId] || null,
      registered: 1,
      active_sessions: await countActiveSessions(u.id, now),
    })));

  return rows.sort((a, b) =>
    (a.role !== 'super_admin') - (b.role !== 'super_admin') ||
    (!a.created_at) - (!b.created_at) ||
    String(b.created_at || '').localeCompare(String(a.created_at || '')) ||
    a.name.localeCompare(b.name));
}

async function setUserRole(id, role) {
  await updateUser(id, { role });
  return accountById(id);
}
async function setUserStatus(id, status) {
  await updateUser(id, { status });
  if (status !== 'active') await deleteSessionsForUser(id);
  return accountById(id);
}

// ---------------------------------------------------------------------------
// Sesi
// ---------------------------------------------------------------------------
/**
 * Jumlah sesi aktif tanpa membaca satu objek pun: waktu kedaluwarsa ditanam
 * di NAMA kunci indeks, jadi cukup menghitung dari daftar kunci.
 */
async function countActiveSessions(employeeId, now = Date.now()) {
  const keys = await blob.listKeys(`${P.sessionsByUser}${employeeId}/`);
  return keys.filter((k) => {
    const m = k.split('/').pop().match(/^(\d+)-/);
    return m && Number(m[1]) > now;
  }).length;
}

async function createSession({ tokenHash, employeeId, createdAt, expiresAt, userAgent }) {
  const indexKey = K.sessionIndex(employeeId, expiresAt, tokenHash);
  await blob.putJSON(K.session(tokenHash), {
    token_hash: tokenHash, employee_id: Number(employeeId), created_at: createdAt,
    expires_at: expiresAt, user_agent: userAgent || '', indexKey,
  });
  await blob.putJSON(indexKey, { t: tokenHash });
}

async function sessionUser(tokenHash, nowIso) {
  const s = await blob.getJSON(K.session(tokenHash), null);
  if (!s || String(s.expires_at) <= String(nowIso)) return null;
  return accountById(s.employee_id);
}

async function deleteSession(tokenHash) {
  const s = await blob.getJSON(K.session(tokenHash), null);
  await blob.del(K.session(tokenHash));
  if (s && s.indexKey) await blob.del(s.indexKey);
}

async function deleteSessionsForUser(employeeId) {
  // Nama kunci indeks memuat token hash-nya, jadi tidak perlu membaca isinya.
  const keys = await blob.listKeys(`${P.sessionsByUser}${Number(employeeId)}/`);
  for (const key of keys) {
    const m = key.split('/').pop().match(/^\d+-(.+)\.json$/);
    if (m) await blob.del(K.session(m[1]));
    await blob.del(key);
  }
}

async function purgeExpiredSessions(nowIso) {
  const now = Date.parse(nowIso) || Date.now();
  const keys = await blob.listKeys(P.sessionsByUser);
  for (const key of keys) {
    const m = key.split('/').pop().match(/^(\d+)-(.+)\.json$/);
    if (!m || Number(m[1]) > now) continue;
    await blob.del(K.session(m[2]));
    await blob.del(key);
  }
}

// ---------------------------------------------------------------------------
// Throttle login
// ---------------------------------------------------------------------------
async function getLoginAttempt(email) {
  return blob.getJSON(K.loginAttempt(email), null);
}
async function bumpLoginAttempt(email, nowIso, windowStartIso) {
  const rec = await getLoginAttempt(email);
  const stale = !rec || String(rec.first_at) <= String(windowStartIso);
  await blob.putJSON(K.loginAttempt(email), stale
    ? { email, count: 1, first_at: nowIso }
    : { email, count: rec.count + 1, first_at: rec.first_at });
}
async function clearLoginAttempts(email) {
  await blob.del(K.loginAttempt(email));
}

// ---------------------------------------------------------------------------
// Pengaturan aplikasi (key/value)
// ---------------------------------------------------------------------------
async function getSetting(key, fallback = null) {
  const r = await blob.getJSON(K.setting(key), null);
  return r && r.value !== undefined ? r.value : fallback;
}
async function setSetting(key, value) {
  await blob.putJSON(K.setting(key), { key, value: String(value) });
  return String(value);
}
async function getBool(key, fallback = true) {
  const v = await getSetting(key, fallback ? '1' : '0');
  return v === '1' || v === 'true';
}

module.exports = {
  GAP_THRESHOLD, seed, reseed,
  listDivisions, listTopics, listEmployees,
  overviewStats, employeeGaps, divisionGaps, scoreTrend,
  listRecommendations, getRecommendation, createRecommendation, acknowledgeRecommendation,
  employeeById, topicById, participantCurriculum, bestScoreForEmployee,
  recordAttempt, createQuizSession, getQuizSession, closeQuizSession,
  getSetting, setSetting, getBool,
  findUserByEmail, accountById, createUser, setPassword, staffWithoutPassword,
  listAccounts, setUserRole, setUserStatus,
  createSession, sessionUser, deleteSession, deleteSessionsForUser, purgeExpiredSessions,
  getLoginAttempt, bumpLoginAttempt, clearLoginAttempts,
};
