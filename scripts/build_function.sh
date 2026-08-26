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

# Driver Neon ikut di-inline (tanpa --external) supaya artefak tidak bergantung
# pada resolusi node_modules di /var/user — satu-satunya sisa ketergantungan
# adalah modul bawaan Node.
npx esbuild functions-src/api-entry.mjs \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node20 \
  --banner:js="$BANNER" \
  --outfile="$OUT" \
  --log-level=warning

# Salinan identik dengan nama berkas BIASA. Eksperimen pemisah: kalau /api/p6
# hidup sementara /api/config 404, masalahnya pada pendaftaran rute catch-all
# `[[default]].js`, bukan pada isi bundle. Hapus setelah terjawab.
cp "$OUT" cloud-functions/api/p6.js

printf '  Artefak: %s (%s)\n' "$OUT" "$(du -h "$OUT" | cut -f1)"
printf '  Salinan uji: cloud-functions/api/p6.js\n'
printf '  Modul eksternal tersisa: %s\n' "$(grep -oE "from ?\"[^\"]+\"" "$OUT" | grep -v '"node:' | sort -u | tr '\n' ' ')"</dev/null
