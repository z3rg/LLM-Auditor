'use strict';
/**
 * Backend Blob lokal berbasis berkas — HANYA untuk dev & pengujian.
 *
 * Kredensial Pages Blob disuntik platform saat build, jadi di luar EdgeOne
 * SDK-nya tidak bisa dipakai tanpa projectId + API token. Tanpa pengganti
 * lokal, `npm start` dan seluruh uji regresi jadi mustahil dijalankan — itu
 * alasan berkas ini ada, bukan untuk dipakai di produksi.
 *
 * Mengimplementasikan HANYA bagian permukaan Store yang dipakai lib/blob.js,
 * dengan semantik yang sama pada hal yang menentukan kebenaran:
 *   · setJSON(..., { onlyIfNew }) menolak menimpa kunci yang sudah ada, dan
 *     melempar galat ber-code PRECONDITION_FAILED seperti SDK asli.
 *   · get() mengembalikan null untuk kunci yang tidak ada, bukan melempar.
 *   · list({ prefix }) mengembalikan { blobs: [{ key }] }.
 * `consistency` diabaikan: berkas lokal selalu read-after-write.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

class PreconditionFailed extends Error {
  constructor() {
    super('conditional write failed (key already exists)');
    this.code = 'PRECONDITION_FAILED';
  }
}

/** Kunci -> path berkas, ditahan agar tidak keluar dari direktori root. */
function toPath(root, key) {
  const clean = String(key).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..');
  const p = path.join(root, ...clean);
  if (!p.startsWith(root)) throw new Error(`Kunci blob tidak valid: ${key}`);
  return p;
}

/** Seluruh berkas di bawah dir, sebagai kunci relatif bergaya posix. */
async function walk(root, dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

class LocalStore {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  async get(key, options = {}) {
    let raw;
    try { raw = await fsp.readFile(toPath(this.root, key), 'utf8'); } catch (_) { return null; }
    if (options.type === 'json') {
      try { return JSON.parse(raw); } catch (_) { return null; }
    }
    return raw;
  }

  async set(key, value, options = {}) {
    const file = toPath(this.root, key);
    if (options.onlyIfNew && fs.existsSync(file)) throw new PreconditionFailed();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, typeof value === 'string' ? value : Buffer.from(value));
  }

  async setJSON(key, value, options = {}) {
    return this.set(key, JSON.stringify(value), options);
  }

  async getMetadata(key) {
    try {
      const st = await fsp.stat(toPath(this.root, key));
      return { contentType: 'application/json', etag: String(st.mtimeMs) };
    } catch (_) { return null; }
  }

  async delete(key) {
    try { await fsp.unlink(toPath(this.root, key)); } catch (_) { /* sudah tidak ada */ }
  }

  async list(options = {}) {
    const prefix = options.prefix || '';
    const keys = (await walk(this.root, this.root)).filter((k) => k.startsWith(prefix)).sort();
    return { blobs: keys.map((key) => ({ key, etag: '' })), directories: [] };
  }
}

module.exports = { LocalStore, PreconditionFailed };
