import { expect, it, vi } from 'vitest';
import { mockFileSystem, setMockFile } from '../setup/mocks/filesystem';

vi.mock('@siglum/filesystem', () => ({ fileSystem: mockFileSystem }));

const release = 'https://packages.example/releases/tl2026-1234567890abcdef';
const otherRelease = 'https://packages.example/releases/tl2026-1234567890abcdee';
const indexPath = '/bundles/file-to-package.json';

function indexResponse(owner: string) {
    return new Response(JSON.stringify({ 'ngerman.ldf': owner }), {
        headers: { 'Content-Type': 'application/json' },
    });
}

it('restores cached Babel runfiles to a fresh worker with the exact warmed release index', async () => {
    vi.resetModules();
    const fetchMock = vi.fn().mockResolvedValueOnce(indexResponse('babel-german'))
        .mockResolvedValueOnce(indexResponse('different-owner'));
    vi.stubGlobal('fetch', fetchMock);
    const { SiglumCompiler } = await import('../../src/compiler.js');
    const warm = new SiglumCompiler({ ctanProxyUrl: release });
    const other = new SiglumCompiler({ ctanProxyUrl: otherRelease });
    expect(await warm.ctanFetcher.lookupPackageForFile('ngerman.ldf')).toBe('babel-german');
    expect(await other.ctanFetcher.lookupPackageForFile('ngerman.ldf')).toBe('different-owner');
    expect(fetchMock.mock.calls).toEqual([[release + indexPath], [otherRelease + indexPath]]);

    const path = '/texlive/texmf-dist/tex/generic/babel-german/';
    const definition = new Uint8Array([5, 8, 13]);
    const companion = new Uint8Array([3, 2, 1]);
    setMockFile(path + 'ngerman.ldf', definition);
    setMockFile(path + 'babel-german.def', companion);
    const { savePackageMeta, CTAN_CACHE_VERSION } = await import('../../src/storage.js');
    expect(await savePackageMeta('babel-german', {
        files: [path + 'ngerman.ldf', path + 'babel-german.def'],
        cacheVersion: CTAN_CACHE_VERSION,
        source: 'texlive-2026',
    })).toBe(true);

    // Reset module state without discarding origin storage, as a fresh tab does.
    vi.resetModules();
    fetchMock.mockClear().mockRejectedValue(new Error('origin disconnected'));
    const reopened = new (await import('../../src/compiler.js')).SiglumCompiler({ ctanProxyUrl: release });
    const postMessage = vi.fn();
    Object.assign(reopened, { worker: { postMessage } });
    await reopened._handleCtanFetchRequest({ requestId: 'known', packageName: 'ngerman', fileName: 'ngerman.ldf' });
    expect(postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
        type: 'ctan-fetch-response', requestId: 'known', success: true,
        files: { [path + 'ngerman.ldf']: definition, [path + 'babel-german.def']: companion },
    }), [expect.any(ArrayBuffer), expect.any(ArrayBuffer)]);
    await reopened._handleCtanFetchRequest({ requestId: 'typo', packageName: 'ngermam', fileName: 'ngermam.ldf' });
    expect(postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        type: 'ctan-fetch-response', requestId: 'typo', success: false,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
});

it('shares an in-flight miss and retries the exact index URL after a temporary failure', async () => {
    vi.resetModules();
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('origin disconnected'))
        .mockResolvedValueOnce(indexResponse('babel-german'));
    vi.stubGlobal('fetch', fetchMock);
    const { CTANFetcher } = await import('../../src/ctan.js');
    const first = new CTANFetcher({ proxyUrl: release });
    const second = new CTANFetcher({ proxyUrl: release });
    expect(await Promise.all([
        first.lookupPackageForFile('ngerman.ldf'), second.lookupPackageForFile('ngerman.ldf'),
    ])).toEqual([null, null]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await first.lookupPackageForFile('ngerman.ldf')).toBe('babel-german');
    expect(fetchMock.mock.calls).toEqual([[release + indexPath], [release + indexPath]]);
});

it('refreshes a mutable index online and restores that exact URL offline', async () => {
    const proxyUrl = 'https://packages.example';
    const fetchMock = vi.fn().mockResolvedValueOnce(indexResponse('previous-owner'))
        .mockResolvedValueOnce(indexResponse('babel-german')).mockRejectedValue(new Error('origin disconnected'));
    vi.stubGlobal('fetch', fetchMock);
    const loadInNewTab = async () => {
        vi.resetModules();
        const { CTANFetcher } = await import('../../src/ctan.js');
        return new CTANFetcher({ proxyUrl }).lookupPackageForFile('ngerman.ldf');
    };
    expect(await loadInNewTab()).toBe('previous-owner');
    expect(await loadInNewTab()).toBe('babel-german');
    expect(await loadInNewTab()).toBe('babel-german');
    expect(fetchMock.mock.calls).toEqual(Array.from({ length: 3 }, () => [proxyUrl + indexPath]));
});
