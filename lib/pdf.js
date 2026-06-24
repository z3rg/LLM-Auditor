'use strict';
/**
 * Minimal, zero-dependency PDF text extractor.
 * Cukup untuk PDF berbasis-teks: men-decode stream `FlateDecode` dengan
 * `node:zlib`, lalu menarik teks dari operator PDF (Tj/TJ di dalam BT...ET).
 * PDF hasil scan/gambar (tanpa layer teks) tidak akan menghasilkan teks —
 * pemanggil harus menangani hasil kosong.
 */
const zlib = require('node:zlib');

/** Baca satu string literal PDF "( ... )" mulai dari kurung buka di index i.
 *  Mengembalikan [teksTerdekode, indexSetelahKurungTutup]. */
function readLiteral(s, i) {
  let depth = 0, out = '', j = i + 1; // lewati '('
  const oct = (str) => (str.match(/^[0-7]{1,3}/) || [''])[0];
  for (; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\') {
      const nx = s[j + 1];
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (nx in map) { out += map[nx]; j++; continue; }
      const o = oct(s.slice(j + 1, j + 4));
      if (o) { out += String.fromCharCode(parseInt(o, 8) & 0xff); j += o.length; continue; }
      if (nx === '\n') { j++; continue; }            // line continuation
      if (nx === '\r') { j += (s[j + 2] === '\n' ? 2 : 1); continue; }
      out += nx; j++; continue;
    }
    if (ch === '(') { depth++; out += ch; continue; }
    if (ch === ')') { if (depth === 0) { j++; break; } depth--; out += ch; continue; }
    out += ch;
  }
  return [out, j];
}

/** Baca string hex PDF "< ... >" mulai dari index i. */
function readHex(s, i) {
  let j = i + 1, hex = '';
  for (; j < s.length && s[j] !== '>'; j++) if (/[0-9a-fA-F]/.test(s[j])) hex += s[j];
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16) & 0xff);
  return [out, j + 1];
}

/** Tarik teks dari satu blok konten PDF (operator show + posisi).
 *
 * Penting untuk dokumen hukum: baris BARU hanya diemit saat ada perpindahan
 * VERTIKAL (Td/TD dengan ty≠0, T*, Tm dgn Y berubah, operator '/"). Td/TD
 * horizontal (ty=0) hanya menggeser dalam baris yang sama → spasi, bukan newline.
 * Tanpa ini, generator PDF yang memosisikan tiap kata via Td memecah satu baris
 * menjadi banyak baris (mis. "Pasal" dan "5" terpisah), merusak parser hierarki.
 */
function readNumber(s, i, n) { let j = i + 1; while (j < n && /[0-9.eE+\-]/.test(s[j])) j++; return [parseFloat(s.slice(i, j)), j]; }

function parseTextBlock(s, state = { lastY: null }) {
  let out = '', i = 0;
  const n = s.length;
  let nums = [];       // operand numerik yang menunggu operator berikutnya
  const TJ_SPACE = -200; // ambang penyesuaian TJ yang dianggap spasi antar-kata

  while (i < n) {
    const c = s[i];

    // String literal / hex → teks yang ditampilkan
    if (c === '(') { const [str, ni] = readLiteral(s, i); out += str; nums = []; i = ni; continue; }
    if (c === '<' && s[i + 1] !== '<') { const [str, ni] = readHex(s, i); out += str; nums = []; i = ni; continue; }

    // Array TJ: [ (str) angka (str) … ] TJ — angka sangat negatif = spasi antar-kata
    if (c === '[') {
      i++;
      while (i < n && s[i] !== ']') {
        const ch = s[i];
        if (ch === '(') { const [str, ni] = readLiteral(s, i); out += str; i = ni; continue; }
        if (ch === '<' && s[i + 1] !== '<') { const [str, ni] = readHex(s, i); out += str; i = ni; continue; }
        if (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) { const [v, ni] = readNumber(s, i, n); if (v <= TJ_SPACE) out += ' '; i = ni; continue; }
        i++;
      }
      i++; // lewati ']'
      while (i < n && /\s/.test(s[i])) i++;
      if (s[i] === 'T' && (s[i + 1] === 'J' || s[i + 1] === 'j')) i += 2;
      nums = []; continue;
    }

    // Operand numerik (dikumpulkan untuk operator setelahnya)
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) { const [v, ni] = readNumber(s, i, n); if (!Number.isNaN(v)) nums.push(v); i = ni; continue; }

    // Operator teks/posisi
    if (c === 'T') {
      const op = s[i + 1];
      if (op === '*') { out += '\n'; i += 2; nums = []; continue; }                                   // pindah baris
      if (op === 'd' || op === 'D') { const ty = nums.length ? nums[nums.length - 1] : 0; out += Math.abs(ty) > 0.01 ? '\n' : ' '; i += 2; nums = []; continue; }
      if (op === 'm') { const f = nums.length ? nums[nums.length - 1] : null; if (f !== null && state.lastY !== null && Math.abs(f - state.lastY) > 0.01) out += '\n'; if (f !== null) state.lastY = f; i += 2; nums = []; continue; }
      i += 2; nums = []; continue;                                                                     // Tj/TJ/Tf/Tc/… (teks sudah diemit di atas)
    }
    if (c === "'" || c === '"') { out += '\n'; i++; nums = []; continue; }                             // tampilkan di baris baru

    // Token operator lain (q/Q/cm/re/…): lewati & buang operand tertunda
    if (/[A-Za-z]/.test(c)) { let j = i + 1; while (j < n && /[A-Za-z0-9*]/.test(s[j])) j++; i = j; nums = []; continue; }
    i++;
  }
  return out;
}

function extractFromContent(s) {
  let result = '', blocks = 0, m;
  const btRe = /BT([\s\S]*?)ET/g;
  // State posisi Y dibagi LINTAS blok BT/ET: banyak generator membungkus tiap
  // kata dalam BT…ET sendiri. Jika dipaksa newline tiap blok, satu baris pecah
  // jadi banyak baris. Dengan melacak Y (via Tm), blok pada baris yang sama
  // disambung spasi; baris baru hanya saat Y berpindah.
  const state = { lastY: null };
  while ((m = btRe.exec(s))) { blocks++; result += parseTextBlock(m[1], state) + ' '; }
  if (blocks === 0) result = parseTextBlock(s, state); // tanpa BT/ET — pindai utuh
  return result;
}

function normalize(t) {
  return t
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // buang kontrol (sisakan \t \n \r)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Ekstrak teks dari buffer PDF.
 * @returns {{text:string, numPages:number|null}}
 */
function extractText(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const raw = bytes.toString('latin1'); // 1 byte = 1 char code
  const parts = [];
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    // dict objek sebelum kata 'stream' menentukan filter kompresi
    const dictStart = raw.lastIndexOf('<<', m.index);
    const dict = dictStart >= 0 ? raw.slice(dictStart, m.index) : '';
    let e = end;
    while (e > start && (bytes[e - 1] === 0x0a || bytes[e - 1] === 0x0d)) e--; // buang EOL sebelum endstream
    const data = bytes.subarray(start, e);
    let text = null;
    if (/FlateDecode/.test(dict)) {
      try { text = zlib.inflateSync(data).toString('latin1'); }
      catch (_) { try { text = zlib.inflateRawSync(data).toString('latin1'); } catch (__) { text = null; } }
    } else if (!/\/Filter/.test(dict)) {
      text = data.toString('latin1'); // stream tak terkompresi
    }
    if (text) parts.push(text);
    streamRe.lastIndex = end + 9;
  }

  let out = extractFromContent(parts.join('\n'));
  if (!out.trim()) out = extractFromContent(raw); // fallback PDF tak-terkompresi penuh
  const numPages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length || null;
  return { text: normalize(out), numPages };
}

module.exports = { extractText };
