# syntax=docker/dockerfile:1
#
# LLM Auditor — image portabel (jalur VM/Lighthouse, alternatif dari EdgeOne Makers).
#
# State aplikasi TIDAK lagi ada di dalam kontainer: seluruh data tinggal di
# Postgres (Neon) + pgvector, jadi tidak ada volume dan tidak ada berkas SQLite.
# Kontainer ini murni stateless — cukup diberi DATABASE_URL.
#
# Diberikan saat runtime (env):
#   DATABASE_URL   — connection string Neon (wajib)
#   GROQ_API_KEY   — fitur AI Groq
#   GEMINI_API_KEY — embedding RAG
#
# Konteks build = root repo; Dockerfile ada di docker/. Jalankan dari root:
#   docker build -f docker/Dockerfile -t llm-auditor .
# Build lintas-arsitektur eksplisit:
#   docker buildx build -f docker/Dockerfile --platform linux/amd64 -t llm-auditor .

############################  Stage 1 — dependencies  ############################
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Lapisan terpisah agar cache dependency tidak batal setiap kali kode berubah.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

############################  Stage 2 — runtime  ############################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PORT=3000 \
    GEMINI_EMBED_MODEL=gemini-embedding-001

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN chown -R node:node /app
USER node
EXPOSE 3000

# Healthcheck ringan ke endpoint konfigurasi.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
