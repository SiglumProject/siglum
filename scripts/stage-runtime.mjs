// Produce an immutable, hash-verified runtime without uploading anything.
import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = process.env.SIGLUM_RUNTIME_INPUTS ? resolve(process.env.SIGLUM_RUNTIME_INPUTS) : root;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--combined-only')) {
  throw new Error('Usage: node scripts/stage-runtime.mjs [--combined-only]');
}
const runtimes = args.length ? ['busytex'] : ['busytex', 'pdftex', 'xetex'];
const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const files = {};
const inputs = new Map();
const add = async (key, path) => {
  const bytes = await readFile(path);
  files[key] = { size: bytes.length, sha256: digest(bytes) };
  inputs.set(key, { path });
  return bytes;
};
const busytexBuild = resolve(buildRoot, 'busytex/build');
const lock = 'texlive-packages.lock.json';
const provenance = await add('format-provenance.sha256', resolve(busytexBuild, 'texlive-basic-formats.sha256'));
const hashes = new Map();
for (const line of provenance.toString('utf8').trim().split('\n')) {
  const entry = /^([0-9a-f]{64})  ([a-zA-Z0-9_./-]+)$/.exec(line);
  if (!entry || hashes.has(entry[2])) throw new Error('Invalid BusyTeX format provenance');
  hashes.set(entry[2], entry[1]);
}
function checkFormatInput(path, bytes) {
  if (hashes.get(path) !== digest(bytes)) throw new Error(`BusyTeX format provenance mismatch: ${path}`);
}
const lockBytes = await add(lock, resolve(root, 'busytex', lock));
checkFormatInput(lock, lockBytes);
for (const name of runtimes) for (const ext of ['wasm', 'js']) {
  const asset = `wasm/${name}.${ext}`;
  const bytes = await add(asset, resolve(busytexBuild, asset));
  if (ext === 'wasm' && !bytes.includes(Buffer.from('TeX Live 2026'))) throw new Error(`${name} is not a TeX Live 2026 binary`);
  if (name === 'busytex') checkFormatInput(`build/${asset}`, bytes);
}
await add('worker.js', resolve(root, 'src/worker.js'));
await add('xzwasm.js', resolve(root, 'node_modules/xzwasm/dist/package/xzwasm.js'));
const bundles = resolve(buildRoot, 'packages/bundles');
const bundleConfig = JSON.parse(await readFile(resolve(bundles, 'bundles.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(bundles, 'file-manifest.json'), 'utf8'));
const formatPaths = new Map([
  ['fmt-pdflatex', 'texmf-var/web2c/pdftex/pdflatex.fmt'],
  ['fmt-xelatex', 'texmf-var/web2c/xetex/xelatex.fmt'],
  ['fmt-lualatex', 'texmf-var/web2c/luahbtex/luahblatex.fmt'],
]);
const lengths = new Map();
for (const name of (await readdir(bundles)).sort()) {
  if (!name.endsWith('.json') && !name.endsWith('.data.gz')) continue;
  await add(name, resolve(bundles, name));
  if (name.endsWith('.data.gz')) {
    const bytes = gunzipSync(await readFile(resolve(bundles, name)));
    const key = name.replace('.data.gz', '.raw');
    files[key] = { size: bytes.length, sha256: digest(bytes) };
    inputs.set(key, { gzip: resolve(bundles, name) });
    const bundle = name.replace('.data.gz', '');
    lengths.set(bundle, bytes.length);
    const format = formatPaths.get(bundle);
    if (format) {
      const relativePath = `texmf-dist/${format}`;
      const range = manifest[`/texlive/${relativePath}`];
      if (range?.bundle !== bundle || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
        || range.start < 0 || range.end <= range.start || range.end > bytes.length) {
        throw new Error(`Invalid BusyTeX format range: ${relativePath}`);
      }
      checkFormatInput(`build/texlive-basic/${relativePath}`, bytes.subarray(range.start, range.end));
    }
  }
}
for (const name of Object.keys(bundleConfig.bundles)) if (!lengths.has(name)) throw new Error(`Missing data bundle: ${name}`);
for (const name of formatPaths.keys()) if (!lengths.has(name) || !Object.hasOwn(bundleConfig.bundles, name)) throw new Error(`Missing format bundle: ${name}`);
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
