import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFileSystem, resetMockFileSystem, setMockFile } from '../setup/mocks/filesystem';

vi.mock('@siglum/filesystem', () => ({ fileSystem: mockFileSystem }));
const state = vi.hoisted(() => ({ meta: new Map<string, any>() }));
vi.mock('../../src/storage.js', () => ({
    CTAN_CACHE_VERSION: 12,
    ensureTexliveMounted: vi.fn().mockResolvedValue(true),
    getPackageMeta: vi.fn(async (name: string) => state.meta.get(name) || null),
    savePackageMeta: vi.fn(async (name: string, meta: any) => {
        state.meta.set(name, structuredClone(meta));
        return true;
    }),
}));
import { CTANFetcher, forceRefreshPackage } from '../../src/ctan.js';
import { ensureTexliveMounted, getPackageMeta, savePackageMeta } from '../../src/storage.js';

const path = '/texlive/texmf-dist/tex/latex/cache-test/cache-test.sty';
const bytes = (value: string) => new TextEncoder().encode(value);
const response = (content: string) => new Response(JSON.stringify({
    files: { [path]: { content } }, dependencies: [],
}), { headers: { 'Content-Type': 'application/json' } });
const createFetcher = () => new CTANFetcher({ proxyUrl: 'https://cache-test.invalid' });

describe('package cache recovery and version isolation', () => {
    beforeEach(() => {
        resetMockFileSystem();
        state.meta.clear();
        vi.clearAllMocks();
        vi.stubGlobal('crypto', webcrypto);
        vi.mocked(ensureTexliveMounted).mockResolvedValue(true);
        vi.mocked(getPackageMeta).mockImplementation(async name => state.meta.get(name) || null);
        vi.mocked(savePackageMeta).mockImplementation(async (name, meta) => {
            state.meta.set(name, structuredClone(meta));
            return true;
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    });

    it.each(['network', 503])('recovers after a transient %s failure without clearing storage', async failure => {
        const fetcher = createFetcher();
        vi.spyOn(fetcher, 'lookupPackageForFile').mockResolvedValue(null);
        const fetchMock = vi.mocked(fetch);
        if (failure === 'network') fetchMock.mockRejectedValue(new TypeError('offline'));
        else fetchMock.mockResolvedValue(new Response('', { status: failure as number }));
        expect(await fetcher.fetchCtanPackage('cache-test')).toBeNull();
        expect(state.meta.size).toBe(0);
        fetchMock.mockImplementation(async () => response('online'));
        expect((await fetcher.fetchCtanPackage('cache-test'))?.files.get(path)).toEqual(bytes('online'));
        fetchMock.mockRejectedValue(new TypeError('offline'));
        const reopened = await createFetcher().fetchPackage('cache-test');
        expect(reopened?.files.get(path)).toEqual(bytes('online'));
    });

    it('expires confirmed absence, scopes it to the provider, and ignores legacy negatives', async () => {
        const fetcher = createFetcher();
        vi.spyOn(fetcher, 'lookupPackageForFile').mockResolvedValue(null);
        expect(await fetcher.fetchCtanPackage('absent')).toBeNull();
        expect((await fetcher.loadPackageFromCache('absent'))?.notFound).toBe(true);
        const other = new CTANFetcher({ proxyUrl: 'https://another.invalid' });
        expect(await other.loadPackageFromCache('absent')).toBeNull();
        state.meta.get('pkg-v1-2026-absent').checkedAt = Date.now() - 6 * 60 * 1000;
        expect(await fetcher.loadPackageFromCache('absent')).toBeNull();
        state.meta.set('legacy', { notFound: true, cacheVersion: 12 });
        expect(await fetcher.loadPackageFromCache('legacy')).toBeNull();
    });

    it('keeps historical fallback bytes out of the current tree and reopens both versions offline', async () => {
        const fetcher = createFetcher();
        vi.mocked(fetch).mockImplementation(async url => response(String(url).includes('tlYear=2024') ? 'old' : 'current'));
        await fetcher.fetchCtanPackage('cache-test');
        await fetcher.fetchCtanPackage('cache-test', 2024);
        expect(fetcher.getCachedFiles()[path]).toEqual(bytes('current'));
        vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
        const reopened = createFetcher();
        expect((await reopened.fetchPackage('cache-test', { tlYear: 2024 }))?.files.get(path)).toEqual(bytes('old'));
        expect(reopened.getCachedFiles()[path]).toBeUndefined();
        expect((await reopened.fetchPackage('cache-test'))?.files.get(path)).toEqual(bytes('current'));
        expect(reopened.getCachedFiles()[path]).toEqual(bytes('current'));
    });

    it('preserves a previous complete package when one refresh write fails', async () => {
        const fetcher = createFetcher();
        vi.mocked(fetch).mockImplementation(async () => response('before'));
        await fetcher.fetchCtanPackage('cache-test');
        const original = structuredClone(state.meta.get('pkg-v1-2026-cache-test'));
        mockFileSystem.writeBinary.mockRejectedValueOnce(new Error('quota exceeded'));
        vi.mocked(fetch).mockImplementation(async () => response('after'));
        expect((await fetcher.fetchCtanPackage('cache-test'))?.files.get(path)).toEqual(bytes('after'));
        expect(state.meta.get('pkg-v1-2026-cache-test')).toEqual(original);
        vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
        expect((await createFetcher().fetchPackage('cache-test'))?.files.get(path)).toEqual(bytes('before'));
    });

    it('repairs an incomplete legacy package instead of returning a partial cache hit', async () => {
        state.meta.set('cache-test', { cacheVersion: 12, files: [path, path + '2'], dependencies: [] });
        setMockFile(path, 'survives');
        const fetcher = createFetcher();
        expect(await fetcher.loadPackageFromCache('cache-test')).toBeNull();
        expect(fetcher.getCachedFiles()).toEqual({});
        vi.spyOn(fetcher, 'fetchTexLivePackage').mockResolvedValue({ files: new Map([[path, bytes('repaired')]]), dependencies: [] });
        expect((await fetcher.fetchPackage('cache-test'))?.files.get(path)).toEqual(bytes('repaired'));
        expect(await mockFileSystem.readFile(path)).toBe('survives');
    });

    it('keeps complete legacy packages available offline and invalidates both metadata schemes on refresh', async () => {
        state.meta.set('cache-test', { cacheVersion: 12, files: [path], dependencies: [] });
        setMockFile(path, 'legacy');
        vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
        expect((await createFetcher().fetchPackage('cache-test'))?.files.get(path)).toEqual(bytes('legacy'));
        expect(await forceRefreshPackage('cache-test')).toBe(true);
        expect(await createFetcher().loadPackageFromCache('cache-test')).toBeNull();
        expect(savePackageMeta).toHaveBeenCalledWith('pkg-v1-2026-cache-test', expect.objectContaining({ cacheVersion: 0 }));
        expect(await mockFileSystem.readFile(path)).toBe('legacy');
    });
    it('shares an in-flight package request and releases failures for a later retry', async () => {
        const fetcher = createFetcher();
        let complete: (result: any) => void;
        const request = vi.spyOn(fetcher, '_fetchPackage').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
        const first = fetcher.fetchPackage('cache-test'), second = fetcher.fetchPackage('cache-test');
        expect(request).toHaveBeenCalledTimes(1);
        complete!(null);
        expect(await first).toBeNull();expect(await second).toBeNull();
        request.mockResolvedValue({ files: new Map([[path, bytes('recovered')]]), dependencies: [] });
        expect((await fetcher.fetchPackage('cache-test'))?.files.get(path)).toEqual(bytes('recovered'));
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('does not share simultaneous requests for different TeX Live years', async () => {
        const fetcher = createFetcher();
        const request = vi.spyOn(fetcher, '_fetchPackage').mockResolvedValue(null);
        await Promise.all([fetcher.fetchPackage('cache-test'), fetcher.fetchPackage('cache-test', { tlYear: 2024 })]);
        expect(request).toHaveBeenCalledTimes(2);
        expect(fetcher.packageFetches.size).toBe(0);
    });

    it('does not serve the default CTAN fallback as an explicitly requested current-year TeX Live archive', async () => {
        const fetcher = createFetcher();
        vi.mocked(fetch).mockImplementation(async url => response(String(url).includes('tlYear=2026') ? 'texlive archive' : 'ctan fallback'));
        await fetcher.fetchCtanPackage('cache-test');
        await fetcher.fetchCtanPackage('cache-test', 2026);
        vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
        expect((await createFetcher().fetchPackage('cache-test'))?.files.get(path)).toEqual(bytes('ctan fallback'));
        expect((await createFetcher().fetchPackage('cache-test', { tlYear: 2026 }))?.files.get(path)).toEqual(bytes('texlive archive'));
        const reopened = createFetcher();
        await reopened.batchFetchPackages(['cache-test'], { tlYear: 2026 });
        expect(reopened.getCachedFiles()).toEqual({});
        expect(reopened.loadedPackages.size).toBe(0);
    });

});
