# Dokumen regulasi — sumber basis pengetahuan RAG

Tiga POJK di folder ini adalah **berkas asli** yang di-*ingest* ke basis pengetahuan RAG
pada `data/auditor.db`. Agen ReAct menarik potongan dari sinilah saat menyusun soal kuis,
dan setiap soal yang *grounded* mencantumkan dokumen asalnya di UI.

| Berkas | Halaman | Chunk di indeks |
|--------|---------|-----------------|
| `POJK 11 - 03 - 2022.pdf` | 76 | 353 |
| `pojk 4-2021.pdf` | 66 | 272 |
| `pojk 13-2020.pdf` | 13 | 34 |

Total **452 chunk**, di-*embed* dengan Gemini `gemini-embedding-001` (3072 dimensi) dan
disimpan di tabel `pdf_chunks` + virtual table `vec_pdf_chunks` (sqlite-vec).

> `pojk 4-2021.pdf` ter-ingest sebagian (272 dari ~perkiraan penuh) karena batas laju
> Gemini free tier saat proses impor. Lihat catatan di `dokumentasi.md` §4.2.

## Meng-ingest ulang

Snapshot `data/auditor.db` sudah memuat indeksnya, jadi biasanya tidak perlu diulang.
Bila ingin membangun ulang dari nol:

```bash
python3 scripts/ingest_legal_pdf.py "docs/regulasi/POJK 11 - 03 - 2022.pdf"
```

Atau unggah lewat UI: **Pengaturan → PDF Importer** (khusus Super Admin).

Dokumen POJK diterbitkan Otoritas Jasa Keuangan dan bersifat publik.
