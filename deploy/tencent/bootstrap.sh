#!/usr/bin/env bash
# LLM Auditor — penyiapan instance Tencent Cloud Lighthouse (Ubuntu 22.04/24.04 atau Debian 12).
#
# Jalankan SEKALI di server yang masih kosong, sebagai root:
#   curl -fsSL https://raw.githubusercontent.com/z3rg/LLM-Auditor/main/deploy/tencent/bootstrap.sh -o bootstrap.sh
#   sudo bash bootstrap.sh
#
# Yang dilakukan: pasang Docker + compose plugin, siapkan swap bila RAM kecil,
# clone repo ke /opt/llm-auditor, dan siapkan file .env untuk diisi.
# Skrip ini TIDAK menjalankan aplikasi — start dilakukan setelah .env terisi,
# karena SEED_PASSWORD hanya dibaca sekali saat database pertama kali dibuat.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/z3rg/LLM-Auditor.git}"
APP_DIR="${APP_DIR:-/opt/llm-auditor}"
DEPLOY_DIR="$APP_DIR/deploy/tencent"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mGagal: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "jalankan dengan sudo/root."

log "Memperbarui indeks paket"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

log "Memasang Docker + plugin compose"
if ! command -v docker >/dev/null 2>&1; then
  # Paket distro memakai mirror internal Tencent (mirrors.tencentyun.com) → cepat.
  apt-get install -y -qq docker.io docker-compose-v2 git curl ca-certificates \
    || die "instalasi docker via apt gagal"
else
  apt-get install -y -qq git curl ca-certificates >/dev/null
fi
# Sebagian image lawas tidak punya paket compose plugin; pasang manual bila perlu.
if ! docker compose version >/dev/null 2>&1; then
  log "Plugin compose belum ada — memasang dari GitHub"
  ARCH="$(uname -m)"; case "$ARCH" in x86_64) ARCH=x86_64 ;; aarch64) ARCH=aarch64 ;; esac
  mkdir -p /usr/lib/docker/cli-plugins
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}" \
    -o /usr/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/lib/docker/cli-plugins/docker-compose
fi
systemctl enable --now docker
docker compose version >/dev/null 2>&1 || die "docker compose masih tidak tersedia."

# Agar user login (ubuntu/lighthouse) bisa pakai docker tanpa sudo.
for u in ubuntu lighthouse debian; do
  id "$u" >/dev/null 2>&1 && usermod -aG docker "$u" && log "User '$u' ditambahkan ke grup docker (login ulang agar berlaku)"
done

# Instance 1 GB cukup untuk runtime, tapi build image lebih aman dengan swap.
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
if [ "$MEM_MB" -lt 2048 ] && [ ! -f /swapfile ]; then
  log "RAM ${MEM_MB} MB — membuat swap 2 GB"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Mengambil kode aplikasi ke $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

if [ ! -f "$DEPLOY_DIR/.env" ]; then
  cp "$DEPLOY_DIR/env.production.example" "$DEPLOY_DIR/.env"
  chmod 600 "$DEPLOY_DIR/.env"
  log "Template .env disalin ke $DEPLOY_DIR/.env"
else
  log ".env sudah ada — dibiarkan apa adanya"
fi

log "Penyiapan selesai."
cat <<EOF

Langkah berikutnya:
  1. Isi DATABASE_URL (Neon), kunci API, dan SEED_PASSWORD:
       sudo nano $DEPLOY_DIR/.env
     (SEED_PASSWORD hanya dibaca saat database pertama kali disiapkan - isi SEKARANG.)

  2. Siapkan skema database sekali saja, dari mesin mana pun:
       DATABASE_URL='postgresql://...' npm run db:setup

  3. Build & jalankan:
       cd $DEPLOY_DIR && sudo docker compose -f docker-compose.prod.yml up --build -d

  4. Buka port 80 di firewall Lighthouse (konsol Tencent Cloud), lalu cek:
       curl -s http://127.0.0.1/api/config

EOF
