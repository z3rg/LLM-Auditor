#!/usr/bin/env bash
# Bundle cloud function jadi satu artefak mandiri.
#
# Kenapa tidak menyerahkannya ke builder EdgeOne: bundler platform menyerah pada
# graf modul lib/ dan meninggalkan import sebagai require runtime, yang lalu
# MODULE_NOT_FOUND di /var/user/index.mjs. Dengan mem-bundle sendiri, artefak
# yang dideploy tidak punya import relatif sama sekali dan bisa diuji lokal.
#
# Artefaknya SENGAJA di-commit supaya deploy tidak bergantung pada build step
# platform. Jalankan ulang setiap kali lib/ atau functions-src/ berubah.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT='cloud-functions/api/[[default]].js'

# Dua hal yang harus disuntik ke output ESM:
#  · __dirname/__filename — tidak ada di ESM, tapi disentuh lib/env.js & lib/db.js.
#  · require() — modul CJS di dalam bundle memanggil require('node:fs') dsb.
#    Tanpa shim ini esbuild melemparnya sebagai "Dynamic require ... is not
#    supported"; dengan `require` terdefinisi, helper esbuild memakainya.
#    Sengaja dipasang di globalThis, BUKAN sebagai `const require` top-level:
#    deklarasi top-level bisa bentrok dengan pembungkus milik builder platform,
#    dan kecurigaan itulah yang sedang diuji lewat salinan p6.js di bawah.
BANNER='import{fileURLToPath as __f}from"node:url";import{dirname as __d}from"node:path";import{createRequire as __cr}from"node:module";const __filename=__f(import.meta.url);const __dirname=__d(__filename);if(!globalThis.require)globalThis.require=__cr(import.meta.url);'

# --minify bukan sekadar penghematan byte: probe p7/p8 (336 KB berisi komentar)
# lolos sementara artefak 107 KB berisi kode nyata ditolak, jadi yang dibatasi
# builder tampaknya volume kode — bukan ukuran berkas.
#
# Driver Neon dibiarkan EXTERNAL: entry meng-import-nya sebagai import ESM asli
# sehingga bundler platform yang meresolusinya. Saat driver ini di-inline,
# artefaknya ditolak builder (rute tidak pernah terdaftar, 404).
npx esbuild functions-src/api-entry.mjs \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node20 \
  --minify \
  --external:@neondatabase/serverless \
  --banner:js="$BANNER" \
  --outfile="$OUT" \
  --log-level=warning

# Probe ukuran. Handler sepele + padding sampai ~320 KB — sebesar artefak yang
# ditolak builder saat driver Neon masih di-inline. Kalau /api/p7 hidup, ukuran
# bukan penyebabnya dan yang bermasalah adalah ISI bundle. Hapus setelah terjawab.
{
  printf '/** Probe ukuran: handler sepele + padding. */\n'
  printf 'export default function onRequest(){return new Response(JSON.stringify({ok:true,probe:"p7-ukuran",bytes:%s}),{headers:{"Content-Type":"application/json"}});}\n' "$(wc -c < "$OUT" | tr -d ' ')"
  printf '// padding:\n'
  yes '// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' 2>/dev/null | head -4200
} > cloud-functions/api/p7.js

# p8/p9 dibuat manual sekali (lihat riwayat commit) dan tidak di-regenerate di sini.
printf '  Artefak: %s (%s)\n' "$OUT" "$(du -h "$OUT" | cut -f1)"
printf '  Probe ukuran: cloud-functions/api/p7.js (%s)\n' "$(du -h cloud-functions/api/p7.js | cut -f1)"
printf '  Modul eksternal tersisa: %s\n' "$(grep -oE "from ?\"[^\"]+\"" "$OUT" | grep -v '"node:' | sort -u | tr '\n' ' ')"</dev/null
