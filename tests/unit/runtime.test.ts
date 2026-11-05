import { createHash, webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import packageInfo from '../../package.json';
import { SiglumCompiler } from '../../src/compiler.js';
import { ENGINE_VERSION } from '../../src/package-metadata.js';
import { resolveRuntime } from '../../src/runtime.js';
import { TEXLIVE_YEAR } from '../../src/texlive.js';

const SERVICE = 'https://packages.siglum.org';
const CACHE_NAME = 'siglum-runtime-resolutions-v1';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const pointerUrl = (service = SERVICE, version = ENGINE_VERSION) => `${service}/engines/${version}/latest.json`;

function fixture(service = SERVICE, size = 1, engineVersion = ENGINE_VERSION) {
    const files = Object.fromEntries([
        'bundles.json', 'file-manifest.json', 'wasm/busytex.js', 'wasm/busytex.wasm', 'xzwasm.js',
    ].map(name => [name, { size, sha256: '0'.repeat(64) }]));
    const identity = { texLiveYear: TEXLIVE_YEAR, engineVersion, files };
    const releaseId = `tl${TEXLIVE_YEAR}-${digest(JSON.stringify(identity)).slice(0, 16)}`;
    const manifest = { releaseId, ...identity };
    const manifestText = JSON.stringify(manifest, null, 2) + '\n';
    const baseUrl = `${service}/releases/${releaseId}`;
    const descriptor = {
        schemaVersion: 1 as const, engineVersion, releaseId, baseUrl,
        manifestUrl: `${baseUrl}/runtime.json`, manifestSha256: digest(manifestText),
    };
    return { descriptor, manifest, manifestText };
}

function network(pair = fixture(), service = SERVICE) {
    return vi.fn(async (input: RequestInfo | URL) => {
        if (input === pointerUrl(service)) return new Response(JSON.stringify(pair.descriptor));
        if (input === pair.descriptor.manifestUrl) return new Response(pair.manifestText);
        throw new Error(`Unexpected fetch: ${input}`);
    });
}

const offline = () => Promise.reject(new TypeError('Offline'));

beforeEach(() => vi.stubGlobal('crypto', webcrypto));

describe('SDK runtime resolution', () => {
    it('generates the SDK version from the package manifest', () => {
        expect(ENGINE_VERSION).toBe(packageInfo.version);
    });

    it('resolves once to immutable compiler URLs and retains the existing runtime cache key', async () => {
        const pair = fixture();
        const fetcher = network(pair);
        const resolved = await resolveRuntime({ fetch: fetcher });
        expect(resolved).toMatchObject({
            engineVersion: ENGINE_VERSION, releaseId: pair.descriptor.releaseId,
            texLiveYear: TEXLIVE_YEAR, baseUrl: pair.descriptor.baseUrl,
            wasmUrl: `${pair.descriptor.baseUrl}/wasm/busytex.wasm`,
            jsUrl: `${pair.descriptor.baseUrl}/wasm/busytex.js`,
            bundlesUrl: `${pair.descriptor.baseUrl}/bundles`,
            ctanProxyUrl: pair.descriptor.baseUrl, xzwasmUrl: `${pair.descriptor.baseUrl}/xzwasm.js`,
        });
        expect(fetcher.mock.calls.map(call => call[0])).toEqual([pointerUrl(), pair.descriptor.manifestUrl]);
        expect(new SiglumCompiler(resolved).runtimeKey).toBe(pair.descriptor.releaseId);
    });

    it('works without Cache Storage and with a local HTTP service', async () => {
        vi.stubGlobal('caches', undefined);
        const service = 'http://localhost:8787/packages';
        const pair = fixture(service);
        const resolved = await resolveRuntime({ baseUrl: `${service}/`, fetch: network(pair, service) });
        expect(resolved.baseUrl).toBe(pair.descriptor.baseUrl);
    });

    it('reopens from the verified descriptor and raw manifest when offline', async () => {
        const resolved = await resolveRuntime({ fetch: network() });
        expect(await resolveRuntime({ fetch: offline })).toEqual(resolved);
    });

    it('recovers a cached runtime on a transient server failure', async () => {
        const resolved = await resolveRuntime({ fetch: network() });
        const fetcher = vi.fn(async () => new Response('Unavailable', { status: 503 }));
        expect(await resolveRuntime({ fetch: fetcher })).toEqual(resolved);
    });

    it('does not fall back after a permanent pointer response or bad descriptor', async () => {
        await resolveRuntime({ fetch: network() });
        await expect(resolveRuntime({ fetch: async () => new Response('Missing', { status: 404 }) })).rejects.toThrow('HTTP 404');
        const pair = fixture();
        pair.descriptor.manifestSha256 = 'bad';
        await expect(resolveRuntime({ fetch: network(pair) })).rejects.toThrow('Invalid runtime descriptor');
    });

    it('rejects a descriptor for another SDK or service before fetching its manifest', async () => {
        for (const pair of [fixture(SERVICE, 1, '0.0.0-incompatible'), fixture('https://elsewhere.example')]) {
            const fetcher = network(pair);
            await expect(resolveRuntime({ fetch: fetcher })).rejects.toThrow(/descriptor|incompatible/);
            expect(fetcher).toHaveBeenCalledTimes(1);
        }
    });

    it('rejects unsupported descriptor schemas', async () => {
        const pair = fixture();
        const fetcher = async () => new Response(JSON.stringify({ ...pair.descriptor, schemaVersion: 2 }));
        await expect(resolveRuntime({ fetch: fetcher })).rejects.toThrow('Invalid runtime descriptor');
    });

    it('rejects manifest digest changes instead of silently using an older cache', async () => {
        const previous = await resolveRuntime({ fetch: network() });
        const pair = fixture();
        pair.manifestText += ' ';
        await expect(resolveRuntime({ fetch: network(pair) })).rejects.toThrow('SHA-256 mismatch');
        expect(await resolveRuntime({ fetch: offline })).toEqual(previous);
    });

    it('rejects manifest identities that disagree with the descriptor or installed SDK', async () => {
        const pair = fixture();
        pair.manifest.engineVersion = '0.0.0-incompatible';
        pair.manifestText = JSON.stringify(pair.manifest);
        pair.descriptor.manifestSha256 = digest(pair.manifestText);
        await expect(resolveRuntime({ fetch: network(pair) })).rejects.toThrow('manifest identity');
    });

    it('checks the content-addressed release identity as well as the manifest digest', async () => {
        const pair = fixture();
        pair.manifest.files['bundles.json'].size++;
        pair.manifestText = JSON.stringify(pair.manifest);
        pair.descriptor.manifestSha256 = digest(pair.manifestText);
        await expect(resolveRuntime({ fetch: network(pair) })).rejects.toThrow('release ID');
    });

    it('keeps the old verified pair if a new manifest cannot be downloaded', async () => {
        const previous = await resolveRuntime({ fetch: network() });
        const next = fixture(SERVICE, 2);
        const fetcher = vi.fn(async (url: RequestInfo | URL) => {
            if (url === pointerUrl()) return new Response(JSON.stringify(next.descriptor));
            return offline();
        });
        expect(await resolveRuntime({ fetch: fetcher })).toEqual(previous);
        expect(await resolveRuntime({ fetch: offline })).toEqual(previous);
    });

    it('replaces the cached pair only after verifying the new runtime', async () => {
        const previous = await resolveRuntime({ fetch: network() });
        const next = await resolveRuntime({ fetch: network(fixture(SERVICE, 2)) });
        expect(next.releaseId).not.toBe(previous.releaseId);
        expect(await resolveRuntime({ fetch: offline })).toEqual(next);
    });

    it('isolates cached resolutions by service and exact SDK', async () => {
        await resolveRuntime({ fetch: network() });
        await expect(resolveRuntime({ baseUrl: 'https://other.example', fetch: offline })).rejects.toThrow('Could not fetch');
        const cache = await caches.open(CACHE_NAME);
        const stored = await cache.match(pointerUrl());
        await cache.put(pointerUrl(SERVICE, '0.0.0-incompatible'), stored!);
        await cache.delete(pointerUrl());
        await expect(resolveRuntime({ fetch: offline })).rejects.toThrow('Could not fetch');
    });

    it('revalidates the cached digest before using it offline', async () => {
        await resolveRuntime({ fetch: network() });
        const cache = await caches.open(CACHE_NAME);
        const stored = await cache.match(pointerUrl());
        const pair = await stored!.json();
        pair.manifestText += ' ';
        await cache.put(pointerUrl(), new Response(JSON.stringify(pair)));
        await expect(resolveRuntime({ fetch: offline })).rejects.toThrow('SHA-256 mismatch');
    });

    it('rejects otherwise verified cached pairs from a different service or SDK', async () => {
        const cache = await caches.open(CACHE_NAME);
        for (const pair of [fixture('https://other.example'), fixture(SERVICE, 1, '0.0.0-incompatible')]) {
            await cache.put(pointerUrl(), new Response(JSON.stringify({
                descriptor: pair.descriptor, manifestText: pair.manifestText,
            })));
            await expect(resolveRuntime({ fetch: offline })).rejects.toThrow(/descriptor|incompatible/);
        }
    });

    it('returns verified network settings even when cache access is denied', async () => {
        const storage = { open: async () => { throw new Error('Denied'); } } as unknown as CacheStorage;
        expect((await resolveRuntime({ fetch: network(), cacheStorage: storage })).engineVersion).toBe(ENGINE_VERSION);
    });

    it('does not accept service query strings or credentials', async () => {
        for (const baseUrl of ['https://service.example/?key=secret', 'https://user:password@service.example']) {
            const fetcher = network();
            await expect(resolveRuntime({ baseUrl, fetch: fetcher })).rejects.toThrow('HTTP(S) URL');
            expect(fetcher).not.toHaveBeenCalled();
        }
    });
});
