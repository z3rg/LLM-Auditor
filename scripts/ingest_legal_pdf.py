"""
Legal PDF ingestion pipeline for Indonesian OJK regulation (PADK).
Parses hierarchical structure: BAB (chapter) > A./B. (section) > 1./2. (point) > a./b. (sub-point)
Embeds each chunk with gemini-embedding-001 (3072-dim) and stores in auditor.db (sqlite-vec).

This script feeds directly into the Node.js LLM Auditor RAG pipeline — it writes to the same
pdf_documents / pdf_chunks / vec_pdf_chunks tables that the web app reads from.

Prerequisites:
    pip install pypdf google-genai sqlite-vec

Usage:
    export GEMINI_API_KEY="your-key-here"
    python3 scripts/ingest_legal_pdf.py /path/to/document.pdf

    # Optional overrides (defaults match the Node.js app's .env):
    DB_PATH=/custom/path/to/auditor.db python3 scripts/ingest_legal_pdf.py doc.pdf
    GEMINI_EMBED_MODEL=gemini-embedding-001 python3 scripts/ingest_legal_pdf.py doc.pdf
"""

import os
import re
import sys
import json
import time
import struct
import sqlite3
import unicodedata
from dataclasses import dataclass
from typing import Optional

import sqlite_vec
from pypdf import PdfReader

# ── CONFIG ────────────────────────────────────────────────────────────────────
_SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_SCRIPT_DIR)

DB_PATH    = os.environ.get("DB_PATH",   os.path.join(_PROJECT_ROOT, "data", "auditor.db"))
VEC_EXT    = os.environ.get("SQLITE_VEC_PATH", os.path.join(_PROJECT_ROOT, "lib", "vendor", "vec0.dylib"))
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


# ── STEP 5: SQLITE STORAGE (same schema as Node.js app) ──────────────────────
def serialize_f32(vector: list[float]) -> bytes:
    return struct.pack(f"{len(vector)}f", *vector)


def init_db(db_path: str) -> sqlite3.Connection:
    db = sqlite3.connect(db_path)
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA foreign_keys = ON")

    # Load sqlite-vec extension (same .dylib the Node.js app uses).
    db.enable_load_extension(True)
    try:
        sqlite_vec.load(db)
        print(f"      sqlite-vec loaded from Python package.")
    except Exception:
        try:
            db.load_extension(VEC_EXT.replace(".dylib", ""))
            print(f"      sqlite-vec loaded from {VEC_EXT}")
        except Exception as e:
            raise RuntimeError(f"Cannot load sqlite-vec: {e}") from e
    db.enable_load_extension(False)

    # Mirror the Node.js app schema exactly so vec.js can read our rows.
    db.execute("""
        CREATE TABLE IF NOT EXISTS pdf_documents (
            id         INTEGER PRIMARY KEY,
            filename   TEXT NOT NULL,
            title      TEXT,
            num_pages  INTEGER,
            num_chunks INTEGER NOT NULL DEFAULT 0,
            bytes      INTEGER,
            chars      INTEGER,
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS pdf_chunks (
            id          INTEGER PRIMARY KEY,
            doc_id      INTEGER NOT NULL REFERENCES pdf_documents(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            content     TEXT NOT NULL,
            embedding   BLOB
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_pdf_chunks_doc ON pdf_chunks(doc_id)")

    # vec0 virtual table — only create if it doesn't exist yet.
    # Node.js manages this table; we create it here if the script is run first.
    db.execute(f"""
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_pdf_chunks
        USING vec0(embedding float[{EMBED_DIM}])
    """)

    # Tell the Node.js reconcile() that this DB is now in Gemini mode so it
    # won't re-embed everything the next time the server starts.
    db.execute("""
        CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    db.execute(
        "INSERT INTO app_settings (key, value) VALUES ('embed_meta', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps({"name": f"gemini:{EMBED_MODEL}", "dim": EMBED_DIM}),),
    )
    db.commit()
    return db


def store_chunk(db: sqlite3.Connection, chunk: Chunk, doc_id: int,
                chunk_index: int, embedding: list[float]):
    blob = serialize_f32(embedding)
    cur = db.execute(
        "INSERT INTO pdf_chunks (doc_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?)",
        (doc_id, chunk_index, chunk.text, blob),
    )
    chunk_id = cur.lastrowid
    db.execute(
        "INSERT INTO vec_pdf_chunks (rowid, embedding) VALUES (?, ?)",
        (chunk_id, blob),
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

    print("[4/5] Connecting to DB and embedding with Gemini ...")
    client = get_genai_client()
    db = init_db(DB_PATH)

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    cur = db.execute(
        "INSERT INTO pdf_documents (filename, title, num_pages, num_chunks, bytes, chars, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (source_name, title, len(pages), len(chunks), file_bytes, full_text_chars, now),
    )
    doc_id = cur.lastrowid

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

    db.execute(
        "UPDATE pdf_documents SET num_chunks = ? WHERE id = ?",
        (embedded_count, doc_id),
    )
    db.commit()

    print(f"[5/5] Done. {embedded_count}/{len(chunks)} chunks embedded.")
    print(f"      Document ID {doc_id} stored in {DB_PATH}")
    db.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 scripts/ingest_legal_pdf.py /path/to/document.pdf")
        sys.exit(1)
    main(sys.argv[1])
