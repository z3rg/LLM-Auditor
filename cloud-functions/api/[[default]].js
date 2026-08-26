import{fileURLToPath as __f}from"node:url";import{dirname as __d}from"node:path";import{createRequire as __cr}from"node:module";const __filename=__f(import.meta.url);const __dirname=__d(__filename);if(!globalThis.require)globalThis.require=__cr(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// lib/env.js
var require_env = __commonJS({
  "lib/env.js"(exports, module) {
    "use strict";
    var fs = __require("node:fs");
    var path = __require("node:path");
    var loaded = false;
    function loadEnv() {
      if (loaded) return;
      loaded = true;
      try {
        const file = path.join(__dirname, "..", ".env");
        if (!fs.existsSync(file)) return;
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
          if (!m) continue;
          const key = m[1];
          const val = m[2].replace(/^["']|["']$/g, "");
          if (!(key in process.env)) process.env[key] = val;
        }
      } catch (_) {
      }
    }
    module.exports = { loadEnv };
  }
});

// lib/pg.js
var require_pg = __commonJS({
  "lib/pg.js"(exports, module) {
    "use strict";
    var neonFactory = null;
    function setNeonFactory(fn) {
      neonFactory = fn;
    }
    function resolveNeon() {
      if (neonFactory) return neonFactory;
      return __require("@neondatabase/serverless").neon;
    }
    var client = null;
    function sql() {
      if (client) return client;
      const url = process.env.DATABASE_URL;
      if (!url) {
        throw new Error(
          "DATABASE_URL belum disetel. Isi di .env (lokal) atau di variabel lingkungan project EdgeOne Makers."
        );
      }
      client = resolveNeon()(url);
      return client;
    }
    async function query(text, params = []) {
      const c = sql();
      const run = typeof c.query === "function" ? c.query.bind(c) : c;
      return await run(text, params);
    }
    async function many(text, params = []) {
      return query(text, params);
    }
    async function one(text, params = []) {
      const rows = await query(text, params);
      return rows.length ? rows[0] : null;
    }
    async function exec(text, params = []) {
      await query(text, params);
    }
    async function scalar(text, params = []) {
      const row = await one(text, params);
      if (!row) return null;
      const keys = Object.keys(row);
      return keys.length ? row[keys[0]] : null;
    }
    function reset() {
      client = null;
    }
    module.exports = { query, many, one, exec, scalar, reset, setNeonFactory };
  }
});

// lib/db.js
var require_db = __commonJS({
  "lib/db.js"(exports, module) {
    "use strict";
    var fs = __require("node:fs");
    var path = __require("node:path");
    var pg = require_pg();
    var GAP_THRESHOLD = 70;
    function schemaPath() {
      return path.join(__dirname, "..", "db", "schema.sql");
    }
    function splitStatements(sqlText) {
      return sqlText.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
    }
    async function applySchema() {
      const raw = fs.readFileSync(schemaPath(), "utf8").replaceAll("{{GAP_THRESHOLD}}", String(GAP_THRESHOLD));
      for (const stmt of splitStatements(raw)) await pg.exec(stmt);
    }
    function mulberry32(seed2) {
      return function() {
        seed2 |= 0;
        seed2 = seed2 + 1831565813 | 0;
        let t = Math.imul(seed2 ^ seed2 >>> 15, 1 | seed2);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    var DIVISIONS = [
      "Finance",
      "IT",
      "Human Resources",
      "Operations",
      "Marketing",
      "Legal & Compliance",
      "Internal Audit",
      "Procurement"
    ];
    var TOPICS = [
      { name: "Access Control & IAM", area: "Security" },
      { name: "Network Security", area: "Security" },
      { name: "Data Privacy & Protection", area: "Privacy" },
      { name: "Incident Response", area: "Operations" },
      { name: "Change Management", area: "Governance" },
      { name: "Business Continuity & DRP", area: "Resilience" },
      { name: "ISO 27001 Compliance", area: "Compliance" },
      { name: "IT Risk Management", area: "Governance" },
      { name: "Application Controls", area: "Controls" },
      { name: "Audit Logging & Monitoring", area: "Detection" }
    ];
    var DIVISION_WEAKNESS = {
      "Finance": ["Network Security", "Incident Response"],
      "IT": ["Data Privacy & Protection", "ISO 27001 Compliance"],
      "Human Resources": ["Access Control & IAM", "Audit Logging & Monitoring"],
      "Operations": ["Change Management", "Business Continuity & DRP"],
      "Marketing": ["Data Privacy & Protection", "Access Control & IAM"],
      "Legal & Compliance": ["Application Controls", "Network Security"],
      "Internal Audit": ["Application Controls", "IT Risk Management"],
      "Procurement": ["ISO 27001 Compliance", "Incident Response"]
    };
    var NAMES = [
      "Andi Wijaya",
      "Budi Santoso",
      "Citra Lestari",
      "Dewi Anggraini",
      "Eko Prasetyo",
      "Fitri Handayani",
      "Gunawan Saputra",
      "Hesti Rahmawati",
      "Indra Permana",
      "Joko Susilo",
      "Kartika Sari",
      "Lukman Hakim",
      "Maya Puspita",
      "Nanda Pratama",
      "Oscar Tanuwijaya",
      "Putri Maharani",
      "Qori Ramadhan",
      "Rina Wulandari",
      "Surya Dharma",
      "Tia Novita",
      "Umar Faruq",
      "Vina Kusuma",
      "Wahyu Nugroho",
      "Xena Paramita",
      "Yusuf Maulana",
      "Zahra Aulia",
      "Agus Setiawan",
      "Bella Anggita",
      "Candra Kirana",
      "Dimas Aryo",
      "Elma Safira",
      "Farhan Aziz"
    ];
    async function reseed() {
      await pg.exec(`
    TRUNCATE sessions, login_attempts, quiz_sessions, quiz_attempts,
             recommendations, employees, topics, divisions
    RESTART IDENTITY CASCADE
  `);
      return seed();
    }
    async function seed() {
      const have = await pg.scalar("SELECT COUNT(*)::int AS c FROM divisions");
      if (have > 0) return null;
      const rng = mulberry32(20240611);
      const randInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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
      const empNames = [], empEmails = [], empDivs = [];
      NAMES.forEach((name, i) => {
        const division = DIVISIONS[i % DIVISIONS.length];
        empNames.push(name);
        empEmails.push(
          name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "") + "@company.co.id"
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
        id: r.id,
        name: r.name,
        division: DIVISIONS[i % DIVISIONS.length]
      }));
      const staff = await pg.many(
        `INSERT INTO employees (name, email, role, division_id)
     SELECT n, e, r, d FROM unnest($1::text[], $2::text[], $3::text[], $4::int[]) AS t(n, e, r, d)
     RETURNING id, role`,
        [
          ["Super Admin", "Direktur Utama", "Lead IT Auditor"],
          ["admin@company.co.id", "director@company.co.id", "auditor@company.co.id"],
          ["super_admin", "director", "auditor"],
          [divIds["IT"], divIds["Internal Audit"], divIds["Internal Audit"]]
        ]
      );
      const aEmp = [], aTopic = [], aScore = [], aWhen = [];
      const today = (/* @__PURE__ */ new Date("2026-06-01T00:00:00Z")).getTime();
      for (const emp of employees) {
        const skill = randInt(-12, 12);
        const weak = DIVISION_WEAKNESS[emp.division] || [];
        for (const t of TOPICS) {
          if (rng() < 0.12) continue;
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
            aWhen.push(new Date(today - daysAgo * 864e5).toISOString().slice(0, 10));
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
    async function listDivisions() {
      return pg.many("SELECT * FROM divisions ORDER BY name");
    }
    async function listTopics() {
      return pg.many("SELECT * FROM topics ORDER BY name");
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
    async function employeeGaps(employeeId) {
      const emp = await pg.one(`
    SELECT e.id, e.name, e.email, d.name AS division
    FROM employees e JOIN divisions d ON d.id = e.division_id
    WHERE e.id = $1
  `, [employeeId]);
      if (!emp) return null;
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
      const overall = topics.length ? Math.round(topics.reduce((s, t) => s + t.avg_score, 0) / topics.length) : 0;
      return { employee: emp, overall, topics, gaps, gapThreshold: GAP_THRESHOLD };
    }
    async function divisionGaps(divisionId) {
      const div = await pg.one("SELECT * FROM divisions WHERE id = $1", [divisionId]);
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
      const overall = topics.length ? Math.round(topics.reduce((s, t) => s + t.avg_score, 0) / topics.length) : 0;
      return { division: div, overall, topics, gaps, gapThreshold: GAP_THRESHOLD };
    }
    async function scoreTrend({ divisionId, topicId } = {}) {
      const where = [];
      const params = [];
      if (divisionId) {
        params.push(divisionId);
        where.push(`e.division_id = $${params.length}`);
      }
      if (topicId) {
        params.push(topicId);
        where.push(`qa.topic_id = $${params.length}`);
      }
      const clause = where.length ? "WHERE " + where.join(" AND ") : "";
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
    async function listRecommendations(status) {
      if (status) {
        return pg.many("SELECT * FROM recommendations WHERE status = $1 ORDER BY created_at DESC", [status]);
      }
      return pg.many("SELECT * FROM recommendations ORDER BY created_at DESC");
    }
    async function getRecommendation(id) {
      return pg.one("SELECT * FROM recommendations WHERE id = $1", [id]);
    }
    async function createRecommendation(r) {
      const row = await pg.one(`
    INSERT INTO recommendations
      (scope_type, scope_ref, scope_label, title, gap_summary, recommendation,
       recommended_topics, model, created_by, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
    RETURNING *
  `, [
        r.scope_type,
        r.scope_ref,
        r.scope_label,
        r.title,
        r.gap_summary || "",
        r.recommendation || "",
        JSON.stringify(r.recommended_topics || []),
        r.model || "",
        r.created_by || "Super Admin",
        (/* @__PURE__ */ new Date()).toISOString()
      ]);
      return row;
    }
    async function acknowledgeRecommendation(id, ackBy, ackNote) {
      await pg.exec(`
    UPDATE recommendations
    SET status='acknowledged', ack_by=$1, ack_note=$2, ack_at=$3
    WHERE id=$4 AND status='pending'
  `, [ackBy || "Direktur", ackNote || "", (/* @__PURE__ */ new Date()).toISOString(), id]);
      return getRecommendation(id);
    }
    async function employeeById(id) {
      return pg.one(`
    SELECT e.id, e.name, e.email, e.role, d.name AS division
    FROM employees e JOIN divisions d ON d.id = e.division_id WHERE e.id = $1
  `, [id]);
    }
    async function topicById(id) {
      return pg.one("SELECT * FROM topics WHERE id = $1", [id]);
    }
    var QUIZ_ORDER = [
      "Incident Response",
      "Data Privacy & Protection",
      "ISO 27001 Compliance",
      "Access Control & IAM",
      "Network Security",
      "Application Controls",
      "Business Continuity & DRP",
      "Audit Logging & Monitoring",
      "Change Management",
      "IT Risk Management"
    ];
    var QUESTIONS_PER_TOPIC = 10;
    var QUIZ_ORDER_CASE = "CASE t.name\n" + QUIZ_ORDER.map((n, i) => `         WHEN '${n.replace(/'/g, "''")}' THEN ${i + 1}`).join("\n") + "\n         ELSE 99 END";
    var CURRICULUM_SQL = `SELECT t.id AS topic_id, t.name AS topic, t.area,
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
        best_score: t.attempts > 0 ? t.best_score : null
      }));
      const doneCount = topics.filter((t) => t.done).length;
      return {
        employee: emp,
        totalTopics: topics.length,
        doneCount,
        undoneCount: topics.length - doneCount,
        questionsPerTopic: QUESTIONS_PER_TOPIC,
        topics,
        sql: CURRICULUM_SQL.replaceAll("$1", String(employeeId))
      };
    }
    async function bestScoreForEmployee(employeeId, topicId) {
      const r = await pg.one(
        "SELECT MAX(score) AS m, COUNT(*)::int AS n FROM quiz_attempts WHERE employee_id = $1 AND topic_id = $2",
        [employeeId, topicId]
      );
      return { best: r.m == null ? null : r.m, attempts: r.n || 0 };
    }
    async function recordAttempt(employeeId, topicId, score, takenAt) {
      await pg.exec(
        "INSERT INTO quiz_attempts (employee_id, topic_id, score, taken_at) VALUES ($1, $2, $3, $4)",
        [employeeId, topicId, score, takenAt]
      );
    }
    async function createQuizSession(employeeId, topicId, payload, model) {
      const row = await pg.one(`
    INSERT INTO quiz_sessions (employee_id, topic_id, payload, num_questions, model, created_at)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [employeeId, topicId, JSON.stringify(payload), payload.length, model || "", (/* @__PURE__ */ new Date()).toISOString()]);
      return row.id;
    }
    async function getQuizSession(id) {
      return pg.one("SELECT * FROM quiz_sessions WHERE id = $1", [id]);
    }
    async function closeQuizSession(id, score) {
      await pg.exec(
        "UPDATE quiz_sessions SET status='submitted', score=$1, submitted_at=$2 WHERE id=$3 AND status='open'",
        [score, (/* @__PURE__ */ new Date()).toISOString(), id]
      );
    }
    var ACCOUNT_FIELDS = `
  e.id, e.name, e.email, e.role, e.status, e.created_at,
  e.division_id AS "divisionId", d.name AS division`;
    async function findUserByEmail(email) {
      return pg.one(`
    SELECT ${ACCOUNT_FIELDS}, e.password_hash
    FROM employees e JOIN divisions d ON d.id = e.division_id
    WHERE lower(e.email) = lower($1)
  `, [String(email || "").trim()]);
    }
    async function accountById(id) {
      return pg.one(`
    SELECT ${ACCOUNT_FIELDS}
    FROM employees e JOIN divisions d ON d.id = e.division_id
    WHERE e.id = $1
  `, [id]);
    }
    async function createUser({ name, email, passwordHash, divisionId, role = "employee" }) {
      const row = await pg.one(`
    INSERT INTO employees (name, email, role, division_id, password_hash, status, created_at)
    VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING id
  `, [name, email, role, divisionId, passwordHash, (/* @__PURE__ */ new Date()).toISOString()]);
      return accountById(row.id);
    }
    async function setPassword(id, passwordHash) {
      await pg.exec("UPDATE employees SET password_hash = $1 WHERE id = $2", [passwordHash, id]);
    }
    async function staffWithoutPassword() {
      return pg.many(`
    SELECT id, name, email, role FROM employees
    WHERE role <> 'employee' AND (password_hash IS NULL OR password_hash = '')
    ORDER BY id
  `);
    }
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
  `, [(/* @__PURE__ */ new Date()).toISOString()]);
    }
    async function setUserRole(id, role) {
      await pg.exec("UPDATE employees SET role = $1 WHERE id = $2", [role, id]);
      return accountById(id);
    }
    async function setUserStatus(id, status) {
      await pg.exec("UPDATE employees SET status = $1 WHERE id = $2", [status, id]);
      if (status !== "active") await deleteSessionsForUser(id);
      return accountById(id);
    }
    async function createSession({ tokenHash, employeeId, createdAt, expiresAt, userAgent }) {
      await pg.exec(`
    INSERT INTO sessions (token_hash, employee_id, created_at, expires_at, user_agent)
    VALUES ($1, $2, $3, $4, $5)
  `, [tokenHash, employeeId, createdAt, expiresAt, userAgent || ""]);
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
      await pg.exec("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    }
    async function deleteSessionsForUser(employeeId) {
      await pg.exec("DELETE FROM sessions WHERE employee_id = $1", [employeeId]);
    }
    async function purgeExpiredSessions(nowIso) {
      await pg.exec("DELETE FROM sessions WHERE expires_at <= $1", [nowIso]);
    }
    async function getLoginAttempt(email) {
      return pg.one("SELECT email, count, first_at FROM login_attempts WHERE email = $1", [email]);
    }
    async function bumpLoginAttempt(email, nowIso, windowStartIso) {
      await pg.exec(`
    INSERT INTO login_attempts (email, count, first_at) VALUES ($1, 1, $2)
    ON CONFLICT (email) DO UPDATE SET
      count    = CASE WHEN login_attempts.first_at <= $3 THEN 1 ELSE login_attempts.count + 1 END,
      first_at = CASE WHEN login_attempts.first_at <= $3 THEN $2 ELSE login_attempts.first_at END
  `, [email, nowIso, windowStartIso]);
    }
    async function clearLoginAttempts(email) {
      await pg.exec("DELETE FROM login_attempts WHERE email = $1", [email]);
    }
    async function getSetting(key, fallback = null) {
      const r = await pg.one("SELECT value FROM app_settings WHERE key = $1", [key]);
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
      const v = await getSetting(key, fallback ? "1" : "0");
      return v === "1" || v === "true";
    }
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
      GAP_THRESHOLD,
      applySchema,
      seed,
      reseed,
      listDivisions,
      listTopics,
      listEmployees,
      overviewStats,
      employeeGaps,
      divisionGaps,
      scoreTrend,
      listRecommendations,
      getRecommendation,
      createRecommendation,
      acknowledgeRecommendation,
      employeeById,
      topicById,
      participantCurriculum,
      bestScoreForEmployee,
      recordAttempt,
      createQuizSession,
      getQuizSession,
      closeQuizSession,
      runSelect,
      schemaDescription,
      getSetting,
      setSetting,
      getBool,
      findUserByEmail,
      accountById,
      createUser,
      setPassword,
      staffWithoutPassword,
      listAccounts,
      setUserRole,
      setUserStatus,
      createSession,
      sessionUser,
      deleteSession,
      deleteSessionsForUser,
      purgeExpiredSessions,
      getLoginAttempt,
      bumpLoginAttempt,
      clearLoginAttempts
    };
  }
});

// lib/ai.js
var require_ai = __commonJS({
  "lib/ai.js"(exports, module) {
    "use strict";
    var PROVIDERS = {
      makers: {
        label: "EdgeOne Makers",
        url: "https://ai-gateway.edgeone.link/v1/chat/completions",
        keyEnv: "MAKERS_MODELS_KEY",
        modelEnv: "MAKERS_MODEL",
        defaultModel: "@makers/deepseek-v4-flash",
        keyHint: "Ambil di konsol Makers \u2192 Models \u2192 API Key, lalu set MAKERS_MODELS_KEY."
      },
      groq: {
        label: "Groq",
        url: "https://api.groq.com/openai/v1/chat/completions",
        keyEnv: "GROQ_API_KEY",
        modelEnv: "GROQ_MODEL",
        defaultModel: "llama-3.3-70b-versatile",
        keyHint: "Ambil di https://console.groq.com/keys, lalu set GROQ_API_KEY."
      }
    };
    function provider() {
      const forced = String(process.env.AI_PROVIDER || "").toLowerCase();
      if (PROVIDERS[forced]) return { name: forced, ...PROVIDERS[forced] };
      const name = process.env.MAKERS_MODELS_KEY ? "makers" : "groq";
      return { name, ...PROVIDERS[name] };
    }
    function cfg() {
      const p = provider();
      return {
        provider: p.name,
        providerLabel: p.label,
        key: process.env[p.keyEnv],
        keyEnv: p.keyEnv,
        model: process.env[p.modelEnv] || p.defaultModel
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
        messages
      };
      if (opts.json) body.response_format = { type: "json_object" };
      const res = await fetch(p.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${p.label} API ${res.status}: ${text.slice(0, 500)}`);
      }
      const data = await res.json();
      return {
        content: data.choices?.[0]?.message?.content ?? "",
        model: data.model,
        usage: data.usage
      };
    }
    function safeJson(str) {
      try {
        return JSON.parse(str);
      } catch (_) {
      }
      const m = str.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch (_) {
        }
      }
      return null;
    }
    async function gapRecommendation(gapData) {
      const { label, scopeType, overall, topics, gaps, gapThreshold } = gapData;
      const topicLines = topics.map((t) => `- ${t.topic} (area ${t.area || "-"}): avg ${t.avg_score}/100`).join("\n");
      const gapNames = gaps.map((g) => g.topic).join(", ") || "tidak ada gap signifikan";
      const messages = [
        {
          role: "system",
          content: "Anda adalah konsultan IT Audit & GRC senior. Berikan analisis dan rekomendasi yang ringkas, konkret, dan actionable dalam Bahasa Indonesia. Gunakan istilah audit yang tepat (ISO 27001, COBIT, NIST). Jangan mengarang data di luar yang diberikan."
        },
        {
          role: "user",
          content: `Berikut hasil kuis IT Auditor untuk ${scopeType === "division" ? "divisi" : "karyawan"} "${label}".
Skor rata-rata keseluruhan: ${overall}/100. Ambang gap (knowledge gap) = di baw${""}ah ${gapThreshold}.
Topik dengan gap: ${gapNames}.

Rincian skor per topik:
${topicLines}

Tugas:
1. Ringkas kondisi pengetahuan (2-3 kalimat), soroti area paling berisiko untuk audit IT.
2. Berikan 3-5 rekomendasi perbaikan yang spesifik dan dapat dieksekusi (training, kontrol, kebijakan).
3. Sebutkan prioritas (Tinggi/Sedang/Rendah) untuk tiap rekomendasi.
4. Nilai tingkat risiko keseluruhan (Tinggi/Sedang/Rendah) beserta alasan singkat.

Format jawaban dengan heading markdown yang rapi.`
        }
      ];
      const out = await chat(messages, { temperature: 0.35, max_tokens: 1100 });
      return out;
    }
    async function quizTopicRecommendation(gapData, availableTopics) {
      const { label, scopeType, gaps, topics, gapThreshold } = gapData;
      const weakLines = topics.filter((t) => t.avg_score < 85).map((t) => `- ${t.topic}: avg ${t.avg_score}/100`).join("\n") || "(semua topik kuat)";
      const messages = [
        {
          role: "system",
          content: "Anda perancang kurikulum pelatihan IT Audit. Keluarkan HANYA JSON valid sesuai skema. Semua teks naratif dalam Bahasa Indonesia."
        },
        {
          role: "user",
          content: `Untuk ${scopeType === "division" ? "divisi" : "karyawan"} "${label}", berdasarkan gap berikut:
${weakLines}

Daftar topik kuis yang tersedia: ${availableTopics.join(", ")}.
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
}`
        }
      ];
      const out = await chat(messages, { temperature: 0.3, json: true, max_tokens: 1e3 });
      const parsed = safeJson(out.content) || { summary: "", recommended_quizzes: [] };
      return { ...out, parsed };
    }
    var FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate|grant|revoke)\b/i;
    function sanitizeSql(raw) {
      let sql = (raw || "").trim();
      sql = sql.replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
      sql = sql.replace(/;+\s*$/g, "").trim();
      if (!/^(select|with)\b/i.test(sql)) {
        throw new Error("Hanya query SELECT (atau CTE WITH \u2026 SELECT) yang diizinkan oleh SQL Agent.");
      }
      if (sql.includes(";")) {
        throw new Error('Hanya satu statement yang diizinkan (tidak boleh ada ";").');
      }
      if (FORBIDDEN.test(sql)) {
        throw new Error("Query mengandung operasi yang tidak diizinkan (read-only saja).");
      }
      if (!/\blimit\b/i.test(sql)) sql += " LIMIT 200";
      return sql;
    }
    function sqlSystemPrompt(schema, gapThreshold = 70) {
      return `Anda SQL Agent untuk database SQLite READ-ONLY berisi hasil kuis IT Audit.
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
  JANGAN menghitung ulang AVG dari quiz_attempts untuk gap \u2014 pakai view agar hasilnya benar.
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
A: {"sql":"SELECT topic AS topik, avg_score AS skor_rata FROM v_division_topic WHERE division = 'IT' AND is_gap = 1 ORDER BY avg_score ASC","explanation":"Topik ber-gap pada divisi IT."}`;
    }
    async function sqlAgent(question, schema, gapThreshold = 70) {
      const messages = [
        { role: "system", content: sqlSystemPrompt(schema, gapThreshold) },
        { role: "user", content: question }
      ];
      const out = await chat(messages, { temperature: 0, json: true, max_tokens: 700 });
      const parsed = safeJson(out.content) || {};
      if (!parsed.sql) throw new Error("SQL Agent gagal menghasilkan query dari pertanyaan tersebut.");
      const sql = sanitizeSql(parsed.sql);
      return { sql, explanation: parsed.explanation || "", model: out.model, usage: out.usage };
    }
    async function repairSql(question, schema, badSql, error, gapThreshold = 70) {
      const messages = [
        { role: "system", content: sqlSystemPrompt(schema, gapThreshold) },
        { role: "user", content: question },
        { role: "assistant", content: JSON.stringify({ sql: badSql }) },
        {
          role: "user",
          content: `Query di atas GAGAL dijalankan dengan error SQLite: "${error}". Perbaiki query (tetap satu SELECT/CTE read-only, hanya kolom yang ada di skema). Keluarkan HANYA JSON {"sql":"...","explanation":"..."}.`
        }
      ];
      const out = await chat(messages, { temperature: 0, json: true, max_tokens: 700 });
      const parsed = safeJson(out.content) || {};
      if (!parsed.sql) throw new Error("SQL Agent gagal memperbaiki query.");
      const sql = sanitizeSql(parsed.sql);
      return { sql, explanation: parsed.explanation || "", model: out.model, usage: out.usage };
    }
    function validQuestions(arr) {
      if (!Array.isArray(arr)) return [];
      return arr.filter(
        (q) => q && typeof q.question === "string" && q.question.trim() && Array.isArray(q.options) && q.options.length === 4 && q.options.every((o) => typeof o === "string" && o.trim()) && Number.isInteger(q.answer_index) && q.answer_index >= 0 && q.answer_index < 4
      ).map((q) => ({
        question: q.question.trim(),
        options: q.options.map((o) => o.trim()),
        answer_index: q.answer_index,
        explanation: typeof q.explanation === "string" ? q.explanation.trim() : ""
      }));
    }
    var QUIZ_SYSTEM = "Anda penyusun soal sertifikasi IT Audit. Buat soal PILIHAN GANDA berkualitas, tingkat menengah, dalam Bahasa Indonesia. Tepat 4 opsi per soal dan TEPAT SATU jawaban benar. Keluarkan HANYA JSON valid sesuai skema.";
    var QUIZ_SCHEMA_HINT = `Skema JSON PERSIS:
{"questions":[{"question":"...","options":["opsi A","opsi B","opsi C","opsi D"],"answer_index":0,"explanation":"alasan singkat"}]}
answer_index adalah indeks 0..3 dari opsi yang BENAR.`;
    async function generateQuiz(topic, area, n = 10) {
      const messages = [
        { role: "system", content: QUIZ_SYSTEM },
        {
          role: "user",
          content: `Buat ${n} soal pilihan ganda untuk topik audit IT "${topic}" (area: ${area || "-"}).
Variasikan sub-konsep dalam topik. Hindari soal duplikat. Jawaban harus tidak ambigu.
${QUIZ_SCHEMA_HINT}`
        }
      ];
      const out = await chat(messages, { temperature: 0.5, json: true, max_tokens: 3800 });
      const parsed = safeJson(out.content) || {};
      return { questions: validQuestions(parsed.questions), model: out.model };
    }
    function fmtObservation(results) {
      if (!results || !results.length) return "(tidak ada materi relevan di basis pengetahuan)";
      return results.map((r, i) => `[#${i + 1} \xB7 sumber: ${r.source} \xB7 skor ${r.similarity}]
${String(r.content).slice(0, 600)}`).join("\n\n");
    }
    async function safeSearch(search, query) {
      try {
        return await search(query) || [];
      } catch (_) {
        return [];
      }
    }
    async function groundedGenerate(topic, area, n, contextChunks) {
      const ctx = (contextChunks || []).slice(0, 8).map((c, i) => `[Sumber ${i + 1} \u2014 ${c.source}]
${String(c.content).slice(0, 700)}`).join("\n\n").slice(0, 6500);
      const grounding = ctx ? `Gunakan KONTEKS dari dokumen PDF yang diimpor sebagai sumber UTAMA. Utamakan fakta, definisi, dan istilah dari konteks. Bila konteks kurang lengkap, lengkapi dengan pengetahuan umum IT audit yang benar.

=== KONTEKS PDF ===
${ctx}
=== AKHIR KONTEKS ===

` : "";
      const messages = [
        { role: "system", content: QUIZ_SYSTEM },
        {
          role: "user",
          content: `${grounding}Buat ${n} soal pilihan ganda untuk topik audit IT "${topic}" (area: ${area || "-"}).
Variasikan sub-konsep. Hindari soal duplikat. Jawaban harus tidak ambigu.
${QUIZ_SCHEMA_HINT}`
        }
      ];
      const out = await chat(messages, { temperature: 0.5, json: true, max_tokens: 3800 });
      const parsed = safeJson(out.content) || {};
      return { questions: validQuestions(parsed.questions), model: out.model };
    }
    function reactSystemPrompt(hasKB) {
      return `Anda agen penyusun soal IT Audit yang bekerja dengan pola ReAct (Reasoning + Acting).
Anda memiliki SATU tool:
- search_knowledge(query): mencari materi relevan dari dokumen PDF yang diimpor (basis pengetahuan RAG).

Pada SETIAP langkah, balas HANYA dengan satu objek JSON:
  {"thought":"penalaran singkat", "action":"search_knowledge"|"generate_quiz", "action_input":"..."}
- action "search_knowledge": action_input = string query pencarian. Gunakan untuk mengumpulkan fakta/definisi/istilah dari materi sebelum membuat soal.
- action "generate_quiz": action_input = string singkat penanda siap (mis. "materi cukup"). Pilih ini bila materi sudah memadai; sistem akan menyusun soal final dari materi yang terkumpul.

ATURAN:
- ${hasKB ? "WAJIB lakukan 1\u20132 kali search_knowledge dulu agar soal benar-benar berbasis materi PDF." : "Basis pengetahuan KOSONG; observasi akan kosong. Lakukan satu langkah lalu pilih generate_quiz (memakai pengetahuan umum IT audit)."}
- Jangan menulis soal di dalam action_input; cukup kumpulkan materi lalu pilih generate_quiz.
- Maksimal beberapa langkah; jangan bertele-tele.`;
    }
    async function generateQuizReAct(topic, area, n = 10, opts = {}) {
      const search = opts.search || null;
      const useKB = !!search && opts.hasKB !== false;
      const maxSteps = opts.maxSteps || 4;
      const trace = [];
      const contextChunks = [];
      const seen = /* @__PURE__ */ new Set();
      const addCtx = (arr) => {
        for (const c of arr) if (!seen.has(c.id)) {
          seen.add(c.id);
          contextChunks.push(c);
        }
      };
      const messages = [
        { role: "system", content: reactSystemPrompt(useKB) },
        { role: "user", content: `Tugas: susun ${n} soal pilihan ganda untuk topik "${topic}" (area: ${area || "-"}). Mulai dengan menalar dan, bila perlu, panggil search_knowledge.` }
      ];
      let model = "";
      for (let step = 0; step < maxSteps; step++) {
        let obj = {};
        try {
          const out = await chat(messages, { temperature: 0.3, json: true, max_tokens: 500 });
          model = out.model;
          obj = safeJson(out.content) || {};
        } catch (_) {
          break;
        }
        const action = String(obj.action || "").toLowerCase();
        const thought = String(obj.thought || "").slice(0, 400);
        if (useKB && action.includes("search") && obj.action_input) {
          const query = String(obj.action_input).slice(0, 200);
          const results = await safeSearch(search, query);
          addCtx(results);
          const observation = fmtObservation(results);
          trace.push({ thought, action: "search_knowledge", action_input: query, observation });
          messages.push({ role: "assistant", content: JSON.stringify({ thought, action: "search_knowledge", action_input: query }) });
          messages.push({ role: "user", content: `Observation:
${observation}

Lanjutkan. Bila materi cukup, balas dengan action "generate_quiz".` });
          continue;
        }
        trace.push({ thought, action: "generate_quiz", action_input: String(obj.action_input || "materi cukup"), observation: "" });
        break;
      }
      if (useKB && !contextChunks.length) {
        addCtx(await safeSearch(search, `${topic} ${area || ""}`.trim()));
      }
      const gen = await groundedGenerate(topic, area, n, contextChunks);
      const sources = dedupeSources(contextChunks);
      trace.push({ thought: `Menyusun ${gen.questions.length} soal final berbasis ${contextChunks.length} potongan materi.`, action: "final_answer", action_input: "", observation: "" });
      return { questions: gen.questions, model: gen.model || model, trace, sources };
    }
    function dedupeSources(chunks) {
      const m = /* @__PURE__ */ new Map();
      for (const c of chunks || []) m.set(c.source, (m.get(c.source) || 0) + 1);
      return [...m.entries()].map(([source, chunks2]) => ({ source, chunks: chunks2 }));
    }
    var GROUND_MIN = Number(process.env.QUIZ_GROUND_MIN) || 0.63;
    function validQuestionsWithBlock(arr) {
      if (!Array.isArray(arr)) return [];
      const out = [];
      for (const q of arr) {
        if (!q || typeof q.question !== "string" || !q.question.trim()) continue;
        if (!Array.isArray(q.options) || q.options.length !== 4) continue;
        if (!q.options.every((o) => typeof o === "string" && o.trim())) continue;
        if (!Number.isInteger(q.answer_index) || q.answer_index < 0 || q.answer_index > 3) continue;
        out.push({
          question: q.question.trim(),
          options: q.options.map((o) => o.trim()),
          answer_index: q.answer_index,
          explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
          block: Number.isInteger(q.block) ? q.block : null
        });
      }
      return out;
    }
    async function planQuizSubtopics(topic, area, n, hasKB) {
      const messages = [
        {
          role: "system",
          content: `Anda agen ReAct (Reasoning + Acting) penyusun soal IT Audit. Tugas Anda MERENCANAKAN materi sebelum membuat soal.
Rencanakan ${n} sub-konsep BERBEDA untuk topik, dan untuk tiap sub-konsep tulis SATU query pencarian (Bahasa Indonesia) yang akan dipakai memanggil tool search_knowledge guna menarik materi dari dokumen regulasi (PDF/POJK) di basis pengetahuan RAG.
${hasKB ? "Basis pengetahuan berisi dokumen regulasi; buat query spesifik (istilah/pasal/proses) agar retrieval relevan." : "Basis pengetahuan mungkin kosong; query tetap berguna sebagai penanda variasi sub-konsep."}
Keluarkan HANYA JSON: {"thought":"penalaran singkat","subtopics":[{"subconcept":"...","query":"..."}]} dengan TEPAT ${n} item.`
        },
        { role: "user", content: `Topik: "${topic}" (area: ${area || "-"}). Rencanakan ${n} sub-konsep + query pencarian.` }
      ];
      const out = await chat(messages, { temperature: 0.4, json: true, max_tokens: 900 });
      const parsed = safeJson(out.content) || {};
      const subs = (Array.isArray(parsed.subtopics) ? parsed.subtopics : []).filter((s) => s && (s.subconcept || s.query)).map((s) => ({
        subconcept: String(s.subconcept || s.query || topic).slice(0, 120),
        query: String(s.query || s.subconcept || topic).slice(0, 200)
      }));
      return { thought: String(parsed.thought || "").slice(0, 400), subtopics: subs, model: out.model };
    }
    function blockContext(chunks) {
      if (!chunks || !chunks.length) return "(tidak ada materi relevan di basis pengetahuan)";
      return chunks.slice(0, 3).map((c) => String(c.content).slice(0, 700)).join("\n---\n").slice(0, 1800);
    }
    async function groundedGeneratePerQuestion(topic, area, items) {
      const n = items.length;
      const blocks = items.map((it, i) => `=== BLOK ${i + 1} \u2014 sub-konsep: ${it.subconcept || topic} ===
KONTEKS:
${blockContext(it.context)}`).join("\n\n").slice(0, 12e3);
      const messages = [
        { role: "system", content: QUIZ_SYSTEM },
        {
          role: "user",
          content: `Buat TEPAT ${n} soal pilihan ganda untuk topik audit IT "${topic}" (area: ${area || "-"}).
Buat tepat SATU soal untuk SETIAP blok di bawah. Soal untuk blok-k HARUS membahas sub-konsep blok itu.
- Bila KONTEKS blok berisi materi relevan, soal WAJIB berbasis fakta/definisi/istilah dari KONTEKS blok itu (jangan memakai konteks blok lain, jangan mengarang).
- Bila KONTEKS blok kosong/tidak relevan, susun soal dari pengetahuan umum IT audit yang benar.
Sertakan field "block" (nomor blok 1..${n}) pada tiap soal agar dapat dipetakan ke materinya.

${blocks}

${QUIZ_SCHEMA_HINT}
Tambahan WAJIB: tiap objek soal punya "block": <nomor blok 1..${n}> sesuai blok yang menjadi dasarnya.`
        }
      ];
      const out = await chat(messages, { temperature: 0.45, json: true, max_tokens: 4200 });
      const parsed = safeJson(out.content) || {};
      return { questions: validQuestionsWithBlock(parsed.questions), model: out.model };
    }
    async function generateQuizReActPerQuestion(topic, area, n = 10, opts = {}) {
      const search = opts.search || null;
      const useKB = !!search && opts.hasKB !== false;
      const trace = [];
      let model = "";
      let plan;
      try {
        plan = await planQuizSubtopics(topic, area, n, useKB);
        model = plan.model;
      } catch (_) {
        plan = { thought: "", subtopics: [], model: "" };
      }
      const subs = plan.subtopics.slice(0, n);
      while (subs.length < n) {
        subs.push({ subconcept: `${topic} \u2014 aspek ${subs.length + 1}`, query: `${topic} ${area || ""}`.trim() });
      }
      trace.push({
        thought: plan.thought || `Merencanakan ${n} sub-konsep untuk "${topic}".`,
        action: "plan_subtopics",
        action_input: subs.map((s) => s.subconcept).join(" \xB7 ").slice(0, 220),
        observation: ""
      });
      const items = [];
      const allChunks = [];
      for (const s of subs) {
        const results = useKB ? await safeSearch(search, s.query) : [];
        const top = results[0] || null;
        const grounded = !!(top && top.similarity >= GROUND_MIN);
        const strong = results.filter((r) => r.similarity >= GROUND_MIN);
        const ctx = strong.length ? strong : results.length ? results.slice(0, 1) : [];
        items.push({
          subconcept: s.subconcept,
          query: s.query,
          context: ctx,
          grounded,
          source: grounded ? top.source : null,
          similarity: top ? top.similarity : null
        });
        for (const c of ctx) allChunks.push(c);
        if (useKB) {
          trace.push({
            thought: `Sub-konsep: ${s.subconcept}`,
            action: "search_knowledge",
            action_input: s.query,
            observation: results.length ? `${results.length} hasil \xB7 top: ${top.source} (skor ${top.similarity})${grounded ? "" : " \u2014 di bawah ambang, di-blend dengan pengetahuan umum"}` : "(tidak ada materi relevan)"
          });
        }
      }
      const gen = await groundedGeneratePerQuestion(topic, area, items);
      model = gen.model || model;
      const questions = gen.questions.map((q, i) => {
        const bi = q.block && q.block >= 1 && q.block <= items.length ? q.block - 1 : i;
        const it = items[bi] || items[i] || {};
        const topChunk = it.context && it.context[0] || null;
        return {
          question: q.question,
          options: q.options,
          answer_index: q.answer_index,
          explanation: q.explanation,
          grounded: !!it.grounded,
          source: it.grounded ? it.source : null,
          similarity: it.similarity ?? null,
          subconcept: it.subconcept || "",
          // Kutipan materi RAG yang menjadi dasar soal (untuk expander "lihat kutipan sumber").
          excerpt: it.grounded && topChunk ? String(topChunk.content).slice(0, 800) : null
        };
      });
      const uniqChunks = [...new Map(allChunks.map((c) => [c.id, c])).values()];
      const sources = dedupeSources(uniqChunks);
      const groundedCount = questions.filter((q) => q.grounded).length;
      trace.push({
        thought: `Menyusun ${questions.length} soal \u2014 ${groundedCount} berbasis materi PDF, ${questions.length - groundedCount} dari pengetahuan umum (di-blend & ditandai).`,
        action: "final_answer",
        action_input: "",
        observation: ""
      });
      return { questions, model, trace, sources, groundedCount };
    }
    module.exports = {
      chat,
      cfg,
      gapRecommendation,
      quizTopicRecommendation,
      sqlAgent,
      repairSql,
      sanitizeSql,
      generateQuiz,
      generateQuizReAct,
      groundedGenerate,
      generateQuizReActPerQuestion
    };
  }
});

// lib/embedder.js
var require_embedder = __commonJS({
  "lib/embedder.js"(exports, module) {
    "use strict";
    async function geminiEmbedRaw(apiKey, model, text, taskType) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text: String(text) }] },
          taskType
        }),
        signal: AbortSignal.timeout(3e4)
      });
      if (!r.ok) {
        const e = await r.text();
        throw new Error(`Gemini ${r.status}: ${e.slice(0, 200)}`);
      }
      const j = await r.json();
      if (!Array.isArray(j.embedding?.values)) throw new Error("Gemini: respons tanpa embedding.values");
      return j.embedding.values;
    }
    async function tryGemini(apiKey) {
      const model = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
      const name = `gemini:${model}`;
      let dim;
      try {
        const cached = await getDbSetting("embed_meta");
        const meta = cached ? JSON.parse(cached) : null;
        dim = meta && meta.name === name ? meta.dim : null;
      } catch (_) {
        dim = null;
      }
      if (!dim) {
        const probe = await geminiEmbedRaw(apiKey, model, "a", "RETRIEVAL_DOCUMENT");
        dim = probe.length;
      }
      return {
        name,
        dim,
        kind: "model",
        embed: async (text, role) => {
          const taskType = role === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
          return Float32Array.from(await geminiEmbedRaw(apiKey, model, text, taskType));
        }
      };
    }
    async function getDbSetting(key) {
      try {
        const pg = require_pg();
        const r = await pg.one("SELECT value FROM app_settings WHERE key = $1", [key]);
        return r ? r.value : null;
      } catch (_) {
        return null;
      }
    }
    async function setDbSetting(key, value) {
      try {
        const pg = require_pg();
        await pg.exec(
          "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          [key, value]
        );
      } catch (_) {
      }
    }
    var resolved = null;
    var resolving = null;
    function init() {
      if (resolved) return Promise.resolve(resolved);
      if (resolving) return resolving;
      resolving = (async () => {
        const geminiKey = await getDbSetting("embed_gemini_key") || process.env.GEMINI_API_KEY;
        const dbGeminiModel = await getDbSetting("embed_gemini_model");
        if (dbGeminiModel) process.env.GEMINI_EMBED_MODEL = dbGeminiModel;
        if (!geminiKey) {
          throw new Error("GEMINI_API_KEY tidak disetel. Tambahkan ke .env atau konfigurasi via Settings UI.");
        }
        return resolved = await tryGemini(geminiKey);
      })();
      return resolving;
    }
    async function reconfigure({ geminiKey, geminiModel } = {}) {
      await setDbSetting("embed_backend", "gemini");
      if (geminiKey !== void 0) await setDbSetting("embed_gemini_key", geminiKey);
      if (geminiModel) await setDbSetting("embed_gemini_model", geminiModel);
      resolved = null;
      resolving = null;
      return init();
    }
    function active() {
      return resolved;
    }
    module.exports = { init, active, reconfigure };
  }
});

// lib/vec.js
var require_vec = __commonJS({
  "lib/vec.js"(exports, module) {
    "use strict";
    var pg = require_pg();
    var embedder = require_embedder();
    function toVector(vec) {
      return `[${Array.from(vec).join(",")}]`;
    }
    function round2(x) {
      return Math.round(x * 100) / 100;
    }
    async function columnDim() {
      const row = await pg.one(`
    SELECT format_type(a.atttypid, a.atttypmod) AS t
    FROM pg_attribute a
    WHERE a.attrelid = 'pdf_chunks'::regclass AND a.attname = 'embedding'
  `);
      const m = row && /vector\((\d+)\)/.exec(row.t);
      return m ? Number(m[1]) : null;
    }
    var readyP = null;
    function ready() {
      return readyP || (readyP = reconcile());
    }
    async function getMeta() {
      const r = await pg.one("SELECT value FROM app_settings WHERE key = 'embed_meta'");
      try {
        return r ? JSON.parse(r.value) : null;
      } catch (_) {
        return null;
      }
    }
    async function setMeta(be) {
      await pg.exec(`
    INSERT INTO app_settings (key, value) VALUES ('embed_meta', $1)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `, [JSON.stringify({ name: be.name, dim: be.dim })]);
    }
    async function reconcile() {
      const be = await embedder.init();
      const prev = await getMeta();
      if (!prev || prev.name !== be.name || prev.dim !== be.dim) {
        await reindex(be);
        await setMeta(be);
      }
      return be;
    }
    var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function reindex(be) {
      const dim = await columnDim();
      if (dim !== be.dim) {
        await pg.exec("UPDATE pdf_chunks SET embedding = NULL");
        await pg.exec(`ALTER TABLE pdf_chunks ALTER COLUMN embedding TYPE vector(${be.dim})`);
      }
      const rows = await pg.many("SELECT id, content FROM pdf_chunks");
      if (!rows.length) return;
      const isCloudBackend = be.kind === "model" && /gemini/.test(be.name);
      for (let i = 0; i < rows.length; i++) {
        const vec = toVector(await be.embed(rows[i].content, "passage"));
        await pg.exec("UPDATE pdf_chunks SET embedding = $1::vector WHERE id = $2", [vec, rows[i].id]);
        if (isCloudBackend && i % 20 === 19) await sleep(200);
      }
      console.log(`  RAG: ${rows.length} chunk di-embed ulang dengan ${be.name} (dim ${be.dim}).`);
    }
    function chunkText(text, size = 900, overlap = 150) {
      const clean = String(text).replace(/[ \t]+\n/g, "\n").trim();
      const paras = clean.split(/\n{2,}/);
      const chunks = [];
      let buf = "";
      const flush = () => {
        if (buf.trim().length > 20) chunks.push(buf.trim());
        buf = "";
      };
      for (const p of paras) {
        if (p.length > size) {
          flush();
          for (let i = 0; i < p.length; i += size - overlap) {
            const piece = p.slice(i, i + size).trim();
            if (piece.length > 20) chunks.push(piece);
          }
          continue;
        }
        if (buf && buf.length + 2 + p.length > size) flush();
        buf = buf ? buf + "\n\n" + p : p;
      }
      flush();
      return chunks;
    }
    var RE_BAB = /^\s*BAB\s+[IVXLCDM]+\b/;
    var RE_PASAL = /^\s*Pasal\s+\d+\s*$/;
    var RE_SECTION = /^\s*[A-Z]\.\s+\S/;
    var RE_POINT = /^\s*\d{1,2}\.\s+\S/;
    var RE_SUBPOINT = /^\s*[a-z]\.\s+\S/;
    var RE_TOC = /\.{4,}\s*-?\s*\d+\s*-?\s*$/;
    function parseHierarchyChunks(text, { maxChars = 3500, minChars = 40 } = {}) {
      const chunks = [];
      let bab = null, section = null, point = null, subpoint = null;
      let bufLines = [];
      const pushChunk = (body) => {
        if (body.length < minChars) return;
        const crumb = [bab, section, point, subpoint].filter(Boolean).join(" > ");
        const full = crumb ? `[${crumb}]
${body}` : body;
        if (full.length <= maxChars) {
          chunks.push(full);
          return;
        }
        const sents = full.split(/(?<=[.;:])\s+/);
        let cur = "";
        for (const s of sents) {
          if (cur && cur.length + s.length + 1 > maxChars) {
            chunks.push(cur.trim());
            cur = s;
          } else cur = cur ? `${cur} ${s}` : s;
        }
        if (cur.trim()) chunks.push(cur.trim());
      };
      const flush = () => {
        pushChunk(bufLines.join("\n").trim());
        bufLines = [];
      };
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trimEnd();
        if (!line.trim() || RE_TOC.test(line) || line.trim() === "DAFTAR ISI") continue;
        if (RE_BAB.test(line)) {
          flush();
          bab = line.trim();
          section = point = subpoint = null;
          continue;
        }
        if (RE_PASAL.test(line)) {
          flush();
          bab = line.trim();
          section = point = subpoint = null;
          continue;
        }
        if (RE_SECTION.test(line)) {
          flush();
          section = line.trim();
          point = subpoint = null;
          bufLines.push(line.trim());
          continue;
        }
        if (RE_POINT.test(line)) {
          flush();
          point = line.trim();
          subpoint = null;
          bufLines.push(line.trim());
          continue;
        }
        if (RE_SUBPOINT.test(line)) {
          flush();
          subpoint = line.trim();
          bufLines.push(line.trim());
          continue;
        }
        bufLines.push(line.trim());
      }
      flush();
      return chunks;
    }
    async function addDocument({ filename, title, text, numPages, bytes, legalMode }) {
      const be = await ready();
      const useLegal = legalMode ?? true;
      const chunks = useLegal ? parseHierarchyChunks(text) : chunkText(text);
      if (!chunks.length) {
        throw new Error("Tidak ada teks yang dapat dipotong dari PDF (kemungkinan hasil scan/gambar).");
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const doc = await pg.one(`
    INSERT INTO pdf_documents (filename, title, num_pages, num_chunks, bytes, chars, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
  `, [filename, title || filename, numPages || null, chunks.length, bytes || null, text.length, now]);
      for (let i = 0; i < chunks.length; i++) {
        const vec = toVector(await be.embed(chunks[i], "passage"));
        await pg.exec(
          "INSERT INTO pdf_chunks (doc_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4::vector)",
          [doc.id, i, chunks[i], vec]
        );
      }
      return {
        id: doc.id,
        filename,
        title: title || filename,
        num_pages: numPages || null,
        num_chunks: chunks.length,
        chars: text.length
      };
    }
    async function search(query, k = 5) {
      const be = await ready();
      const qv = toVector(await be.embed(query, "query"));
      const rows = await pg.many(`
    SELECT c.id, c.content, d.title AS source,
           (c.embedding <=> $1::vector) AS distance
    FROM pdf_chunks c
    JOIN pdf_documents d ON d.id = c.doc_id
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $1::vector
    LIMIT $2
  `, [qv, k]);
      return rows.map((r) => ({
        id: r.id,
        content: r.content,
        source: r.source,
        similarity: round2(1 - Number(r.distance))
      }));
    }
    async function listDocuments() {
      return pg.many(`
    SELECT id, filename, title, num_pages, num_chunks, chars, bytes, created_at
    FROM pdf_documents ORDER BY created_at DESC
  `);
    }
    async function deleteDocument(id) {
      const rows = await pg.many("DELETE FROM pdf_documents WHERE id = $1 RETURNING id", [id]);
      return rows.length > 0;
    }
    async function stats() {
      const be = embedder.active();
      const c = await pg.one(`
    SELECT (SELECT COUNT(*)::int FROM pdf_documents) AS documents,
           (SELECT COUNT(*)::int FROM pdf_chunks)    AS chunks
  `);
      return {
        documents: c.documents,
        chunks: c.chunks,
        dim: be ? be.dim : null,
        backend: "pgvector (cosine)",
        embedder: be ? be.name : "(loading\u2026)",
        embedderKind: be ? be.kind : null
      };
    }
    function resetEmbedder() {
      readyP = null;
      ready().catch((e) => console.error("RAG reindex error:", e.message));
    }
    module.exports = { ready, addDocument, search, listDocuments, deleteDocument, stats, resetEmbedder };
  }
});

// lib/pdf.js
var require_pdf = __commonJS({
  "lib/pdf.js"(exports, module) {
    "use strict";
    var zlib = __require("node:zlib");
    function readLiteral(s, i) {
      let depth = 0, out = "", j = i + 1;
      const oct = (str) => (str.match(/^[0-7]{1,3}/) || [""])[0];
      for (; j < s.length; j++) {
        const ch = s[j];
        if (ch === "\\") {
          const nx = s[j + 1];
          const map = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
          if (nx in map) {
            out += map[nx];
            j++;
            continue;
          }
          const o = oct(s.slice(j + 1, j + 4));
          if (o) {
            out += String.fromCharCode(parseInt(o, 8) & 255);
            j += o.length;
            continue;
          }
          if (nx === "\n") {
            j++;
            continue;
          }
          if (nx === "\r") {
            j += s[j + 2] === "\n" ? 2 : 1;
            continue;
          }
          out += nx;
          j++;
          continue;
        }
        if (ch === "(") {
          depth++;
          out += ch;
          continue;
        }
        if (ch === ")") {
          if (depth === 0) {
            j++;
            break;
          }
          depth--;
          out += ch;
          continue;
        }
        out += ch;
      }
      return [out, j];
    }
    function readHex(s, i) {
      let j = i + 1, hex = "";
      for (; j < s.length && s[j] !== ">"; j++) if (/[0-9a-fA-F]/.test(s[j])) hex += s[j];
      if (hex.length % 2) hex += "0";
      let out = "";
      for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16) & 255);
      return [out, j + 1];
    }
    function readNumber(s, i, n) {
      let j = i + 1;
      while (j < n && /[0-9.eE+\-]/.test(s[j])) j++;
      return [parseFloat(s.slice(i, j)), j];
    }
    function parseTextBlock(s, state = { lastY: null }) {
      let out = "", i = 0;
      const n = s.length;
      let nums = [];
      const TJ_SPACE = -200;
      while (i < n) {
        const c = s[i];
        if (c === "(") {
          const [str, ni] = readLiteral(s, i);
          out += str;
          nums = [];
          i = ni;
          continue;
        }
        if (c === "<" && s[i + 1] !== "<") {
          const [str, ni] = readHex(s, i);
          out += str;
          nums = [];
          i = ni;
          continue;
        }
        if (c === "[") {
          i++;
          while (i < n && s[i] !== "]") {
            const ch = s[i];
            if (ch === "(") {
              const [str, ni] = readLiteral(s, i);
              out += str;
              i = ni;
              continue;
            }
            if (ch === "<" && s[i + 1] !== "<") {
              const [str, ni] = readHex(s, i);
              out += str;
              i = ni;
              continue;
            }
            if (ch === "-" || ch === "." || ch >= "0" && ch <= "9") {
              const [v, ni] = readNumber(s, i, n);
              if (v <= TJ_SPACE) out += " ";
              i = ni;
              continue;
            }
            i++;
          }
          i++;
          while (i < n && /\s/.test(s[i])) i++;
          if (s[i] === "T" && (s[i + 1] === "J" || s[i + 1] === "j")) i += 2;
          nums = [];
          continue;
        }
        if (c === "-" || c === "+" || c === "." || c >= "0" && c <= "9") {
          const [v, ni] = readNumber(s, i, n);
          if (!Number.isNaN(v)) nums.push(v);
          i = ni;
          continue;
        }
        if (c === "T") {
          const op = s[i + 1];
          if (op === "*") {
            out += "\n";
            i += 2;
            nums = [];
            continue;
          }
          if (op === "d" || op === "D") {
            const ty = nums.length ? nums[nums.length - 1] : 0;
            out += Math.abs(ty) > 0.01 ? "\n" : " ";
            i += 2;
            nums = [];
            continue;
          }
          if (op === "m") {
            const f = nums.length ? nums[nums.length - 1] : null;
            if (f !== null && state.lastY !== null && Math.abs(f - state.lastY) > 0.01) out += "\n";
            if (f !== null) state.lastY = f;
            i += 2;
            nums = [];
            continue;
          }
          i += 2;
          nums = [];
          continue;
        }
        if (c === "'" || c === '"') {
          out += "\n";
          i++;
          nums = [];
          continue;
        }
        if (/[A-Za-z]/.test(c)) {
          let j = i + 1;
          while (j < n && /[A-Za-z0-9*]/.test(s[j])) j++;
          i = j;
          nums = [];
          continue;
        }
        i++;
      }
      return out;
    }
    function extractFromContent(s) {
      let result = "", blocks = 0, m;
      const btRe = /BT([\s\S]*?)ET/g;
      const state = { lastY: null };
      while (m = btRe.exec(s)) {
        blocks++;
        result += parseTextBlock(m[1], state) + " ";
      }
      if (blocks === 0) result = parseTextBlock(s, state);
      return result;
    }
    function normalize(t) {
      return t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    function extractText(buffer) {
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const raw = bytes.toString("latin1");
      const parts = [];
      const streamRe = /stream\r?\n/g;
      let m;
      while (m = streamRe.exec(raw)) {
        const start = m.index + m[0].length;
        const end = raw.indexOf("endstream", start);
        if (end < 0) break;
        const dictStart = raw.lastIndexOf("<<", m.index);
        const dict = dictStart >= 0 ? raw.slice(dictStart, m.index) : "";
        let e = end;
        while (e > start && (bytes[e - 1] === 10 || bytes[e - 1] === 13)) e--;
        const data = bytes.subarray(start, e);
        let text = null;
        if (/FlateDecode/.test(dict)) {
          try {
            text = zlib.inflateSync(data).toString("latin1");
          } catch (_) {
            try {
              text = zlib.inflateRawSync(data).toString("latin1");
            } catch (__) {
              text = null;
            }
          }
        } else if (!/\/Filter/.test(dict)) {
          text = data.toString("latin1");
        }
        if (text) parts.push(text);
        streamRe.lastIndex = end + 9;
      }
      let out = extractFromContent(parts.join("\n"));
      if (!out.trim()) out = extractFromContent(raw);
      const numPages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length || null;
      return { text: normalize(out), numPages };
    }
    module.exports = { extractText };
  }
});

// lib/auth.js
var require_auth = __commonJS({
  "lib/auth.js"(exports, module) {
    "use strict";
    var crypto = __require("node:crypto");
    var db = require_db();
    var SESSION_TTL_DAYS = 7;
    var SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
    var ROLES = ["employee", "auditor", "director", "super_admin"];
    var STAFF_ROLES = ["auditor", "director", "super_admin"];
    function hashPassword(plain) {
      const salt = crypto.randomBytes(16);
      const key = crypto.scryptSync(plain, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
      return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
    }
    function verifyPassword(plain, stored) {
      if (!stored || typeof stored !== "string") return false;
      const parts = stored.split("$");
      if (parts.length !== 6 || parts[0] !== "scrypt") return false;
      const [, N, r, p, saltB64, keyB64] = parts;
      const salt = Buffer.from(saltB64, "base64");
      const expected = Buffer.from(keyB64, "base64");
      let actual;
      try {
        actual = crypto.scryptSync(plain, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
      } catch (_) {
        return false;
      }
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    async function validateRegistration({ name, email, password, divisionId }) {
      const errors = [];
      if (!name || name.trim().length < 3) errors.push("Nama lengkap minimal 3 karakter.");
      if (!email || !EMAIL_RE.test(email.trim())) errors.push("Email tidak valid.");
      if (!password || password.length < 8) errors.push("Kata sandi minimal 8 karakter.");
      else if (!/\d/.test(password)) errors.push("Kata sandi harus memuat setidaknya satu angka.");
      if (!divisionId) errors.push("Pilih divisi Anda.");
      else if (!(await db.listDivisions()).some((d) => d.id === Number(divisionId))) errors.push("Divisi tidak dikenal.");
      return errors;
    }
    var WINDOW_MS = 10 * 60 * 1e3;
    var MAX_ATTEMPTS = 8;
    async function throttled(email) {
      const rec = await db.getLoginAttempt(email);
      if (!rec) return false;
      if (Date.now() - Date.parse(rec.first_at) > WINDOW_MS) {
        await db.clearLoginAttempts(email);
        return false;
      }
      return rec.count >= MAX_ATTEMPTS;
    }
    async function noteFailure(email) {
      const now = /* @__PURE__ */ new Date();
      await db.bumpLoginAttempt(
        email,
        now.toISOString(),
        new Date(now.getTime() - WINDOW_MS).toISOString()
      );
    }
    async function clearFailures(email) {
      await db.clearLoginAttempts(email);
    }
    function tokenHash(token) {
      return crypto.createHash("sha256").update(token).digest("hex");
    }
    async function startSession(employeeId, userAgent) {
      const token = crypto.randomBytes(32).toString("base64url");
      const now = /* @__PURE__ */ new Date();
      const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 864e5);
      await db.createSession({
        tokenHash: tokenHash(token),
        employeeId,
        createdAt: now.toISOString(),
        expiresAt: expires.toISOString(),
        userAgent: (userAgent || "").slice(0, 200)
      });
      return { token, expires };
    }
    async function endSession(token) {
      if (token) await db.deleteSession(tokenHash(token));
    }
    async function currentUser(req) {
      const token = readCookie(req, "sid");
      if (!token) return null;
      const user = await db.sessionUser(tokenHash(token), (/* @__PURE__ */ new Date()).toISOString());
      if (!user) return null;
      if (user.status && user.status !== "active") return null;
      return user;
    }
    function readCookie(req, name) {
      const raw = req.headers.cookie;
      if (!raw) return null;
      for (const part of raw.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0) continue;
        if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
      }
      return null;
    }
    function isSecureRequest(req) {
      const override = String(process.env.COOKIE_SECURE || "").toLowerCase();
      if (override === "1" || override === "true") return true;
      if (override === "0" || override === "false") return false;
      const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
      if (proto) return proto === "https";
      return !!(req.socket && req.socket.encrypted);
    }
    function cookieAttrs(secure) {
      return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
    }
    function sessionCookie(token, expires, secure = false) {
      const maxAge = Math.max(0, Math.floor((expires - Date.now()) / 1e3));
      return `sid=${encodeURIComponent(token)}; ${cookieAttrs(secure)}; Max-Age=${maxAge}`;
    }
    function clearCookie(secure = false) {
      return `sid=; ${cookieAttrs(secure)}; Max-Age=0`;
    }
    async function bootstrap() {
      const seedPassword = process.env.SEED_PASSWORD || "Auditor#2026";
      const pending = await db.staffWithoutPassword();
      if (!pending.length) return { seeded: [], seedPassword: null };
      const hash = hashPassword(seedPassword);
      for (const u of pending) await db.setPassword(u.id, hash);
      await db.purgeExpiredSessions((/* @__PURE__ */ new Date()).toISOString());
      return { seeded: pending.map((u) => u.email), seedPassword };
    }
    module.exports = {
      ROLES,
      STAFF_ROLES,
      SESSION_TTL_DAYS,
      hashPassword,
      verifyPassword,
      validateRegistration,
      throttled,
      noteFailure,
      clearFailures,
      startSession,
      endSession,
      currentUser,
      readCookie,
      sessionCookie,
      clearCookie,
      isSecureRequest,
      bootstrap
    };
  }
});

// lib/api.js
var require_api = __commonJS({
  "lib/api.js"(exports, module) {
    "use strict";
    require_env().loadEnv();
    var db = require_db();
    var ai = require_ai();
    var vec = require_vec();
    var pdf = require_pdf();
    var auth = require_auth();
    var MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
    function sendJson(res, code, obj, headers = {}) {
      const body = JSON.stringify(obj);
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...headers });
      res.end(body);
    }
    function readBody(req) {
      return new Promise((resolve) => {
        let data = "";
        req.on("data", (c) => {
          data += c;
          if (data.length > 1e6) req.destroy();
        });
        req.on("end", () => {
          if (!data) return resolve({});
          try {
            resolve(JSON.parse(data));
          } catch (_) {
            resolve({});
          }
        });
      });
    }
    function readRawBody(req, maxBytes = MAX_UPLOAD_BYTES) {
      return new Promise((resolve, reject) => {
        const chunks = [];
        let len = 0;
        req.on("data", (c) => {
          len += c.length;
          if (len > maxBytes) {
            req.destroy();
            reject(new Error(`Berkas terlalu besar (maks ${Math.round(maxBytes / 1024 / 1024)}MB).`));
            return;
          }
          chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    }
    function publicUser(u) {
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        division: u.division,
        divisionId: u.divisionId,
        status: u.status
      };
    }
    var isSuper = (u) => u.role === "super_admin";
    var isStaff = (u) => auth.STAFF_ROLES.includes(u.role);
    function monthMinus(ym, k) {
      let [y, m] = ym.split("-").map(Number);
      m -= k;
      while (m <= 0) {
        m += 12;
        y -= 1;
      }
      return `${y}-${String(m).padStart(2, "0")}`;
    }
    async function resolveGapData(body) {
      const ref = Number(body.scope_ref);
      if (body.scope_type === "employee") {
        const g = await db.employeeGaps(ref);
        if (!g) return null;
        return { scopeType: "employee", label: g.employee.name, refId: ref, ...g };
      }
      if (body.scope_type === "division") {
        const g = await db.divisionGaps(ref);
        if (!g) return null;
        return { scopeType: "division", label: g.division.name, refId: ref, ...g };
      }
      return null;
    }
    async function publicApi(req, res, p) {
      if (req.method === "GET" && p === "/api/auth/divisions") {
        sendJson(res, 200, await db.listDivisions());
        return true;
      }
      if (req.method === "POST" && p === "/api/auth/register") {
        const body = await readBody(req);
        const name = String(body.name || "").trim();
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        const divisionId = Number(body.division_id) || null;
        const errors = await auth.validateRegistration({ name, email, password, divisionId });
        if (errors.length) {
          sendJson(res, 400, { error: errors[0], errors });
          return true;
        }
        if (await db.findUserByEmail(email)) {
          sendJson(res, 409, { error: "Email ini sudah terdaftar. Masuk dengan kata sandi Anda." });
          return true;
        }
        const user = await db.createUser({
          name,
          email,
          divisionId,
          role: "employee",
          passwordHash: auth.hashPassword(password)
        });
        const { token, expires } = await auth.startSession(user.id, req.headers["user-agent"]);
        sendJson(res, 201, { user: publicUser(user) }, { "Set-Cookie": auth.sessionCookie(token, expires, auth.isSecureRequest(req)) });
        return true;
      }
      if (req.method === "POST" && p === "/api/auth/login") {
        const body = await readBody(req);
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        if (!email || !password) {
          sendJson(res, 400, { error: "Isi email dan kata sandi." });
          return true;
        }
        if (await auth.throttled(email)) {
          sendJson(res, 429, { error: "Terlalu banyak percobaan gagal. Coba lagi dalam 10 menit." });
          return true;
        }
        const user = await db.findUserByEmail(email);
        if (!user || !user.password_hash || !auth.verifyPassword(password, user.password_hash)) {
          await auth.noteFailure(email);
          sendJson(res, 401, { error: "Email atau kata sandi salah." });
          return true;
        }
        if (user.status !== "active") {
          sendJson(res, 403, { error: "Akun ini dinonaktifkan. Hubungi Super Admin." });
          return true;
        }
        await auth.clearFailures(email);
        const { token, expires } = await auth.startSession(user.id, req.headers["user-agent"]);
        sendJson(res, 200, { user: publicUser(user) }, { "Set-Cookie": auth.sessionCookie(token, expires, auth.isSecureRequest(req)) });
        return true;
      }
      return false;
    }
    async function api(req, res, url) {
      const p = url.pathname;
      const q = url.searchParams;
      if (p.startsWith("/api/auth/") && await publicApi(req, res, p)) return;
      const user = await auth.currentUser(req);
      if (!user) {
        if (req.method === "GET" && p === "/api/auth/me") return sendJson(res, 401, { error: "Belum masuk." });
        return sendJson(res, 401, { error: "Sesi berakhir. Masuk kembali untuk melanjutkan." });
      }
      if (req.method === "GET" && p === "/api/auth/me") return sendJson(res, 200, { user: publicUser(user) });
      if (req.method === "POST" && p === "/api/auth/logout") {
        await auth.endSession(auth.readCookie(req, "sid"));
        return sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookie(auth.isSecureRequest(req)) });
      }
      if (req.method === "POST" && p === "/api/auth/password") {
        const body = await readBody(req);
        const current = String(body.current_password || "");
        const next = String(body.new_password || "");
        const full = await db.findUserByEmail(user.email);
        if (!full || !auth.verifyPassword(current, full.password_hash)) {
          return sendJson(res, 401, { error: "Kata sandi saat ini salah." });
        }
        if (next.length < 8 || !/\d/.test(next)) {
          return sendJson(res, 400, { error: "Kata sandi baru minimal 8 karakter dan memuat satu angka." });
        }
        await db.setPassword(user.id, auth.hashPassword(next));
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && p === "/api/admin/users") {
        if (!isSuper(user)) return sendJson(res, 403, { error: "Hanya Super Admin." });
        return sendJson(res, 200, { users: await db.listAccounts(), roles: auth.ROLES });
      }
      if (req.method === "POST" && /^\/api\/admin\/users\/\d+\/role$/.test(p)) {
        if (!isSuper(user)) return sendJson(res, 403, { error: "Hanya Super Admin." });
        const id = Number(p.split("/")[4]);
        const body = await readBody(req);
        if (!auth.ROLES.includes(body.role)) return sendJson(res, 400, { error: "Peran tidak dikenal." });
        if (id === user.id && body.role !== "super_admin") {
          return sendJson(res, 400, { error: "Anda tidak dapat menurunkan peran akun Anda sendiri." });
        }
        const updated = await db.setUserRole(id, body.role);
        if (!updated) return sendJson(res, 404, { error: "Akun tidak ditemukan." });
        return sendJson(res, 200, { user: publicUser(updated) });
      }
      if (req.method === "POST" && /^\/api\/admin\/users\/\d+\/status$/.test(p)) {
        if (!isSuper(user)) return sendJson(res, 403, { error: "Hanya Super Admin." });
        const id = Number(p.split("/")[4]);
        const body = await readBody(req);
        const status = body.status === "active" ? "active" : "disabled";
        if (id === user.id) return sendJson(res, 400, { error: "Anda tidak dapat menonaktifkan akun Anda sendiri." });
        const updated = await db.setUserStatus(id, status);
        if (!updated) return sendJson(res, 404, { error: "Akun tidak ditemukan." });
        return sendJson(res, 200, { user: publicUser(updated) });
      }
      const STAFF_ONLY = [
        "/api/employees",
        "/api/overview",
        "/api/trend",
        "/api/gaps/employee",
        "/api/gaps/division",
        "/api/ai/recommendation",
        "/api/ai/quiz-topics",
        "/api/sql-agent"
      ];
      if ((STAFF_ONLY.includes(p) || p === "/api/recommendations" || /^\/api\/recommendations\/\d+/.test(p)) && !isStaff(user)) {
        return sendJson(res, 403, { error: "Peran Anda tidak memiliki akses ke data ini." });
      }
      if (req.method === "GET" && p === "/api/divisions") return sendJson(res, 200, await db.listDivisions());
      if (req.method === "GET" && p === "/api/topics") return sendJson(res, 200, await db.listTopics());
      if (req.method === "GET" && p === "/api/employees") return sendJson(res, 200, await db.listEmployees());
      if (req.method === "GET" && p === "/api/overview") return sendJson(res, 200, await db.overviewStats());
      if (req.method === "GET" && p === "/api/trend") {
        const divisionId = q.get("division") ? Number(q.get("division")) : null;
        const topicId = q.get("topic") ? Number(q.get("topic")) : null;
        const months = /^\d+$/.test(q.get("months") || "") ? Number(q.get("months")) : null;
        let overall = await db.scoreTrend({});
        let filtered = divisionId || topicId ? await db.scoreTrend({ divisionId, topicId }) : null;
        if (months && overall.length) {
          const latest = overall[overall.length - 1].month;
          const cutoff = monthMinus(latest, months - 1);
          overall = overall.filter((r) => r.month >= cutoff);
          if (filtered) filtered = filtered.filter((r) => r.month >= cutoff);
        }
        let label = "Keseluruhan";
        if (divisionId) label = (await db.listDivisions()).find((d) => d.id === divisionId)?.name || "Divisi";
        else if (topicId) label = (await db.listTopics()).find((t) => t.id === topicId)?.name || "Topik";
        return sendJson(res, 200, { overall, filtered, label, months, gapThreshold: db.GAP_THRESHOLD });
      }
      if (req.method === "GET" && p === "/api/config") {
        return sendJson(res, 200, {
          user: publicUser(user),
          model: ai.cfg().model,
          hasKey: !!ai.cfg().key,
          aiProvider: ai.cfg().providerLabel,
          gapThreshold: db.GAP_THRESHOLD,
          rag: await vec.stats(),
          quizUseReact: await db.getBool("quiz_use_react", true),
          quizUseRag: await db.getBool("quiz_use_rag", true)
        });
      }
      if (req.method === "GET" && p === "/api/settings") {
        return sendJson(res, 200, {
          quizUseReact: await db.getBool("quiz_use_react", true),
          quizUseRag: await db.getBool("quiz_use_rag", true),
          pdfLegalMode: await db.getBool("pdf_legal_mode", true),
          rag: await vec.stats()
        });
      }
      if (req.method === "POST" && p === "/api/settings") {
        if (!isSuper(user)) return sendJson(res, 403, { error: "Hanya Super Admin yang dapat mengubah pengaturan." });
        const body = await readBody(req);
        if ("quizUseReact" in body) await db.setSetting("quiz_use_react", body.quizUseReact ? "1" : "0");
        if ("quizUseRag" in body) await db.setSetting("quiz_use_rag", body.quizUseRag ? "1" : "0");
        if ("pdfLegalMode" in body) await db.setSetting("pdf_legal_mode", body.pdfLegalMode ? "1" : "0");
        return sendJson(res, 200, {
          quizUseReact: await db.getBool("quiz_use_react", true),
          quizUseRag: await db.getBool("quiz_use_rag", true),
          pdfLegalMode: await db.getBool("pdf_legal_mode", true)
        });
      }
      if (req.method === "GET" && p === "/api/settings/embed") {
        if (!isSuper(user)) return sendJson(res, 403, { error: "Hanya Super Admin." });
        const active = require_embedder().active();
        return sendJson(res, 200, {
          backend: "gemini",
          geminiModel: await db.getSetting("embed_gemini_model") || process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001",
          hasGeminiKey: !!(await db.getSetting("embed_gemini_key") || process.env.GEMINI_API_KEY),
          legalMode: await db.getBool("pdf_legal_mode", true),
          current: active ? { name: active.name, dim: active.dim, kind: active.kind } : null,
          rag: await vec.stats()
        });
      }
      if (req.method === "POST" && p === "/api/settings/embed") {
        if (!isSuper(user)) return sendJson(res, 403, { error: "Hanya Super Admin." });
        const body = await readBody(req);
        try {
          const embedder = require_embedder();
          await embedder.reconfigure({
            geminiKey: typeof body.geminiKey === "string" ? body.geminiKey : void 0,
            geminiModel: body.geminiModel
          });
          vec.resetEmbedder();
          if ("legalMode" in body) await db.setSetting("pdf_legal_mode", body.legalMode ? "1" : "0");
          const active = embedder.active();
          return sendJson(res, 200, {
            ok: true,
            current: active ? { name: active.name, dim: active.dim, kind: active.kind } : null,
            rag: await vec.stats()
          });
        } catch (e) {
          return sendJson(res, 500, { error: e.message });
        }
      }
      if (req.method === "GET" && p === "/api/pdf/documents") {
        return sendJson(res, 200, { documents: await vec.listDocuments(), rag: await vec.stats() });
      }
      if (req.method === "POST" && p === "/api/pdf/import") {
        if (!isSuper(user)) return sendJson(res, 403, { error: "Hanya Super Admin yang dapat mengunggah PDF." });
        let buf;
        try {
          buf = await readRawBody(req);
        } catch (e) {
          return sendJson(res, 413, { error: e.message });
        }
        const filename = decodeURIComponent(req.headers["x-filename"] || "document.pdf").replace(/[\r\n]/g, "");
        if (!buf || buf.length < 5 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
          return sendJson(res, 400, { error: "Berkas bukan PDF yang valid." });
        }
        try {
          const { text, numPages } = pdf.extractText(buf);
          if (!text || text.trim().length < 30) {
            return sendJson(res, 422, { error: "PDF tidak mengandung teks yang dapat diekstrak (kemungkinan hasil scan/gambar). Gunakan PDF berbasis teks." });
          }
          const title = filename.replace(/\.pdf$/i, "");
          const legalMode = await db.getBool("pdf_legal_mode", true);
          const doc = await vec.addDocument({ filename, title, text, numPages, bytes: buf.length, legalMode });
          return sendJson(res, 201, { document: doc, rag: await vec.stats() });
        } catch (e) {
          return sendJson(res, 500, { error: e.message });
        }
      }
      if (req.method === "DELETE" && /^\/api\/pdf\/documents\/\d+$/.test(p)) {
        if (!isSuper(user)) return sendJson(res, 403, { error: "Hanya Super Admin yang dapat menghapus dokumen." });
        const id = Number(p.split("/").pop());
        const ok = await vec.deleteDocument(id);
        if (!ok) return sendJson(res, 404, { error: "Dokumen tidak ditemukan." });
        return sendJson(res, 200, { deleted: id, rag: await vec.stats() });
      }
      if (req.method === "POST" && p === "/api/pdf/search") {
        if (!isSuper(user)) return sendJson(res, 403, { error: "Hanya Super Admin yang dapat menguji pencarian." });
        const body = await readBody(req);
        const query = (body.query || "").trim();
        if (!query) return sendJson(res, 400, { error: "Query kosong." });
        const results = await vec.search(query, Number(body.k) || 5);
        return sendJson(res, 200, { query, results, rag: await vec.stats() });
      }
      if (req.method === "GET" && p === "/api/gaps/employee") {
        const data = await db.employeeGaps(Number(q.get("id")));
        if (!data) return sendJson(res, 404, { error: "Employee not found" });
        return sendJson(res, 200, data);
      }
      if (req.method === "GET" && p === "/api/gaps/division") {
        const data = await db.divisionGaps(Number(q.get("id")));
        if (!data) return sendJson(res, 404, { error: "Division not found" });
        return sendJson(res, 200, data);
      }
      if (req.method === "POST" && p === "/api/ai/recommendation") {
        const body = await readBody(req);
        const gapData = await resolveGapData(body);
        if (!gapData) return sendJson(res, 400, { error: "scope/ref tidak valid" });
        try {
          const out = await ai.gapRecommendation(gapData);
          return sendJson(res, 200, { markdown: out.content, model: out.model, usage: out.usage, gapData });
        } catch (e) {
          return sendJson(res, 502, { error: e.message });
        }
      }
      if (req.method === "POST" && p === "/api/ai/quiz-topics") {
        const body = await readBody(req);
        const gapData = await resolveGapData(body);
        if (!gapData) return sendJson(res, 400, { error: "scope/ref tidak valid" });
        try {
          const topics = (await db.listTopics()).map((t) => t.name);
          const out = await ai.quizTopicRecommendation(gapData, topics);
          return sendJson(res, 200, { ...out.parsed, model: out.model, usage: out.usage, gapData });
        } catch (e) {
          return sendJson(res, 502, { error: e.message });
        }
      }
      if (req.method === "POST" && p === "/api/sql-agent") {
        if (!isSuper(user)) return sendJson(res, 403, { error: "Hanya Super Admin yang dapat menggunakan SQL Agent." });
        const body = await readBody(req);
        const question = (body.question || "").trim();
        if (!question) return sendJson(res, 400, { error: "Pertanyaan kosong." });
        try {
          const schema = db.schemaDescription();
          let gen = await ai.sqlAgent(question, schema, db.GAP_THRESHOLD);
          let rows = [];
          let runError = null;
          let repaired = false;
          try {
            rows = await db.runSelect(gen.sql);
          } catch (e) {
            runError = e.message;
          }
          if (runError) {
            try {
              const fix = await ai.repairSql(question, schema, gen.sql, runError, db.GAP_THRESHOLD);
              const fixedRows = await db.runSelect(fix.sql);
              gen = fix;
              rows = fixedRows;
              runError = null;
              repaired = true;
            } catch (e2) {
              runError = e2.message;
            }
          }
          return sendJson(res, 200, {
            sql: gen.sql,
            explanation: gen.explanation,
            model: gen.model,
            repaired,
            columns: rows.length ? Object.keys(rows[0]) : [],
            rows,
            rowCount: rows.length,
            runError
          });
        } catch (e) {
          return sendJson(res, 502, { error: e.message });
        }
      }
      if (req.method === "GET" && p === "/api/recommendations") {
        const status = q.get("status") || void 0;
        return sendJson(res, 200, await db.listRecommendations(status));
      }
      if (req.method === "POST" && p === "/api/recommendations") {
        if (user.role !== "super_admin" && user.role !== "auditor") {
          return sendJson(res, 403, { error: "Hanya Super Admin / Auditor yang dapat mengirim rekomendasi." });
        }
        const body = await readBody(req);
        if (!body.title || !body.scope_type || !body.scope_ref) {
          return sendJson(res, 400, { error: "title, scope_type, scope_ref wajib diisi." });
        }
        const rec = await db.createRecommendation({
          scope_type: body.scope_type,
          scope_ref: Number(body.scope_ref),
          scope_label: body.scope_label || "",
          title: body.title,
          gap_summary: body.gap_summary,
          recommendation: body.recommendation,
          recommended_topics: body.recommended_topics,
          model: body.model,
          created_by: user.name
        });
        return sendJson(res, 201, rec);
      }
      if (req.method === "POST" && /^\/api\/recommendations\/\d+\/acknowledge$/.test(p)) {
        if (user.role !== "director") return sendJson(res, 403, { error: "Hanya Direktur yang dapat acknowledge." });
        const id = Number(p.split("/")[3]);
        const body = await readBody(req);
        const rec = await db.acknowledgeRecommendation(id, user.name, body.ack_note);
        if (!rec) return sendJson(res, 404, { error: "Rekomendasi tidak ditemukan." });
        return sendJson(res, 200, rec);
      }
      if (req.method === "GET" && p === "/api/participant/curriculum") {
        const target = isStaff(user) && q.get("id") ? Number(q.get("id")) : user.id;
        const data = await db.participantCurriculum(target);
        if (!data) return sendJson(res, 404, { error: "Peserta tidak ditemukan." });
        return sendJson(res, 200, data);
      }
      if (req.method === "POST" && p === "/api/quiz/generate") {
        const body = await readBody(req);
        const employeeId = user.id;
        const topicId = Number(body.topic_id);
        const emp = await db.employeeById(employeeId);
        const topic = await db.topicById(topicId);
        if (!emp || !topic) return sendJson(res, 400, { error: "employee_id / topic_id tidak valid." });
        try {
          const useReact = await db.getBool("quiz_use_react", true);
          const useRag = await db.getBool("quiz_use_rag", true);
          const ragStats = await vec.stats();
          const ragOn = useRag && ragStats.chunks > 0;
          let questions = [];
          let model = "";
          let trace = null;
          let sources = null;
          for (let attempt = 0; attempt < 2 && questions.length < 10; attempt++) {
            if (useReact) {
              const gen = await ai.generateQuizReActPerQuestion(topic.name, topic.area, 12, {
                search: ragOn ? (query) => vec.search(query, 4) : null,
                hasKB: ragOn
              });
              model = gen.model;
              if (attempt === 0) {
                trace = gen.trace;
                sources = gen.sources;
              }
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
          const groundedCount = questions.filter((it) => it.grounded).length;
          const sessionId = await db.createQuizSession(employeeId, topicId, questions, model);
          const safe = questions.map((it, i) => ({
            i,
            question: it.question,
            options: it.options,
            grounded: !!it.grounded,
            source: it.source || null,
            similarity: it.similarity ?? null,
            excerpt: it.excerpt || null
          }));
          return sendJson(res, 200, {
            session_id: sessionId,
            topic: topic.name,
            area: topic.area,
            num_questions: safe.length,
            questions: safe,
            model,
            method: useReact ? "ReAct" : "direct",
            grounded: groundedCount > 0,
            groundedCount,
            trace,
            sources
          });
        } catch (e) {
          return sendJson(res, 502, { error: e.message });
        }
      }
      if (req.method === "POST" && p === "/api/quiz/submit") {
        const body = await readBody(req);
        const session = await db.getQuizSession(Number(body.session_id));
        if (!session) return sendJson(res, 404, { error: "Sesi kuis tidak ditemukan." });
        if (session.employee_id !== user.id) return sendJson(res, 403, { error: "Sesi kuis ini milik peserta lain." });
        if (session.status !== "open") return sendJson(res, 409, { error: "Sesi kuis sudah dikumpulkan." });
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
        const score = Math.round(correct / total * 100);
        const prev = await db.bestScoreForEmployee(session.employee_id, session.topic_id);
        const prevBest = prev.best;
        const improved = prevBest == null || score > prevBest;
        const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        if (improved) await db.recordAttempt(session.employee_id, session.topic_id, score, today);
        await db.closeQuizSession(session.id, score);
        const newBest = improved ? score : prevBest;
        const after = await db.bestScoreForEmployee(session.employee_id, session.topic_id);
        const topic = await db.topicById(session.topic_id);
        return sendJson(res, 200, {
          score,
          correct,
          total,
          results,
          topic: topic ? topic.name : "",
          prevBest,
          newBest,
          improved,
          attempts: after.attempts
        });
      }
      return sendJson(res, 404, { error: "Unknown endpoint" });
    }
    async function handle(req, res) {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      try {
        await api(req, res, url);
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: e.message });
      }
    }
    module.exports = { handle, api, sendJson, MAX_UPLOAD_BYTES };
  }
});

// functions-src/api-entry.mjs
var import_api = __toESM(require_api(), 1);
var import_pg = __toESM(require_pg(), 1);
import { Readable } from "node:stream";
import { neon } from "@neondatabase/serverless";
var WATCHDOG_MS = Number(process.env.FUNCTION_WATCHDOG_MS || 1e5);
import_pg.default.setNeonFactory(neon);
function loadRouter() {
  return import_api.default;
}
function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
function toNodeRequest(request, url, bodyBuffer) {
  const req = Readable.from(bodyBuffer && bodyBuffer.length ? [bodyBuffer] : []);
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.headers = Object.fromEntries(request.headers);
  if (typeof req.destroy !== "function") req.destroy = () => {
  };
  return req;
}
function makeNodeResponse(resolve) {
  const chunks = [];
  let status = 200;
  const headers = {};
  return {
    headersSent: false,
    statusCode: 200,
    setHeader(name, value) {
      headers[name] = value;
    },
    getHeader(name) {
      return headers[name];
    },
    removeHeader(name) {
      delete headers[name];
    },
    writeHead(code, extra) {
      status = code;
      this.statusCode = code;
      if (extra) for (const [k, v] of Object.entries(extra)) headers[k] = v;
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, { status, headers }));
    }
  };
}
async function onRequest(context) {
  const request = context && typeof context.method === "string" ? context : context?.request;
  if (!request) return json(500, { error: "Request tidak ditemukan pada context function." });
  try {
    const url = new URL(request.url);
    if (!(url.pathname === "/api" || url.pathname.startsWith("/api/"))) {
      url.pathname = "/api" + (url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`);
    }
    const hasBody = !["GET", "HEAD"].includes(request.method);
    const bodyBuffer = hasBody ? Buffer.from(await request.arrayBuffer()) : null;
    const router = loadRouter();
    const req = toNodeRequest(request, url, bodyBuffer);
    const handled = new Promise((resolve) => {
      const res = makeNodeResponse(resolve);
      router.handle(req, res);
    });
    let timer;
    const watchdog = new Promise((resolve) => {
      timer = setTimeout(() => resolve(json(504, {
        error: `Permintaan tidak selesai dalam ${Math.round(WATCHDOG_MS / 1e3)} detik.`,
        path: url.pathname,
        hint: "Cek DATABASE_URL (Neon) dan keterjangkauan jaringan dari function."
      })), WATCHDOG_MS);
    });
    const response = await Promise.race([handled, watchdog]);
    clearTimeout(timer);
    return response;
  } catch (e) {
    return json(500, { error: String(e && e.message || e), stack: String(e && e.stack || "").split("\n").slice(0, 4) });
  }
}
export {
  onRequest as default
};
