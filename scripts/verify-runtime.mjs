import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/verify-runtime.mjs <staged directory or release URL>');
const remote = /^https?:\/\//.test(target);
const read = async name => {
  if (!remote) return readFile(resolve(target, name));
  const response = await fetch(`${target.replace(/\/$/,'')}/${name}`, {cache:'no-store'});
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const manifest = JSON.parse((await read('runtime.json')).toString());
if (manifest.texLiveYear !== 2026 || !/^tl2026-[a-f0-9]{16}$/.test(manifest.releaseId)) throw new Error('Unexpected runtime identity');
const identity = {texLiveYear:manifest.texLiveYear,engineVersion:manifest.engineVersion,files:manifest.files};
if ('tl2026-'+createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,16) !== manifest.releaseId) throw new Error('Runtime identity does not match its manifest');
for (const [name, expected] of Object.entries(manifest.files)) {
  if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Invalid manifest path');
  const bytes = await read(name);
  if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error(`Runtime checksum mismatch: ${name}`);
}
console.log(`Verified ${manifest.releaseId}: all ${Object.keys(manifest.files).length} files match their SHA-256 checksums.`);
