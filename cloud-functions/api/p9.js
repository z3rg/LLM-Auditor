import{fileURLToPath as __f}from"node:url";import{dirname as __d}from"node:path";import{createRequire as __cr}from"node:module";const __filename=__f(import.meta.url);const __dirname=__d(__filename);if(!globalThis.require)globalThis.require=__cr(import.meta.url);
/** Probe: BANNER persis seperti di artefak bundle, tapi berkasnya kecil dan sepele.
 * Kalau ini 404, penyebabnya banner (createRequire / globalThis.require), bukan kode aplikasi. */
export default function onRequest(){return new Response(JSON.stringify({ok:true,probe:"p9-banner",dirname:typeof __dirname,req:typeof globalThis.require}),{headers:{"Content-Type":"application/json"}});}
