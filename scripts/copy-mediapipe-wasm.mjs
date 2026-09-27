// Copies the MediaPipe Tasks Vision WASM runtime from node_modules into public/
// so the JS library and the WASM binary are always the same version.
// Runs on postinstall, predev and prebuild. Idempotent: only copies changed files.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const srcDir = join(pkgDir, 'wasm');
const destDir = join(root, 'public', 'mediapipe', 'wasm');

if (!existsSync(srcDir)) {
  console.error(`[mediapipe-wasm] source not found: ${srcDir} (run npm install first)`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
mkdirSync(destDir, { recursive: true });

let copied = 0;
for (const name of readdirSync(srcDir)) {
  const src = join(srcDir, name);
  const dest = join(destDir, name);
  const srcStat = statSync(src);
  if (!srcStat.isFile()) continue;
  const upToDate = existsSync(dest) && statSync(dest).size === srcStat.size;
  if (upToDate) continue;
  copyFileSync(src, dest);
  copied++;
}

writeFileSync(join(destDir, 'version.json'), JSON.stringify({ version }, null, 2) + '\n');
console.log(`[mediapipe-wasm] v${version} -> public/mediapipe/wasm (${copied} file(s) copied)`);
