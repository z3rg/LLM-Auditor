# syntax=docker/dockerfile:1
#
# LLM Auditor — image portabel.
# Inti app ZERO-DEPENDENCY (hanya modul bawaan Node) → tidak ada `npm install`.
# Yang dibungkus ke image: ekstensi sqlite-vec (vec0.so) untuk arsitektur target.
#
# Embedding RAG memakai Gemini API (gemini-embedding-001) — panggilan jaringan
# saat runtime, jadi image TIDAK menyertakan model lokal.
#
# Diberikan saat runtime (env): GROQ_API_KEY (fitur AI Groq) + GEMINI_API_KEY (RAG embedding).
#
# Konteks build = root repo; Dockerfile ada di docker/. Jalankan dari root:
#   docker build -f docker/Dockerfile -t llm-auditor .
# Build lintas-arsitektur eksplisit:
#   docker buildx build -f docker/Dockerfile --platform linux/amd64 -t llm-auditor .

############################  Stage 1 — builder  ############################
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Disediakan otomatis oleh buildkit: "amd64" | "arm64"
ARG TARGETARCH
ARG SQLITE_VEC_VERSION=0.1.9

# Alat build: unduh biner sqlite-vec (curl/tar).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar \
 && rm -rf /var/lib/apt/lists/*

# 1) Ekstensi sqlite-vec (vec0.so) sesuai arsitektur Linux target
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) SV="sqlite-vec-linux-x64" ;; \
      arm64) SV="sqlite-vec-linux-arm64" ;; \
      *) echo "Arsitektur tidak didukung: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mkdir -p lib/vendor; \
    curl -fsSL "https://registry.npmjs.org/${SV}/-/${SV}-${SQLITE_VEC_VERSION}.tgz" -o /tmp/sv.tgz; \
    tar -xzf /tmp/sv.tgz -C /tmp; \
    cp /tmp/package/vec0.so lib/vendor/vec0.so; \
    rm -rf /tmp/sv.tgz /tmp/package

# 2) Kode aplikasi (zero-dependency — tanpa node_modules; lihat Dockerfile.dockerignore)
COPY . .

############################  Stage 2 — runtime  ############################
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PORT=3000 \
    DB_PATH=/app/data/auditor.db \
    SQLITE_VEC_PATH=/app/lib/vendor/vec0.so \
    GEMINI_EMBED_MODEL=gemini-embedding-001

# Bawa biner vendor (vec0.so) + kode aplikasi dari builder
COPY --from=builder /app /app

# Direktori data (DB + basis pengetahuan RAG) dipersist via volume
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node
EXPOSE 3000

# Healthcheck ringan ke endpoint konfigurasi
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
