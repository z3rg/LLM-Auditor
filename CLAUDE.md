# CLAUDE.md — konteks untuk sesi development berikutnya

Baca juga `DEVELOPER.md` (arsitektur, aturan penyimpanan Blob) dan `README.md` (pemakaian).
`dokumentasi.md` menggambarkan arsitektur LAMA (ReAct + RAG) — jangan dijadikan acuan.

## Branch & alur kerja

- **`edgeone-deploy`** = branch yang di-deploy ke EdgeOne Makers. Fitur dikerjakan di branch
  kerja (mis. `ccr-*`) yang bercabang dari `edgeone-deploy`, lalu di-merge ke sana bila pemilik
  repo memintanya (sejauh ini fast-forward).
- Komunikasi, komentar kode, dan pesan commit memakai **Bahasa Indonesia**.
- Jangan menambah dependency kalau modul bawaan Node cukup; frontend tanpa build step.

## Menjalankan & menguji

```bash
npm install
BLOB_LOCAL_DIR=./.blob-data npm run seed      # data dummy; akun bawaan: admin@company.co.id,
                                              # auditor@…, director@… — sandi awal "Auditor#2026"
BLOB_LOCAL_DIR=./.blob-data PORT=3000 npm start
npm run test:auth     # autentikasi end-to-end
npm run test:legal    # dokumen legal + penyusunan soal berbasis kutipan
npm run test:i18n     # kamus ID/EN lengkap + bahasa soal sampai ke prompt
```

- Tiga skrip uji memalsukan AI Gateway lewat `global.fetch`; **tidak** butuh `MAKERS_MODELS_KEY`.
  Mutu jawaban model sungguhan hanya bisa dicek di deployment EdgeOne.
- Uji UI di sesi cloud: Playwright global ada di `/opt/node22/lib/node_modules/playwright`,
  Chromium di `/opt/pw-browsers` (jangan `playwright install`). Pola yang dipakai: jalankan
  server lokal, `page.route('**/api/quiz/generate', …)` untuk memalsukan pembuatan kuis, lalu
  periksa teks & screenshot.
- Setelah mengubah daftar endpoint: `npm run agents:routes`.

## Bahasa (Indonesia / English) — ditambahkan 2026-10

- Kamus: `public/i18n.js` (`I18N.id`, `I18N.en`, `t()`, `applyI18n()`, `onLangChange()`).
  Dimuat sebelum `app.js`.
- Teks statis `index.html`: atribut `data-i18n`, `data-i18n-html`, `data-i18n-placeholder`,
  `data-i18n-aria-label`. Teks dinamis `app.js`: `t('kunci', { var })`.
  **Setiap teks baru wajib punya kunci di `id` DAN `en`** — `npm run test:i18n` memeriksanya.
- Jangan menamai variabel lokal `t` di `app.js` (menutupi fungsi `t()`); pakai `tp`, `tot`, dst.
- Pilihan disimpan per browser (localStorage `llm-auditor-lang`, `llm-auditor-quiz-lang`).
  Bahasa soal kuis: `auto` (ikuti antarmuka) | `id` | `en`.
- Server: klien mengirim `lang` ke `/api/quiz/generate`, `/api/ai/recommendation`,
  `/api/ai/quiz-topics`. `lib/ai.js` → `normLang()` + `langRule()` menambahkan aturan bahasa
  keluaran di AKHIR prompt; prompt induk tetap berbahasa Indonesia.
- Saat bahasa diganti, `onLangChange` di `app.js` menggambar ulang tab aktif tanpa menghapus
  kuis yang sedang dikerjakan.

## Pekerjaan lanjutan yang sudah teridentifikasi

- [ ] Verifikasi di EdgeOne bahwa kuis `en` benar-benar keluar dalam English (belum diuji dengan
      model sungguhan).
- [ ] Pesan galat dari server (`lib/api.js`, `lib/auth.js`, `lib/ai.js`) masih Bahasa Indonesia —
      bisa diterjemahkan dengan mengirim `lang`/header `Accept-Language` dan memetakan pesan.
- [ ] Preferensi bahasa masih per browser; bila perlu ikut akun, simpan di data user (Blob).
- [ ] Rekomendasi yang sudah tersimpan/terkirim ke Direktur tetap dalam bahasa saat dibuat.

## Riwayat fitur (terbaru di atas)

- Pengaturan bahasa ID/EN untuk antarmuka & soal kuis (commit `22b91ce`, di-merge ke `edgeone-deploy`).
- Generate kuis memakai tenggat per request, soal disusun paralel (`c095fea`).
- Pengayaan dokumen tahan jawaban terpotong (`360d7ed`).
- Dokumen legal (PDF) sebagai dasar penyusunan soal kuis (`01d6b76`).
