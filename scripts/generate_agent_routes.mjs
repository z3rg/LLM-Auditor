/**
 * Hasilkan berkas rute agents/api/** dari satu daftar endpoint.
 *
 * Meniru scripts/generate-dsh-api-routes.mjs pada template deepseek-harness:
 * seluruh logika ada di satu modul privat (agents/_api.mjs), dan tiap endpoint
 * hanya butuh berkas tipis yang meneruskan context ke sana. Routing EdgeOne
 * Makers berbasis berkas, jadi daftar di bawah HARUS sejalan dengan path yang
 * dicocokkan lib/api.js — kalau menambah endpoint di sana, tambahkan di sini
 * lalu jalankan `npm run agents:routes`.
 *
 * Konvensi berkas:
 *   · 'config'                    -> agents/api/config.js
 *   · 'settings' + 'settings/*'   -> agents/api/settings/index.js (path yang
 *     juga menjadi awalan path lain tidak bisa jadi berkas DAN direktori)
 *   · '[id]'                      -> segmen dinamis; resolver EdgeOne
 *     menerjemahkannya jadi '/:id'. Nilainya tidak dipakai di sini karena
 *     lib/api.js membaca ulang path lengkapnya sendiri.
 *
 * Ekstensi .js (BUKAN .mjs) disengaja: resolver rute EdgeOne memotong ekstensi
 * berkas dengan pola yang tidak selalu memuat 'mjs', sehingga berkas .mjs bisa
 * terdaftar sebagai '/api/config.mjs'. agents/package.json menandai folder ini
 * "type": "module" supaya .js tetap diurai sebagai ESM, sementara lib/ di luar
 * folder ini tetap CommonJS.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = fileURLToPath(new URL('../agents/api/', import.meta.url));

// Daftar endpoint, relatif terhadap /api. Method tidak perlu dipisah: satu
// berkas mengekspor onRequest untuk semua method, dan lib/api.js sendiri yang
// mencocokkan req.method.
const routes = [
  // Akun & sesi
  'auth/divisions',
  'auth/register',
  'auth/login',
  'auth/me',
  'auth/logout',
  'auth/password',
  // Administrasi pengguna
  'admin/users',
  'admin/users/[id]/role',
  'admin/users/[id]/status',
  // Data referensi & ringkasan
  'divisions',
  'topics',
  'employees',
  'overview',
  'trend',
  'config',
  // Pengaturan
  'settings',
  // Analisis gap
  'gaps/employee',
  'gaps/division',
  // Fitur AI
  'ai/recommendation',
  'ai/quiz-topics',
  // Rekomendasi & acknowledgement
  'recommendations',
  'recommendations/[id]/acknowledge',
  // Peserta & kuis
  'participant/curriculum',
  'quiz/generate',
  'quiz/submit',
];

/** Path yang juga menjadi awalan path lain harus ditulis sebagai index.mjs. */
function targetFor(route) {
  const isPrefix = routes.some((other) => other !== route && other.startsWith(`${route}/`));
  return isPrefix ? `${route}/index.js` : `${route}.js`;
}

function sourceFor(relativeTarget) {
  const depth = relativeTarget.split('/').length; // agents/api/<...>
  const bridge = `${'../'.repeat(depth)}_api.js`;
  return [
    '// Dihasilkan oleh scripts/generate_agent_routes.mjs — jangan disunting tangan.',
    `import { handleApi } from ${JSON.stringify(bridge)};`,
    '',
    'export async function onRequest(context) {',
    '  return handleApi(context);',
    '}',
    '',
    'export default onRequest;',
    '',
  ].join('\n');
}

// Bangun ulang dari nol supaya endpoint yang dihapus dari daftar tidak
// meninggalkan rute yatim yang masih terdeploy.
await rm(apiDir, { recursive: true, force: true });
await mkdir(apiDir, { recursive: true });

for (const route of routes) {
  const relativeTarget = targetFor(route);
  const file = path.join(apiDir, relativeTarget);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, sourceFor(relativeTarget));
}

console.log(`Menulis ${routes.length} rute agent ke agents/api/.`);
