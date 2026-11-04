import { afterEach, expect, it, vi } from 'vitest';
import { BundleManager } from '../../src/bundles.js';
import { __resetStorageStateForTests, saveBundleToCache } from '../../src/storage.js';

afterEach(() => vi.unstubAllGlobals());

it('reopens the release manifest offline after the bundle cache has mounted', async () => {
    const releaseId = 'tl2026-' + crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    const bundleBase = '/releases/' + releaseId + '/bundles';
    const manifest = { '/texlive/example.sty': { bundle: 'core', start: 0, end: 4, size: 4 } };
    const bundles = { bundles: { core: {} }, packages: { example: 'core' } };
    const fetchManifest = vi.fn(async (url: string) => Response.json(
        url.endsWith('/file-manifest.json') ? manifest : bundles
    ));
    vi.stubGlobal('fetch', fetchManifest);

    const online = new BundleManager({ bundleBase });
    expect(await online.loadManifest()).toEqual(manifest);
    expect(fetchManifest).toHaveBeenCalledTimes(2);
    expect(await saveBundleToCache(releaseId + '-core', new Uint8Array([1, 2, 3, 4]).buffer)).toBe(true);

    // Simulate reopening: discard the in-memory cache and keep browser storage.
    __resetStorageStateForTests();
    fetchManifest.mockReset().mockRejectedValue(new Error('No network'));
    const offline = new BundleManager({ bundleBase });
    expect(await offline.loadManifest()).toEqual(manifest);
    expect(offline.packageMap).toEqual({ example: 'core' });
    expect(fetchManifest).not.toHaveBeenCalled();
});
