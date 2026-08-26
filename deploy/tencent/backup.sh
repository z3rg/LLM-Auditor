#!/usr/bin/env bash
# Backup database LLM Auditor (Postgres/Neon) ke berkas .sql.gz.
#
# Sejak port ke Postgres, instance aplikasi tidak menyimpan state apa pun —
# tidak ada lagi yang perlu di-backup dari kontainer. Yang dicadangkan adalah
# databasenya, dan itu bisa dijalankan dari mana saja, termasuk laptop.
#
#   DATABASE_URL='postgresql://…' ./backup.sh
#   crontab -e  →  17 2 * * * DATABASE_URL='…' /opt/llm-auditor/deploy/tencent/backup.sh >> /var/log/auditor-backup.log 2>&1
#
# Catatan: Neon sudah punya point-in-time restore dan branching bawaan. Skrip
# ini untuk salinan yang Anda pegang sendiri, di luar Neon.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/llm-auditor}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -n "${DATABASE_URL:-}" ] || { echo "Gagal: DATABASE_URL belum disetel." >&2; exit 1; }
command -v pg_dump >/dev/null 2>&1 || {
  echo "Gagal: pg_dump tidak ditemukan. Pasang klien Postgres:" >&2
  echo "  Debian/Ubuntu : sudo apt-get install -y postgresql-client" >&2
  echo "  macOS         : brew install libpq" >&2
  exit 1
}

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/auditor-$STAMP.sql.gz"

echo "==> Membuat dump ke $OUT"
# --no-owner/--no-acl: dump bisa dipulihkan ke database mana pun, termasuk
# branch Neon baru yang pemiliknya berbeda.
pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip > "$OUT"

echo "==> Menghapus backup lebih tua dari $KEEP_DAYS hari"
find "$BACKUP_DIR" -name 'auditor-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

ls -lh "$OUT"
echo
echo "Pulihkan dengan:"
echo "  gunzip -c $OUT | psql \"\$DATABASE_URL_TUJUAN\""
