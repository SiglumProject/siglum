import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TEXLIVE_YEAR } from '../src/texlive.js';

export async function verifyRuntime(target, fetchResource = globalThis.fetch) {
  const remote = /^https?:\/\//.test(target);
  const read = async name => {
    if (!remote) return readFile(resolve(target, name));
    const response = await fetchResource(`${target.replace(/\/$/,'')}/${name}`, {cache:'no-store',redirect:'error'});
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const manifestBytes = await read('runtime.json');
  const manifest = JSON.parse(manifestBytes.toString());
  if (manifest.texLiveYear !== TEXLIVE_YEAR || !new RegExp(`^tl${TEXLIVE_YEAR}-[a-f0-9]{16}$`).test(manifest.releaseId)) throw new Error('Unexpected runtime identity');
  const identity = {texLiveYear:manifest.texLiveYear,engineVersion:manifest.engineVersion,files:manifest.files};
  if (`tl${TEXLIVE_YEAR}-`+createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,16) !== manifest.releaseId) throw new Error('Runtime identity does not match its manifest');
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid manifest path');
    if (!Number.isSafeInteger(expected?.size) || expected.size < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('Invalid runtime file metadata');
    const bytes = await read(name);
    if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error(`Runtime checksum mismatch: ${name}`);
  }
  return { manifest, manifestBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: node scripts/verify-runtime.mjs <staged directory or release URL>');
  const { manifest } = await verifyRuntime(target);
  console.log(`Verified ${manifest.releaseId}: all ${Object.keys(manifest.files).length} files match their SHA-256 checksums.`);
}
