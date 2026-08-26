'use strict';
/**
 * Authentication for LLM Auditor — real accounts, no role-picker demo mode.
 *
 * Zero dependency: password hashing uses node:crypto scrypt, sessions are
 * opaque random tokens stored (hashed) in SQLite and carried in an HttpOnly
 * cookie. Registration always creates a Peserta Audit (role 'employee');
 * privileged roles are granted by a Super Admin.
 */
const crypto = require('node:crypto');
const db = require('./db');

const SESSION_TTL_DAYS = 7;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const ROLES = ['employee', 'auditor', 'director', 'super_admin'];
const STAFF_ROLES = ['auditor', 'director', 'super_admin'];

// --- password hashing -------------------------------------------------------
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(plain, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  } catch (_) { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// --- validation -------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Controls the registration form must satisfy — mirrored in the UI register. */
async function validateRegistration({ name, email, password, divisionId }) {
  const errors = [];
  if (!name || name.trim().length < 3) errors.push('Nama lengkap minimal 3 karakter.');
  if (!email || !EMAIL_RE.test(email.trim())) errors.push('Email tidak valid.');
  if (!password || password.length < 8) errors.push('Kata sandi minimal 8 karakter.');
  else if (!/\d/.test(password)) errors.push('Kata sandi harus memuat setidaknya satu angka.');
  if (!divisionId) errors.push('Pilih divisi Anda.');
  else if (!(await db.listDivisions()).some((d) => d.id === Number(divisionId))) errors.push('Divisi tidak dikenal.');
  return errors;
}

// --- login throttle (beralas tabel) -----------------------------------------
// Dulu sebuah Map in-memory. Di EdgeOne Cloud Functions tiap request bisa
// dilayani proses baru, sehingga Map akan selalu kosong dan proteksi
// brute-force praktis hilang. Hitungannya kini disimpan di tabel
// login_attempts; ambang perilakunya tidak berubah.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

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
  const now = new Date();
  await db.bumpLoginAttempt(
    email,
    now.toISOString(),
    new Date(now.getTime() - WINDOW_MS).toISOString()
  );
}
async function clearFailures(email) { await db.clearLoginAttempts(email); }

// --- sessions ---------------------------------------------------------------
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

async function startSession(employeeId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 86400000);
  await db.createSession({
    tokenHash: tokenHash(token),
    employeeId,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    userAgent: (userAgent || '').slice(0, 200),
  });
  return { token, expires };
}

async function endSession(token) {
  if (token) await db.deleteSession(tokenHash(token));
}

/** Resolve the signed-in user from the request cookie, or null. */
async function currentUser(req) {
  const token = readCookie(req, 'sid');
  if (!token) return null;
  const user = await db.sessionUser(tokenHash(token), new Date().toISOString());
  if (!user) return null;
  if (user.status && user.status !== 'active') return null;
  return user;
}

// --- cookies ----------------------------------------------------------------
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/**
 * Apakah request ini datang lewat HTTPS — penentu atribut `Secure`.
 *
 * Dibuat otomatis karena `Secure` tanpa syarat akan mematikan login di
 * http://localhost: browser menolak mengirim balik cookie-nya. Urutan:
 *   1. COOKIE_SECURE=1/0 di .env memaksa nilai (mis. di balik proxy tak lazim),
 *   2. header X-Forwarded-Proto dari reverse proxy (nginx/Caddy/Cloudflare),
 *   3. koneksi TLS langsung ke Node (https.createServer).
 * Header proxy yang dipalsukan hanya bisa membuat cookie ditandai Secure —
 * browser lalu menahannya di HTTP, jadi efeknya menolak diri sendiri, bukan
 * membuka celah.
 */
function isSecureRequest(req) {
  const override = String(process.env.COOKIE_SECURE || '').toLowerCase();
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto) return proto === 'https';
  return !!(req.socket && req.socket.encrypted);
}

/** Atribut yang harus identik antara set dan clear agar browser mau menghapus. */
function cookieAttrs(secure) {
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function sessionCookie(token, expires, secure = false) {
  const maxAge = Math.max(0, Math.floor((expires - Date.now()) / 1000));
  return `sid=${encodeURIComponent(token)}; ${cookieAttrs(secure)}; Max-Age=${maxAge}`;
}
function clearCookie(secure = false) {
  return `sid=; ${cookieAttrs(secure)}; Max-Age=0`;
}

// --- bootstrap --------------------------------------------------------------
/**
 * Give the seeded privileged accounts a usable password on first run so the
 * app is reachable out of the box. Existing passwords are never overwritten.
 * Override with SEED_PASSWORD in .env.
 */
async function bootstrap() {
  const seedPassword = process.env.SEED_PASSWORD || 'Auditor#2026';
  const pending = await db.staffWithoutPassword();
  if (!pending.length) return { seeded: [], seedPassword: null };
  const hash = hashPassword(seedPassword);
  for (const u of pending) await db.setPassword(u.id, hash);
  await db.purgeExpiredSessions(new Date().toISOString());
  return { seeded: pending.map((u) => u.email), seedPassword };
}

module.exports = {
  ROLES, STAFF_ROLES, SESSION_TTL_DAYS,
  hashPassword, verifyPassword, validateRegistration,
  throttled, noteFailure, clearFailures,
  startSession, endSession, currentUser,
  readCookie, sessionCookie, clearCookie, isSecureRequest,
  bootstrap,
};
