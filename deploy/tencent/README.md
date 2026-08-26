# Deploy LLM Auditor ke Tencent Cloud Lighthouse

Panduan menjalankan aplikasi di **Tencent Cloud Lightweight Application Server (Lighthouse)**
region **Jakarta atau Singapore**, satu kontainer Docker, akses lewat `http://<IP-INSTANCE>`.

> **Kenapa bukan region daratan Tiongkok?** Aplikasi memanggil `api.groq.com` dan
> `generativelanguage.googleapis.com` saat runtime. Dari region Guangzhou/Shanghai/Beijing
> kedua host itu tidak terjangkau, dan domain yang diarahkan ke sana wajib ICP filing.
> Jakarta/Singapore/Hong Kong bebas dari keduanya.

---

## Isi folder ini

| Berkas | Fungsi |
|--------|--------|
| `docker-compose.prod.yml` | Definisi service produksi (port 80, batas log, stateless) |
| `env.production.example` | Template `.env` untuk diisi di server |
| `bootstrap.sh` | Penyiapan sekali jalan di instance baru (Docker, swap, clone repo) |
| `update.sh` | Tarik commit terbaru → rebuild → restart, dengan health check |
| `backup.sh` | `pg_dump` database Neon ke `.sql.gz` + rotasi 14 hari |

---

## Prasyarat

- Akun **Tencent Cloud International** (<https://intl.cloud.tencent.com>) yang sudah terverifikasi.
- **DATABASE_URL** — database Postgres + pgvector di <https://neon.tech> (gratis). Aplikasi
  menyimpan seluruh state di sana; instance ini stateless.
- **GROQ_API_KEY** — <https://console.groq.com/keys>
- **GEMINI_API_KEY** — <https://aistudio.google.com/apikey>
- Kunci SSH publik Anda. Yang ada di mesin ini: `~/.ssh/id_ed25519.pub`.
- Folder `deploy/` ini sudah ter-*push* ke GitHub (`z3rg/LLM-Auditor`), karena `bootstrap.sh`
  meng-*clone* repo dari sana.

---

## 1. Buat instance Lighthouse

Konsol → **Lightweight Application Server** → **Create**:

| Pengaturan | Pilihan |
|------------|---------|
| Region | **Jakarta** (latensi terbaik dari Indonesia) atau **Singapore** |
| Image | **OS** → Ubuntu 24.04 LTS (bukan image aplikasi) |
| Paket | minimal **2 vCPU / 2 GB RAM / 40 GB SSD**. 1 GB masih jalan, tapi build image berat — `bootstrap.sh` otomatis menambah swap 2 GB |
| Kuota trafik | paket termurah pun biasanya cukup; RAG/LLM keluar-masuknya teks, bukan media |
| Login | **SSH key pair** — unggah isi `~/.ssh/id_ed25519.pub`, jangan pakai password |

Setelah instance dibuat, catat **Public IP**-nya.

## 2. Buka firewall

Tab **Firewall** pada instance:

| Protokol | Port | Sumber |
|----------|------|--------|
| TCP | 22 | **IP Anda saja** (`x.x.x.x/32`) — jangan `0.0.0.0/0` |
| TCP | 80 | `0.0.0.0/0` |

Port 3000 tidak perlu dibuka: kontainer dipetakan ke port 80 di host.

## 3. Siapkan server

```bash
ssh ubuntu@<IP-INSTANCE>

curl -fsSL https://raw.githubusercontent.com/z3rg/LLM-Auditor/main/deploy/tencent/bootstrap.sh -o bootstrap.sh
sudo bash bootstrap.sh
```

Skrip memasang Docker + compose plugin, membuat swap bila RAM < 2 GB, dan meng-*clone* repo ke
`/opt/llm-auditor`. Aplikasi **belum** dijalankan — itu disengaja, lihat langkah berikutnya.

## 4. Isi konfigurasi

```bash
sudo nano /opt/llm-auditor/deploy/tencent/.env
```

Wajib diisi sebelum start pertama:

```ini
DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIza...
SEED_PASSWORD=<kata sandi kuat pilihan Anda>
```

Siapkan skema & data awal sekali saja (boleh dari laptop, tidak harus dari server):

```bash
DATABASE_URL='postgresql://…' npm run db:setup
```

> **`SEED_PASSWORD` hanya dibaca sekali**, saat database kosong pertama kali dibuat, untuk akun
> `admin`/`auditor`/`director@company.co.id`. Kalau dibiarkan kosong, aplikasi memakai default
> publik `Auditor#2026` — jangan sampai itu terjadi di instance yang terbuka ke internet.
> Membetulkannya setelah terlanjur berarti menghapus database dan mulai ulang.
>
> Biarkan `COOKIE_SECURE` tetap dikomentari. Selama akses masih `http://IP`, memaksa `=1` membuat
> browser membuang cookie sesi dan login selalu gagal.

## 5. Jalankan

```bash
cd /opt/llm-auditor/deploy/tencent
sudo docker compose -f docker-compose.prod.yml up --build -d
```

Build memakan 1–3 menit (`npm ci` untuk Express + driver Neon). Verifikasi:

```bash
curl -s http://127.0.0.1/api/config
sudo docker compose -f docker-compose.prod.yml logs -f --tail=50
```

`/api/config` yang sehat mengembalikan JSON berisi `"hasKey": true` (Groq terbaca) dan objek
`rag`. Lalu buka `http://<IP-INSTANCE>` di browser dan login sebagai
`admin@company.co.id` dengan `SEED_PASSWORD` tadi — **ganti kata sandi lewat tab Akun** setelah
masuk.

## 6. (Opsional) bawa data demo + indeks RAG

Kalau database Neon-nya masih kosong, `npm run db:setup` sudah mengisi data dummy — tetapi tanpa
indeks RAG. Untuk memindahkan snapshot demo lengkap (452 chunk hasil ingest PDF POJK) dari
`data/auditor.db`, jalankan sekali dari laptop:

```bash
DATABASE_URL='postgresql://…' npm run db:migrate
```

Embedding sudah tersimpan di snapshot itu, jadi migrasi **tidak memanggil Gemini sama sekali**.
Alternatifnya: unggah ulang PDF lewat tab **Pengaturan** di UI (butuh `GEMINI_API_KEY`, dan kena
rate limit 100 embed/menit di tier gratis).

---

## Operasi harian

```bash
cd /opt/llm-auditor/deploy/tencent
COMPOSE="sudo docker compose -f docker-compose.prod.yml"

$COMPOSE ps                 # status
$COMPOSE logs -f --tail=100 # log berjalan
$COMPOSE restart            # restart cepat
sudo ./update.sh            # git pull + rebuild + restart + health check
./backup.sh                 # pg_dump database Neon ke /var/backups/llm-auditor
```

Backup otomatis tiap malam:

```bash
crontab -e
# 17 2 * * * DATABASE_URL='postgresql://…' /opt/llm-auditor/deploy/tencent/backup.sh >> /var/log/auditor-backup.log 2>&1
```

Instance ini **stateless**: seluruh state ada di Neon. Kontainer boleh dibuang dan dibangun ulang
kapan saja tanpa kehilangan data, dan `docker compose down -v` tidak lagi berbahaya.

---

## Batasan yang perlu disadari

1. **Belum ada HTTPS.** Login dikirim lewat HTTP polos, jadi kata sandi bisa dibaca di jaringan
   perantara. Layak untuk demo dengan akses terbatas, tidak layak untuk data audit sungguhan.
   Selama tahap ini, batasi juga port 80 ke IP kantor bila memungkinkan.
2. **Satu instance, satu kontainer.** Tidak ada failover; kalau instance mati, aplikasi mati —
   tetapi datanya aman di Neon, jadi pemulihan berarti menyalakan kontainer lagi.
3. **Kuota API.** Groq dan Gemini tier gratis punya rate limit; ingest PDF besar tetap perlu
   dijalankan bertahap.

### Menaikkan ke HTTPS nanti

Begitu ada domain, arahkan A record ke IP instance, buka port 443 di firewall, lalu tambahkan
Caddy di depan aplikasi (auto Let's Encrypt). Ubah `docker-compose.prod.yml`: hapus pemetaan port
pada service `llm-auditor`, tambahkan:

```yaml
  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    restart: unless-stopped
```

dengan `Caddyfile` berisi:

```
audit.contoh.id {
    reverse_proxy llm-auditor:3000
}
```

Caddy mengirim `X-Forwarded-Proto: https`, dan `lib/auth.js` otomatis memasang atribut `Secure`
pada cookie sesi — tidak ada perubahan kode yang diperlukan.

---

## Troubleshooting

| Gejala | Penyebab & solusi |
|--------|-------------------|
| `http://IP` tidak terbuka, tapi `curl` dari dalam server jalan | Port 80 belum dibuka di **firewall Lighthouse** (konsol), bukan di `ufw` |
| Build terhenti / OOM | RAM 1 GB tanpa swap. Jalankan ulang `bootstrap.sh` (membuat swap) atau naikkan paket |
| `"hasKey": false` di `/api/config` | `GROQ_API_KEY` kosong atau salah di `.env`; `$COMPOSE up -d` lagi setelah memperbaiki |
| Fitur AI error / timeout | Uji jangkauan dari server: `curl -sI https://api.groq.com` dan `curl -sI https://generativelanguage.googleapis.com`. Kalau *hang*, instance ada di region daratan Tiongkok |
| Semua endpoint 500 / "DATABASE_URL belum disetel" | `.env` belum berisi connection string Neon, atau skemanya belum dibuat — jalankan `npm run db:setup` |
| Impor PDF gagal | `GEMINI_API_KEY` kosong, atau kena rate limit embed (tier gratis 100/menit) |
| RAG jalan tapi lambat | Cek latensi ke Neon; region database sebaiknya sama dengan region instance (Singapore) |
| Login selalu ditolak walau kata sandi benar | `COOKIE_SECURE=1` diset tanpa HTTPS. Kosongkan, lalu restart |
