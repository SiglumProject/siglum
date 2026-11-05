import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareRuntimePromotion, verifyPublishedEngine } from '../../scripts/prepare-runtime-promotion.mjs';
import { TEXLIVE_YEAR } from '../../src/texlive.js';

const directories: string[] = [];
const version = '9.8.7';
const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(extraAssets: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'siglum-promotion-test-'));
  directories.push(directory);
  const assets: Record<string, string> = {
    'wasm/busytex.js': 'matching glue',
    'wasm/busytex.wasm': 'matching wasm',
    'bundles.json': '{}',
    'file-manifest.json': '{}',
    'xzwasm.js': 'matching decompressor',
    ...extraAssets,
  };
  const files = Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, { size: bytes.length, sha256: sha256(bytes) }]));
  const identity = { texLiveYear: TEXLIVE_YEAR, engineVersion: version, files };
  const releaseId = `tl${TEXLIVE_YEAR}-${sha256(JSON.stringify(identity)).slice(0, 16)}`;
  const manifest = { releaseId, ...identity };
  const manifestText = JSON.stringify(manifest) + '\n';
  const manifestPath = join(directory, 'runtime.json');
  await writeFile(manifestPath, manifestText);
  const baseUrl = `https://runtime.example/releases/${releaseId}`;
  const fetchResource = async (url: string) => {
    if (url === baseUrl + '/runtime.json') return new Response(manifestText);
    const name = url.slice(baseUrl.length + 1);
    return Object.hasOwn(assets, name) ? new Response(assets[name]) : new Response('missing', { status: 404 });
  };
  const options = { manifestPath, outputDirectory: join(directory, 'promotion'), serviceBase: 'https://runtime.example', packageVersion: version, fetchResource };
  return { options, manifest, manifestText, assets, baseUrl };
}

describe('runtime publication preparation', () => {
  it('emits discovery metadata only after all hosted asset bytes verify', async () => {
    const data = await fixture();
    const descriptor = await prepareRuntimePromotion(data.options);
    expect(descriptor).toEqual({ schemaVersion: 1, engineVersion: version, releaseId: data.manifest.releaseId,
      baseUrl: data.baseUrl, manifestUrl: data.baseUrl + '/runtime.json', manifestSha256: sha256(data.manifestText) });
    expect(JSON.parse(await readFile(join(data.options.outputDirectory, 'runtime.json'), 'utf8'))).toEqual(descriptor);
  });

  it('rejects a corrupted asset before writing discovery metadata', async () => {
    const data = await fixture();
    data.assets['wasm/busytex.wasm'] = 'corrupted';
    await expect(prepareRuntimePromotion(data.options)).rejects.toThrow('checksum mismatch');
    await expect(readFile(join(data.options.outputDirectory, 'runtime.json'))).rejects.toThrow();
  });

  it('rejects a hosted manifest that differs from the release attachment', async () => {
    const data = await fixture();
    await writeFile(data.options.manifestPath, JSON.stringify(data.manifest, null, 2));
    await expect(prepareRuntimePromotion(data.options)).rejects.toThrow('differs from the release artifact');
  });

  it('rejects an SDK/runtime mismatch and unsafe service origin', async () => {
    const data = await fixture();
    await expect(prepareRuntimePromotion({ ...data.options, packageVersion: '8.0.0' })).rejects.toThrow('does not match');
    await expect(prepareRuntimePromotion({ ...data.options, serviceBase: 'http://runtime.example' })).rejects.toThrow('HTTPS origin');
    await expect(prepareRuntimePromotion({ ...data.options, serviceBase: 'https://runtime.example/other' })).rejects.toThrow('HTTPS origin');
  });

  it('rejects encoded traversal, query strings, and absolute manifest paths', async () => {
    for (const path of ['wasm/%2e%2e/%2e%2e/outside.txt', 'wasm/asset?other=1', '/outside.txt']) {
      const data = await fixture({ [path]: 'escape' });
      await expect(prepareRuntimePromotion(data.options)).rejects.toThrow('Invalid manifest path');
      await expect(readFile(join(data.options.outputDirectory, 'runtime.json'))).rejects.toThrow();
    }
  });
});

describe('npm latest promotion gate', () => {
  const registry = (latest: string, versions: Record<string, unknown> = { [version]: { version, dist: { integrity: 'sha512-fixture' } } }) =>
    async () => Response.json({ name: '@siglum/engine', versions, 'dist-tags': { latest } });

  it('allows global promotion only for the currently published latest', async () => {
    expect(await verifyPublishedEngine(version, registry(version))).toBe(true);
  });

  it('keeps a late older release from replacing a newer npm latest', async () => {
    expect(await verifyPublishedEngine(version, registry('10.0.0'))).toBe(false);
  });

  it('waits for registry processing instead of promoting an unpublished SDK', async () => {
    await expect(verifyPublishedEngine(version, registry('8.0.0', {}))).rejects.toThrow('not available yet');
    await expect(verifyPublishedEngine(version, async () => new Response('missing', { status: 404 }))).rejects.toThrow('not available yet');
  });

  it('rejects malformed registry metadata', async () => {
    await expect(verifyPublishedEngine(version, async () => Response.json({ name: 'other' }))).rejects.toThrow('metadata is invalid');
    await expect(verifyPublishedEngine(version, registry(version, { [version]: { version } }))).rejects.toThrow('metadata is invalid');
  });
});
