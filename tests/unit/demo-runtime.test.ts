import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDemoRuntime } from '../../scripts/demo-runtime.mjs';
import { ENGINE_VERSION } from '../../src/package-metadata.js';
import { TEXLIVE_YEAR } from '../../src/texlive.js';

const SERVICE = 'https://packages.siglum.org';
const POINTER = `${SERVICE}/engines/${ENGINE_VERSION}/latest.json`;
const RELEASE = `https://api.github.com/repos/SiglumProject/siglum/releases/tags/v${ENGINE_VERSION}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let directory: string;

function runtime() {
  const files = Object.fromEntries(['bundles.json', 'file-manifest.json', 'wasm/busytex.js', 'wasm/busytex.wasm', 'xzwasm.js']
    .map(name => [name, { size: 1, sha256: hash('x') }]));
  const identity = { texLiveYear: TEXLIVE_YEAR, engineVersion: ENGINE_VERSION, files };
  const releaseId = `tl${TEXLIVE_YEAR}-${hash(JSON.stringify(identity)).slice(0, 16)}`;
  const manifest = { releaseId, ...identity };
  const text = JSON.stringify(manifest);
  const baseUrl = `${SERVICE}/releases/${releaseId}`;
  return { manifest, text, descriptor: {
    schemaVersion: 1, engineVersion: ENGINE_VERSION, releaseId, baseUrl,
    manifestUrl: `${baseUrl}/runtime.json`, manifestSha256: hash(text),
  } };
}

function network(pair = runtime(), legacy = false, body = pair.descriptor.manifestUrl) {
  return vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    if (url === POINTER) return legacy ? new Response('Missing', { status: 404 }) : new Response(JSON.stringify(pair.descriptor));
    if (url === RELEASE) return new Response(JSON.stringify({ tag_name: `v${ENGINE_VERSION}`, draft: false, body }));
    if (url === pair.descriptor.manifestUrl) return new Response(pair.text);
    throw new Error(`Unexpected metadata request: ${url}`);
  });
}

async function stage(pair = runtime()) {
  const target = join(directory, '.local-release', pair.manifest.releaseId);
  await mkdir(target, { recursive: true });
  await writeFile(join(directory, '.local-release/current.json'), JSON.stringify({ directory: target }));
  await writeFile(join(target, 'runtime.json'), pair.text);
  for (const name of Object.keys(pair.manifest.files)) {
    const path = join(target, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'x');
  }
  return target;
}

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  directory = await mkdtemp('/private/tmp/siglum-demo-runtime-unit-');
});
afterEach(() => rm(directory, { recursive: true, force: true }));

describe('single-checkout playground runtime', () => {
  it('uses the public per-SDK descriptor without consulting GitHub when available', async () => {
    const pair = runtime();
    const fetcher = network(pair);
    const result = await resolveDemoRuntime({ directory, origin: 'http://localhost:8787', fetchResource: fetcher });
    expect(result.config).toMatchObject({ mode: 'hosted', baseUrl: pair.descriptor.baseUrl });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([POINTER, pair.descriptor.manifestUrl]);
  });

  it('bridges only an exact SDK descriptor404 through its matching release notes', async () => {
    const pair = runtime();
    const fetcher = network(pair, true, `[Runtime manifest](${pair.descriptor.manifestUrl})`);
    const result = await resolveDemoRuntime({ directory, origin: 'http://localhost:8787', fetchResource: fetcher });
    expect(result.config.baseUrl).toBe(pair.descriptor.baseUrl);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([POINTER, RELEASE, pair.descriptor.manifestUrl]);
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.redirect).toBe('error');
      expect(options?.signal).toBeDefined();
    }
  });

  it('rejects draft release metadata before reading a manifest', async () => {
    const pair = runtime();
    const normal = network(pair, true);
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => url === RELEASE
      ? new Response(JSON.stringify({ tag_name: `v${ENGINE_VERSION}`, draft: true, body: pair.descriptor.manifestUrl }))
      : normal(url, init));
    await expect(resolveDemoRuntime({ directory, origin: 'http://localhost:8787', fetchResource: fetcher })).rejects.toMatchObject({
      cause: { message: 'Invalid matching engine release' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not consult release notes for server failures or invalid descriptors', async () => {
    for (const response of [new Response('Down', { status: 503 }), new Response('{}')]) {
      const fetcher = vi.fn(async () => response);
      await expect(resolveDemoRuntime({ directory, origin: 'http://localhost:8787', fetchResource: fetcher })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects ambiguous or noncanonical release-note manifest links', async () => {
    const pair = runtime();
    for (const body of [
      `${pair.descriptor.manifestUrl}\nhttps://packages.siglum.org/releases/tl${TEXLIVE_YEAR}-aaaaaaaaaaaaaaaa/runtime.json`,
      pair.descriptor.manifestUrl + '?other=true',
      'https://other.example/releases/anything/runtime.json',
    ]) {
      await expect(resolveDemoRuntime({ directory, origin: 'http://localhost:8787', fetchResource: network(pair, true, body) })).rejects.toMatchObject({
        cause: { message: 'Matching engine release must identify one immutable runtime manifest' },
      });
    }
  });

  it('lets the SDK reject a release-note manifest belonging to a different engine', async () => {
    const pair = runtime();
    pair.manifest.engineVersion = '0.0.0-incompatible';
    pair.text = JSON.stringify(pair.manifest);
    await expect(resolveDemoRuntime({ directory, origin: 'http://localhost:8787', fetchResource: network(pair, true) })).rejects.toThrow('manifest identity');
  });

  it('uses all assets from a complete matching local stage without network requests', async () => {
    const pair = runtime();
    const target = await stage(pair);
    const fetcher = vi.fn();
    const result = await resolveDemoRuntime({ directory, origin: 'http://localhost:8787', fetchResource: fetcher });
    expect(result.config).toMatchObject({ mode: 'local', baseUrl: `http://localhost:8787/releases/${pair.manifest.releaseId}`, ctanProxyUrl: 'http://localhost:8787' });
    expect(result.directory).toBe(target);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses one complete hosted runtime when local assets are missing or wrong-sized', async () => {
    const pair = runtime();
    const target = await stage(pair);
    await writeFile(join(target, 'wasm/busytex.wasm'), 'wrong size');
    const result = await resolveDemoRuntime({ directory, origin: 'http://localhost:8787', fetchResource: network(pair) });
    expect(result.config.mode).toBe('hosted');
    expect(result.directory).toBeNull();
    expect(result.config.wasmUrl).toBe(`${pair.descriptor.baseUrl}/wasm/busytex.wasm`);
  });

  it('honors hosted mode even when a complete local stage exists', async () => {
    const pair = runtime();
    await stage(pair);
    const result = await resolveDemoRuntime({ directory, origin: 'http://localhost:8787', hosted: true, fetchResource: network(pair) });
    expect(result.config.mode).toBe('hosted');
  });
});
