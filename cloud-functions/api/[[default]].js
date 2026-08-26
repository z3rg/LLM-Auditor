/**
 * EdgeOne Makers Cloud Function — seluruh /api/* LLM Auditor.
 *
 * Nama berkas `[[default]].js` adalah pola catch-all multi-level Makers, dan
 * folder `api/` menjadi prefix URL-nya. Instance Express di-export (bukan
 * di-listen) sesuai kontrak platform.
 *
 * Logika rutenya sendiri ada di lib/api.js yang dipakai bersama server.js,
 * supaya perilaku lokal dan terdeploy tidak pernah bercabang.
 */
import express from 'express';
import { createRequire } from 'node:module';

// lib/ tetap CommonJS; folder ini ESM (lihat cloud-functions/package.json).
const require = createRequire(import.meta.url);
const apiRouter = require('../../lib/api.js');

const app = express();

// Tanpa body parser: router membaca stream mentah sendiri, baik untuk JSON
// maupun untuk unggahan PDF biner.
app.use((req, res) => {
  // Platform bisa saja memangkas prefix mount sebelum sampai ke Express,
  // sementara router mencocokkan path lengkap ('/api/config'). Kembalikan
  // prefiksnya bila hilang agar kedua kemungkinan tertangani.
  const url = req.url || '/';
  if (!(url === '/api' || url.startsWith('/api/'))) {
    req.url = '/api' + (url.startsWith('/') ? url : `/${url}`);
  }
  apiRouter.handle(req, res);
});

export default app;
