#!/usr/bin/env bash
#
# start.sh — menjalankan aplikasi LLM Auditor sepenuhnya.
#
# Penggunaan:
#   ./start.sh              jalankan aplikasi (siapkan .env bila perlu, lalu start server)
#   ./start.sh --reseed     reset/isi ulang data dummy sebelum start
#   ./start.sh --no-open    jangan buka browser otomatis
#   ./start.sh --check      hanya pra-pemeriksaan (tidak menjalankan server)
#   ./start.sh --help       tampilkan bantuan
#
set -euo pipefail

# Selalu bekerja dari folder skrip ini (nama folder boleh mengandung spasi).
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- argumen ----------------------------------------------------------------
DO_RESEED=0
OPEN_BROWSER=1
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --reseed)   DO_RESEED=1 ;;
    --no-open)  OPEN_BROWSER=0 ;;
    --check)    CHECK_ONLY=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '2,11p'
      exit 0 ;;
    *) echo "Argumen tidak dikenal: $arg (coba --help)"; exit 1 ;;
  esac
done

# --- helper output ----------------------------------------------------------
c_reset='\033[0m'; c_blue='\033[1;34m'; c_green='\033[1;32m'; c_yellow='\033[1;33m'; c_red='\033[1;31m'
info()  { printf "${c_blue}▶${c_reset} %s\n" "$1"; }
ok()    { printf "${c_green}✓${c_reset} %s\n" "$1"; }
warn()  { printf "${c_yellow}!${c_reset} %s\n" "$1"; }
err()   { printf "${c_red}✗${c_reset} %s\n" "$1" >&2; }

printf "\n${c_blue}╭───────────────────────────────────────────────╮${c_reset}\n"
printf   "${c_blue}│${c_reset}   LLM Auditor — IT Audit Quiz Analytics        ${c_blue}│${c_reset}\n"
printf   "${c_blue}╰───────────────────────────────────────────────╯${c_reset}\n\n"

# --- 1. Node.js tersedia & versi cukup ---------------------------------------
if ! command -v node >/dev/null 2>&1; then
  err "Node.js tidak ditemukan. Install Node.js >= 20 dari https://nodejs.org"
  exit 1
fi
NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_REST="${NODE_VER#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js $NODE_VER terlalu lama. Butuh >= 20 (versi runtime EdgeOne Cloud Functions)."
  exit 1
fi
ok "Node.js $NODE_VER"

# --- 2. Siapkan .env --------------------------------------------------------
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    warn ".env belum ada — disalin dari .env.example. Isi MAKERS_MODELS_KEY dan BLOB_LOCAL_DIR Anda."
  else
    err ".env dan .env.example tidak ada. Tidak bisa lanjut."
    exit 1
  fi
else
  ok ".env ditemukan"
fi

# Baca nilai dari .env (tanpa dependency tambahan): strip CR & tanda kutip.
read_env() { sed -n "s/^$1=//p" .env | head -1 | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
PORT="$(read_env PORT)"; PORT="${PORT:-3000}"
API_KEY="$(read_env MAKERS_MODELS_KEY)"
if [ -z "$API_KEY" ] || [ "$API_KEY" = "your_groq_api_key_here" ]; then
  warn "Kunci LLM belum diisi di .env — fitur AI (rekomendasi, SQL Agent, kuis) tidak akan jalan."
  warn "Ambil MAKERS_MODELS_KEY di konsol Makers → Models → API Key."
else
  ok "Kunci LLM terpasang"
fi

BLOB_DIR="$(read_env BLOB_LOCAL_DIR)"
BLOB_PROJECT="$(read_env EDGEONE_PROJECT_ID)"
if [ -z "$BLOB_DIR" ] && [ -z "$BLOB_PROJECT" ]; then
  err "Backend penyimpanan belum dipilih di .env."
  err "Dev lokal : BLOB_LOCAL_DIR=./.blob-data"
  err "Blob asli : EDGEONE_PROJECT_ID + EDGEONE_BLOB_TOKEN (konsol Makers → Project Settings → API Token)"
  exit 1
fi
ok "Penyimpanan terpasang"

# --- 3. Dependency & penyiapan database -------------------------------------
if [ ! -d node_modules ]; then
  info "Memasang dependency (SDK EdgeOne Blob)…"
  npm install --no-audit --no-fund || { err "npm install gagal."; exit 1; }
fi
ok "Dependency siap"

if [ "$DO_RESEED" -eq 1 ]; then
  info "Mereset & mengisi ulang data dummy…"
  node scripts/seed_blob.js --reseed || { err "Reseed gagal."; exit 1; }
  ok "Data dummy diisi ulang"
fi

# --- 4. Cek port belum dipakai ---------------------------------------------
if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  warn "Port $PORT sudah dipakai proses lain. Hentikan dulu, atau ubah PORT di .env."
  if [ "$CHECK_ONLY" -eq 0 ]; then exit 1; fi
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf "\n"; ok "Pra-pemeriksaan selesai. Jalankan ./start.sh untuk memulai."
  exit 0
fi

# --- 5. Buka browser (best-effort) setelah server siap ----------------------
URL="http://localhost:$PORT"
if [ "$OPEN_BROWSER" -eq 1 ]; then
  ( for _ in $(seq 1 40); do
      if command -v curl >/dev/null 2>&1 && curl -fs -o /dev/null "$URL/api/config" 2>/dev/null; then break; fi
      sleep 0.25
    done
    if command -v open >/dev/null 2>&1; then open "$URL"        # macOS
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" # Linux
    fi ) >/dev/null 2>&1 &
fi

# --- 6. Jalankan server (foreground; Ctrl+C untuk berhenti) -----------------
printf "\n${c_blue}▶${c_reset} Server berjalan di ${c_green}%s${c_reset}\n" "$URL"
printf "${c_blue}▶${c_reset} Tekan Ctrl+C untuk berhenti.\n\n"
exec node server.js
