// Copy the head detector model into public/models and the ONNX Runtime files into public/ort.
// HEAD_ONNX names a model file to use (the web build of the detector: constant-folded for onnxruntime-web); without it the
// copy already in public/models is used. See public/models/NOTICE.md for where the shipped model comes from.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const models = resolve(root, 'public/models');
mkdirSync(models, { recursive: true });
if (process.env.HEAD_ONNX) copyFileSync(process.env.HEAD_ONNX, resolve(models, 'head.onnx'));
if (!existsSync(resolve(models, 'head.onnx'))) console.warn('head detector model missing: set HEAD_ONNX');
// onnxruntime-web runtime, served as plain files at <app>/ort/ (see vite.config.ts); not committed (26 MB)
const ort = resolve(root, 'public/ort');
mkdirSync(ort, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  copyFileSync(resolve(root, 'node_modules/onnxruntime-web/dist', f), resolve(ort, f));
}
console.log('assets ready:', readdirSync(models).join(', '), '| ort:', readdirSync(ort).join(', '));
