#!/usr/bin/env bash
# Update aplikasi di server: tarik commit terbaru, rebuild image, restart.
# Data (SQLite + indeks RAG) aman — tersimpan di volume auditor-data, tidak ikut rebuild.
#
#   cd /opt/llm-auditor/deploy/tencent && sudo ./update.sh
set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$(cd ../.. && pwd)"
COMPOSE="docker compose -f docker-compose.prod.yml"

[ -f .env ] || { echo "Gagal: .env belum ada di $(pwd). Salin dari env.production.example." >&2; exit 1; }

echo "==> Menarik perubahan dari git"
git -C "$APP_DIR" pull --ff-only

echo "==> Build ulang image + restart"
$COMPOSE up --build -d

echo "==> Membersihkan image lama"
docker image prune -f >/dev/null

echo "==> Menunggu health check"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PUBLIC_PORT:-80}/api/config" >/dev/null 2>&1; then
    echo "Aplikasi sehat."
    $COMPOSE ps
    exit 0
  fi
  sleep 2
done

echo "Aplikasi belum merespons setelah 60 detik. Log terakhir:" >&2
$COMPOSE logs --tail=40
exit 1
