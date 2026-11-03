// Produce an immutable, hash-verified runtime without uploading anything.
import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const files = {};
const inputs = new Map();
const add = async (key, path) => {
  const bytes = await readFile(path);
  files[key] = { size: bytes.length, sha256: digest(bytes) };
  inputs.set(key, { path });
};
for (const name of ['busytex', 'pdftex', 'xetex']) for (const ext of ['wasm', 'js']) {
  const path = resolve(root, `busytex/build/wasm/${name}.${ext}`);
  if (ext === 'wasm' && !(await readFile(path)).includes(Buffer.from('TeX Live 2026'))) throw new Error(`${name} is not a TeX Live 2026 binary`);
  await add(`wasm/${name}.${ext}`, path);
}
await add('worker.js', resolve(root, 'src/worker.js'));
await add('xzwasm.js', resolve(root, 'node_modules/xzwasm/dist/package/xzwasm.js'));
const bundles = resolve(root, 'packages/bundles');
const bundleConfig = JSON.parse(await readFile(resolve(bundles, 'bundles.json'), 'utf8'));
const lengths = new Map();
for (const name of (await readdir(bundles)).sort()) {
  if (!name.endsWith('.json') && !name.endsWith('.data.gz')) continue;
  await add(name, resolve(bundles, name));
  if (name.endsWith('.data.gz')) {
    const bytes = gunzipSync(await readFile(resolve(bundles, name)));
    const key = name.replace('.data.gz', '.raw');
    files[key] = { size: bytes.length, sha256: digest(bytes) };
    inputs.set(key, { gzip: resolve(bundles, name) });
    lengths.set(name.replace('.data.gz',''), bytes.length);
  }
}
for (const name of Object.keys(bundleConfig.bundles)) if (!lengths.has(name)) throw new Error(`Missing data bundle: ${name}`);
const manifest = JSON.parse(await readFile(resolve(bundles, 'file-manifest.json'), 'utf8'));
for (const [path, file] of Object.entries(manifest)) {
  if (!lengths.has(file.bundle) || file.start < 0 || file.end < file.start || file.end > lengths.get(file.bundle)) throw new Error(`Invalid bundle range: ${path}`);
}
for (const name of (await readdir(resolve(bundles, 'prebuilt'))).sort()) {
  if (name.endsWith('.json')) await add(`normalized/${name}`, resolve(bundles, 'prebuilt', name));
}
const identity = { texLiveYear: 2026, engineVersion: packageInfo.version, files: Object.fromEntries(Object.entries(files).sort(([a],[b]) => a.localeCompare(b))) };
const releaseId = 'tl2026-' + digest(JSON.stringify(identity)).slice(0,16);
const destination = resolve(root, '.local-release', releaseId);
await mkdir(destination, { recursive: true });
for (const [key, input] of inputs) {
  const target = resolve(destination, key); await mkdir(dirname(target), { recursive: true });
  if (input.path) await copyFile(input.path, target);
  else await writeFile(target, gunzipSync(await readFile(input.gzip)));
}
await writeFile(resolve(destination, 'runtime.json'), JSON.stringify({releaseId, ...identity}, null, 2) + '\n');
await writeFile(resolve(root, '.local-release/current.json'), JSON.stringify({releaseId, directory: destination}, null, 2) + '\n');
console.log(`Staged ${releaseId}: ${inputs.size} files, ${Math.round(Object.values(files).reduce((n,f)=>n+f.size,0)/1024/1024)} MiB\n${destination}`);
