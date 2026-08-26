"""
Legal PDF ingestion pipeline for Indonesian OJK regulation (PADK).
Parses hierarchical structure: BAB (chapter) > A./B. (section) > 1./2. (point) > a./b. (sub-point)
Embeds each chunk with gemini-embedding-001 (3072-dim) and stores it in Postgres (pgvector).

This script feeds directly into the Node.js LLM Auditor RAG pipeline — it writes to the same
pdf_documents / pdf_chunks tables that the web app reads from. Skemanya dimiliki
db/schema.sql; jalankan `npm run db:setup` lebih dulu.

Prerequisites:
    pip install pypdf google-genai "psycopg[binary]"

Usage:
    export GEMINI_API_KEY="your-key-here"
    export DATABASE_URL="postgresql://…"        # connection string Neon, sama dengan app
    python3 scripts/ingest_legal_pdf.py /path/to/document.pdf

    # Optional override:
    GEMINI_EMBED_MODEL=gemini-embedding-001 python3 scripts/ingest_legal_pdf.py doc.pdf
"""

import os
import re
import sys
import json
import time
import unicodedata
from dataclasses import dataclass
from typing import Optional

import psycopg
from pypdf import PdfReader

# ── CONFIG ────────────────────────────────────────────────────────────────────
_SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_SCRIPT_DIR)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
EMBED_MODEL = os.environ.get("GEMINI_EMBED_MODEL", "gemini-embedding-001")
EMBED_DIM  = 3072
TASK_DOC   = "RETRIEVAL_DOCUMENT"
MAX_CHARS  = 3500    # keeps us safely under the 2 048-token limit for Indonesian text
MIN_CHARS  = 40      # skip near-empty fragments
API_SLEEP  = 0.05   # gentle pacing to avoid free-tier rate limit bursts


# ── DATA MODEL ────────────────────────────────────────────────────────────────
@dataclass
class Chunk:
    text: str
    page_number: int
    bab: Optional[str] = None
    section: Optional[str] = None
    point: Optional[str] = None
    subpoint: Optional[str] = None
    breadcrumb: str = ""
    source_pdf: str = ""


# ── STEP 1: EXTRACT TEXT PER PAGE ─────────────────────────────────────────────
def extract_pages(pdf_path: str) -> list[str]:
    reader = PdfReader(pdf_path)
    pages = []
    for page in reader.pages:
        text = page.extract_text() or ""
        # Normalize unicode (OJK PDFs sometimes mix NFC/NFD forms for Indonesian diacritics)
        text = unicodedata.normalize("NFC", text)
        pages.append(text)
    return pages


# ── STEP 2: PARSE HIERARCHY LINE-BY-LINE ──────────────────────────────────────
RE_BAB       = re.compile(r"^\s*BAB\s+([IVXLCDM]+)\b\s*(.*)$")
RE_PASAL     = re.compile(r"^\s*Pasal\s+(\d+)\s*$")
RE_SECTION   = re.compile(r"^\s*([A-Z])\.\s+(\S.*)$")
RE_POINT     = re.compile(r"^\s*(\d{1,2})\.\s+(\S.*)$")
RE_SUBPOINT  = re.compile(r"^\s*([a-z])\.\s+(\S.*)$")
RE_TOC_LINE  = re.compile(r"\.{4,}\s*-?\s*\d+\s*-?\s*$")


def parse_hierarchy(pages: list[str], source_pdf: str) -> list[Chunk]:
    chunks: list[Chunk] = []
    current_bab = current_section = current_point = current_subpoint = None
    buffer_lines: list[str] = []
    buffer_page = 1

    def flush():
        text = "\n".join(buffer_lines).strip()
        if len(text) >= MIN_CHARS:
            chunks.append(Chunk(
                text=text,
                page_number=buffer_page,
                bab=current_bab,
                section=current_section,
                point=current_point,
                subpoint=current_subpoint,
                source_pdf=source_pdf,
            ))
        buffer_lines.clear()

    for page_idx, page_text in enumerate(pages, start=1):
        for raw_line in page_text.split("\n"):
            line = raw_line.rstrip()
            if not line.strip():
                continue
            if RE_TOC_LINE.search(line) or line.strip() == "DAFTAR ISI":
                continue

            if RE_BAB.match(line):
                flush()
                current_bab = line.strip()
                current_section = current_point = current_subpoint = None
                buffer_page = page_idx
                continue

            if RE_PASAL.match(line):
                flush()
                current_bab = line.strip()
                current_section = current_point = current_subpoint = None
                buffer_page = page_idx
                continue

            if RE_SECTION.match(line):
                flush()
                current_section = line.strip()
                current_point = current_subpoint = None
                buffer_page = page_idx
                buffer_lines.append(line.strip())
                continue

            if RE_POINT.match(line):
                flush()
                current_point = line.strip()
                current_subpoint = None
                buffer_page = page_idx
                buffer_lines.append(line.strip())
                continue

            if RE_SUBPOINT.match(line):
                flush()
                current_subpoint = line.strip()
                buffer_page = page_idx
                buffer_lines.append(line.strip())
                continue

            if not buffer_lines:
                buffer_page = page_idx
            buffer_lines.append(line.strip())

    flush()
    return chunks


# ── STEP 3: BUILD BREADCRUMBS + SPLIT OVERSIZED CHUNKS ───────────────────────
def build_breadcrumb(c: Chunk) -> str:
    return " > ".join(p for p in [c.bab, c.section, c.point, c.subpoint] if p)


def split_long_text(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    sentences = re.split(r"(?<=[.;:])\s+", text)
    pieces, current = [], ""
    for sent in sentences:
        if len(current) + len(sent) + 1 > max_chars and current:
            pieces.append(current.strip())
            current = sent
        else:
            current = f"{current} {sent}".strip()
    if current:
        pieces.append(current.strip())
    return pieces


def finalize_chunks(raw_chunks: list[Chunk]) -> list[Chunk]:
    final = []
    for c in raw_chunks:
        breadcrumb = build_breadcrumb(c)
        for piece in split_long_text(c.text, MAX_CHARS):
            # Prepend breadcrumb so retrieval "knows" the chapter/section context.
            contextual = f"[{breadcrumb}]\n{piece}" if breadcrumb else piece
            final.append(Chunk(
                text=contextual,
                page_number=c.page_number,
                bab=c.bab,
                section=c.section,
                point=c.point,
                subpoint=c.subpoint,
                breadcrumb=breadcrumb,
                source_pdf=c.source_pdf,
            ))
    return final


# ── STEP 4: EMBEDDING (Gemini) ────────────────────────────────────────────────
def get_genai_client():
    from google import genai
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("Set the GEMINI_API_KEY environment variable first.")
    return genai.Client(api_key=api_key)


def embed_text(client, text: str, task_type: str = TASK_DOC) -> list[float]:
    result = client.models.embed_content(
        model=EMBED_MODEL,
        contents=text,
        config={"task_type": task_type},
    )
    return result.embeddings[0].values


# ── STEP 5: POSTGRES STORAGE (skema yang sama dengan app Node.js) ────────────
def to_vector(vector: list[float]) -> str:
    """list[float] -> literal pgvector '[0.1,0.2,…]'."""
    return "[" + ",".join(repr(float(v)) for v in vector) + "]"


def init_db(database_url: str):
    if not database_url:
        raise RuntimeError(
            "DATABASE_URL belum disetel. Isi connection string Neon yang sama dengan app."
        )
    db = psycopg.connect(database_url)

    # Skema dimiliki db/schema.sql — di sini cukup dipastikan sudah ada, supaya
    # kegagalannya jelas alih-alih 'relation does not exist' di tengah ingest.
    with db.cursor() as cur:
        cur.execute("SELECT to_regclass('public.pdf_chunks')")
        if cur.fetchone()[0] is None:
            raise RuntimeError(
                "Tabel pdf_chunks belum ada. Jalankan `npm run db:setup` lebih dulu."
            )
        # Beri tahu reconcile() di lib/vec.js bahwa database ini memakai Gemini,
        # agar server tidak meng-embed ulang semuanya saat start berikutnya.
        cur.execute(
            "INSERT INTO app_settings (key, value) VALUES ('embed_meta', %s) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (json.dumps({"name": f"gemini:{EMBED_MODEL}", "dim": EMBED_DIM}),),
        )
    db.commit()
    return db


def store_chunk(db, chunk: Chunk, doc_id: int,
                chunk_index: int, embedding: list[float]):
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO pdf_chunks (doc_id, chunk_index, content, embedding) "
            "VALUES (%s, %s, %s, %s::vector)",
            (doc_id, chunk_index, chunk.text, to_vector(embedding)),
        )


# ── MAIN PIPELINE ─────────────────────────────────────────────────────────────
def main(pdf_path: str):
    source_name = os.path.basename(pdf_path)
    title = source_name.removesuffix(".pdf")
    file_bytes = os.path.getsize(pdf_path)

    print(f"[1/5] Extracting text from {source_name} ...")
    pages = extract_pages(pdf_path)
    print(f"      {len(pages)} pages extracted.")

    print("[2/5] Parsing legal hierarchy (BAB / section / point / sub-point) ...")
    raw_chunks = parse_hierarchy(pages, source_name)
    print(f"      {len(raw_chunks)} raw hierarchical units found.")

    print("[3/5] Splitting oversized chunks + attaching breadcrumbs ...")
    chunks = finalize_chunks(raw_chunks)
    print(f"      {len(chunks)} final chunks ready for embedding.")

    full_text_chars = sum(len(c.text) for c in chunks)

    print("[4/5] Connecting to Postgres and embedding with Gemini ...")
    client = get_genai_client()
    db = init_db(DATABASE_URL)

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO pdf_documents (filename, title, num_pages, num_chunks, bytes, chars, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (source_name, title, len(pages), len(chunks), file_bytes, full_text_chars, now),
        )
        doc_id = cur.fetchone()[0]
    db.commit()

    embedded_count = 0
    for i, chunk in enumerate(chunks):
        try:
            vec = embed_text(client, chunk.text)
            store_chunk(db, chunk, doc_id, i, vec)
            embedded_count += 1
        except Exception as e:
            print(f"      ! Failed on chunk {i} (page {chunk.page_number}): {e}")
        if (i + 1) % 20 == 0:
            print(f"      ... {i + 1}/{len(chunks)} embedded")
            db.commit()
        time.sleep(API_SLEEP)

    with db.cursor() as cur:
        cur.execute(
            "UPDATE pdf_documents SET num_chunks = %s WHERE id = %s",
            (embedded_count, doc_id),
        )
    db.commit()

    print(f"[5/5] Done. {embedded_count}/{len(chunks)} chunks embedded.")
    print(f"      Document ID {doc_id} stored in Postgres.")
    db.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 scripts/ingest_legal_pdf.py /path/to/document.pdf")
        sys.exit(1)
    main(sys.argv[1])
