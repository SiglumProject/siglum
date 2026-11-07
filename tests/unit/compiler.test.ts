/**
 * Tests for compiler.js - Main SiglumCompiler class.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMockFile, mockFileSystem, resetMockFileSystem, setMockFile } from '../setup/mocks/filesystem';
import { MockCompilerWorker, configureCompileScenario } from '../setup/mocks/worker';
import {
    SIMPLE_DOCUMENT,
    XELATEX_DOCUMENT,
    DOCUMENT_WITH_PACKAGE,
} from '../setup/fixtures/latex-samples';

const KOMA_EXTENDED_DOCUMENT = SIMPLE_DOCUMENT.replace('\\documentclass{article}', '\\documentclass[9pt]{scrartcl}');

// Create mock bundle manager factory
const createMockBundleManager = () => ({
    bundleBase: 'packages/bundles',
    bundleCache: new Map(),
    fileManifest: { 'base/article.cls': 'base' },
    packageMap: { 'article': 'base' },
    bundleDeps: {
        engines: { pdflatex: ['base'], xelatex: ['base', 'fontspec'] },
        bundles: {},
        deferred: ['cm-super'],
    },
    bundleRegistry: new Set(['base', 'amsmath', 'fontspec']),
    onLog: vi.fn(),
    loadManifest: vi.fn().mockResolvedValue({ 'base/article.cls': 'base' }),
    loadBundleDeps: vi.fn().mockResolvedValue({ pdflatex: ['base'], xelatex: ['base', 'fontspec'] }),
    bundleExists: vi.fn().mockReturnValue(true),
    resolveBundles: vi.fn().mockReturnValue(['base']),
    checkPackages: vi.fn().mockReturnValue({ packages: ['article'], bundles: ['base'] }),
    prescanForCtanPackages: vi.fn().mockReturnValue({
        bundledPackages: ['article'],
        ctanPackages: [],
        additionalBundles: [],
    }),
    loadBundle: vi.fn().mockResolvedValue(new ArrayBuffer(1000)),
    loadBundles: vi.fn().mockResolvedValue({ base: new ArrayBuffer(1000) }),
    preloadEngine: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn(),
    getStats: vi.fn().mockReturnValue({ bytesDownloaded: 0, cacheHits: 0 }),
});

// Create mock CTAN fetcher factory
const createMockCTANFetcher = () => ({
    proxyUrl: 'http://localhost:8787',
    mountedFiles: new Set(),
    fileCache: new Map(),
    loadedPackages: new Set(),
    fetchCount: 0,
    onLog: vi.fn(),
    loadFileToPackageIndex: vi.fn().mockResolvedValue({}),
    lookupPackageForFile: vi.fn().mockResolvedValue(null),
    getCachedFiles: vi.fn().mockReturnValue({}),
    fetchPackage: vi.fn().mockResolvedValue(null),
    batchFetchPackages: vi.fn().mockResolvedValue({ fetched: [], failed: [], skipped: [] }),
    getMountedFiles: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({ fetchCount: 0, mountedFiles: 0 }),
    clearMountedFiles: vi.fn(),
});

// Mock modules - these must be hoisted
// Use async import inside factory since vi.mock is hoisted before imports
vi.mock('@siglum/filesystem', async () => {
    const { mockFileSystem } = await import('../setup/mocks/filesystem');
    return { fileSystem: mockFileSystem };
});

vi.mock('../../src/storage.js', () => ({
    getBundleFromCache: vi.fn().mockResolvedValue(null),
    getAuxCache: vi.fn().mockResolvedValue(null),
    saveAuxCache: vi.fn().mockResolvedValue(undefined),
    getCachedPdf: vi.fn().mockResolvedValue(null),
    saveCachedPdf: vi.fn().mockResolvedValue(undefined),
    hashDocument: vi.fn().mockReturnValue('mockhash'),
    getFmtPath: vi.fn().mockReturnValue('fmt-cache/test.fmt'),
    clearCTANCache: vi.fn().mockResolvedValue(true),
    saveWasmMemorySnapshot: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/bundles.js', async (importOriginal) => {
    const { getKomaExtendedSize } = await importOriginal<typeof import('../../src/bundles.js')>();
    // Define mock factory inline since vi.mock is hoisted
    const createMockBundleManager = () => ({
        bundleBase: 'packages/bundles',
        bundleCache: new Map(),
        fileManifest: { 'base/article.cls': 'base' },
        packageMap: { 'article': 'base' },
        bundleDeps: {
            engines: { pdflatex: ['base'], xelatex: ['base', 'fontspec'] },
            bundles: {},
            deferred: ['cm-super'],
        },
        bundleRegistry: new Set(['base', 'amsmath', 'fontspec']),
        onLog: vi.fn(),
        loadManifest: vi.fn().mockResolvedValue({ 'base/article.cls': 'base' }),
        loadBundleDeps: vi.fn().mockResolvedValue({ pdflatex: ['base'], xelatex: ['base', 'fontspec'] }),
        bundleExists: vi.fn().mockReturnValue(true),
        resolveBundles: vi.fn().mockReturnValue(['base']),
        checkPackages: vi.fn().mockReturnValue({ packages: ['article'], bundles: ['base'] }),
        prescanForCtanPackages: vi.fn().mockReturnValue({
            bundledPackages: ['article'],
            ctanPackages: [],
            additionalBundles: [],
        }),
        loadBundle: vi.fn().mockResolvedValue(new ArrayBuffer(1000)),
        loadBundles: vi.fn().mockResolvedValue({ base: new ArrayBuffer(1000) }),
        preloadEngine: vi.fn().mockResolvedValue(undefined),
        clearCache: vi.fn(),
        getStats: vi.fn().mockReturnValue({ bytesDownloaded: 0, cacheHits: 0 }),
    });

    return {
        BundleManager: vi.fn().mockImplementation(() => createMockBundleManager()),
        detectEngine: vi.fn().mockReturnValue('pdflatex'),
        extractPreamble: vi.fn().mockReturnValue('\\documentclass{article}'),
        getKomaExtendedSize,
        hashPreamble: vi.fn().mockReturnValue('preamblehash'),
    };
});

vi.mock('../../src/ctan.js', () => {
    // Define mock factory inline since vi.mock is hoisted
    const createMockCTANFetcher = () => ({
        proxyUrl: 'http://localhost:8787',
        mountedFiles: new Set(),
        fileCache: new Map(),
        loadedPackages: new Set(),
        fetchCount: 0,
        onLog: vi.fn(),
        loadFileToPackageIndex: vi.fn().mockResolvedValue({}),
        lookupPackageForFile: vi.fn().mockResolvedValue(null),
        getCachedFiles: vi.fn().mockReturnValue({}),
        fetchPackage: vi.fn().mockResolvedValue(null),
        batchFetchPackages: vi.fn().mockResolvedValue({ fetched: [], failed: [], skipped: [] }),
        getMountedFiles: vi.fn().mockReturnValue([]),
        getStats: vi.fn().mockReturnValue({ fetchCount: 0, mountedFiles: 0 }),
        clearMountedFiles: vi.fn(),
    });

    return {
        CTANFetcher: vi.fn().mockImplementation(() => createMockCTANFetcher()),
    };
});

// Import after mocks
import { SiglumCompiler, BusyTeXCompiler } from '../../src/compiler.js';
import { getBundleFromCache } from '../../src/storage.js';
import { BundleManager } from '../../src/bundles.js';
import { CTANFetcher } from '../../src/ctan.js';

describe('compiler module', () => {
    let compiler: SiglumCompiler;
    let fetchMock: ReturnType<typeof vi.fn>;
    let workerInstances: MockCompilerWorker[] = [];

    // Helper to convert URL or string to string for comparisons
    const urlToString = (url: string | URL): string => {
        if (url instanceof URL) return url.toString();
        return url;
    };

    beforeEach(() => {
        resetMockFileSystem();
        vi.clearAllMocks();
        workerInstances = [];

        // Reset mocks to return fresh instances
        vi.mocked(BundleManager).mockImplementation(() => createMockBundleManager() as any);
        vi.mocked(CTANFetcher).mockImplementation(() => createMockCTANFetcher() as any);

        // Mock fetch - handle both string and URL objects
        fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
            const urlStr = urlToString(url);
            if (urlStr.includes('busytex.wasm')) {
                return {
                    ok: true,
                    clone: () => ({
                        ok: true,
                        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
                    }),
                    arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
                };
            }
            if (urlStr.includes('worker.js')) {
                return {
                    ok: true,
                    text: () => Promise.resolve('// mock worker code'),
                };
            }
            return { ok: false, status: 404 };
        });
        vi.stubGlobal('fetch', fetchMock);

        // Mock Worker constructor
        vi.stubGlobal('Worker', class extends MockCompilerWorker {
            constructor(url: string | URL) {
                super(url);
                workerInstances.push(this);
            }
        });

        // Mock WebAssembly
        vi.stubGlobal('WebAssembly', {
            compile: vi.fn().mockResolvedValue({ _mockModule: true }),
            compileStreaming: vi.fn().mockResolvedValue({ _mockModule: true }),
            Memory: class { buffer = new ArrayBuffer(1024); },
        });

        // Mock caches API
        const mockCache = {
            match: vi.fn().mockResolvedValue(undefined),
            put: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(true),
        };
        vi.stubGlobal('caches', {
            open: vi.fn().mockResolvedValue(mockCache),
        });

        // Mock URL.createObjectURL and revokeObjectURL
        vi.stubGlobal('URL', class extends URL {
            static createObjectURL = vi.fn().mockReturnValue('blob:mock-worker-url');
            static revokeObjectURL = vi.fn();
        });

        compiler = new SiglumCompiler({
            bundlesUrl: 'http://test.com/bundles',
            wasmUrl: 'http://test.com/busytex.wasm',
            onLog: vi.fn(),
            onProgress: vi.fn(),
        });
    });

    afterEach(() => {
        // Always restore real timers: a test that enables fake timers and then
        // throws/times out before its own useRealTimers() would otherwise poison
        // every subsequent test (their setTimeout-based waits would never fire).
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        compiler?.terminate();
    });

    describe('constructor', () => {
        it('should set default options', () => {
            const defaultCompiler = new SiglumCompiler();
            expect(defaultCompiler.bundlesUrl).toBe('packages/bundles');
            expect(defaultCompiler.wasmUrl).toBe('busytex.wasm');
        });

        it('should accept custom options', () => {
            expect(compiler.bundlesUrl).toBe('http://test.com/bundles');
            expect(compiler.wasmUrl).toBe('http://test.com/busytex.wasm');
        });

        it('should initialize with CTAN disabled by default when no proxy', () => {
            const c = new SiglumCompiler();
            expect(c.enableCtan).toBe(false);
        });

        it('should enable CTAN when proxy URL provided', () => {
            const c = new SiglumCompiler({ ctanProxyUrl: 'http://proxy' });
            expect(c.enableCtan).toBe(true);
        });

        it('should enable lazy filesystem by default', () => {
            const c = new SiglumCompiler();
            expect(c.enableLazyFS).toBe(true);
        });

        it('should enable doc cache by default', () => {
            const c = new SiglumCompiler();
            expect(c.enableDocCache).toBe(true);
        });

        it('should set max retries', () => {
            const c = new SiglumCompiler({ maxRetries: 5 });
            expect(c.maxRetries).toBe(5);
        });

        it('should initialize worker as null', () => {
            expect(compiler.worker).toBeNull();
        });
    });

    describe('getEagerBundles', () => {
        it('should return empty array by default', () => {
            const bundles = compiler.getEagerBundles('pdflatex');
            expect(bundles).toEqual([]);
        });

        it('should return array for all engines when array provided', () => {
            const c = new SiglumCompiler({ eagerBundles: ['cm-super'] });
            expect(c.getEagerBundles('pdflatex')).toEqual(['cm-super']);
            expect(c.getEagerBundles('xelatex')).toEqual(['cm-super']);
        });

        it('should return per-engine config when object provided', () => {
            const c = new SiglumCompiler({
                eagerBundles: {
                    pdflatex: ['cm-super'],
                    xelatex: ['fontspec'],
                },
            });
            expect(c.getEagerBundles('pdflatex')).toEqual(['cm-super']);
            expect(c.getEagerBundles('xelatex')).toEqual(['fontspec']);
            expect(c.getEagerBundles('lualatex')).toEqual([]);
        });
    });

    it('reuses exact cached font ranges and leaves uncached ranges for discovery', async () => {
        await compiler.init();
        const worker = compiler.worker!;
        const messages = vi.spyOn(worker, 'postMessage');
        const network = vi.spyOn(compiler, '_fetchCoalescedRange');
        Object.assign(compiler.bundleManager, { cachePrefix: '', getBundleHash: () => 'test' });
        vi.mocked(getBundleFromCache).mockResolvedValueOnce(new ArrayBuffer(8)).mockResolvedValueOnce(null);
        compiler._pendingRangeRequests.set('fonts-cm', [
            { requestId: 'cached', start: 10, end: 18, cacheOnly: true },
            { requestId: 'missing', start: 30, end: 40, cacheOnly: true },
        ]);

        await compiler._processRangeRequestBatch();
        expect(network).not.toHaveBeenCalled();
        expect(messages).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'cached', success: true }), expect.any(Array));
        expect(messages).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'missing', success: false }), []);
    });

    describe('CM-Super range capability', () => {
        it('loads the full bundle with an older worker', () => {
            compiler.workerRangeFonts = true;
            expect(compiler._getEffectiveEagerBundles('pdflatex')).toEqual(['cm-super']);
            expect(compiler._selectRangeFontBundles('pdflatex', ['base', 'cm-super'])).toEqual([]);
            expect(compiler._getEffectiveEagerBundles('xelatex')).toEqual([]);
        });

        it('defers CM-Super only on the capable pdfLaTeX worker', () => {
            compiler.workerRangeFonts = true;
            compiler.workerCmSuperRanges = true;
            expect(compiler._getEffectiveEagerBundles('pdflatex')).toEqual([]);
            expect(compiler._selectRangeFontBundles('pdflatex', ['base'])).toEqual(['cm-super']);
            expect(compiler._selectRangeFontBundles('xelatex', ['base'])).toEqual([]);
        });

        it('keeps explicit eager and disabled-lazy policies', () => {
            const explicit = new SiglumCompiler({ eagerBundles: ['cm-super'] });
            explicit.workerRangeFonts = true;
            explicit.workerCmSuperRanges = true;
            expect(explicit._getEffectiveEagerBundles('pdflatex')).toEqual(['cm-super']);
            expect(explicit._selectRangeFontBundles('pdflatex', ['base', 'cm-super'])).toEqual([]);

            const noLazy = new SiglumCompiler({ enableLazyFS: false });
            noLazy.workerRangeFonts = true;
            noLazy.workerCmSuperRanges = true;
            expect(noLazy._getEffectiveEagerBundles('pdflatex')).toEqual(['cm-super']);

            const lowRetry = new SiglumCompiler({ maxRetries: 1 });
            lowRetry.workerRangeFonts = true;
            lowRetry.workerCmSuperRanges = true;
            expect(lowRetry._getEffectiveEagerBundles('pdflatex')).toEqual(['cm-super']);

            const disabled = new SiglumCompiler({ rangeFontBundles: [] });
            expect(disabled._getEffectiveEagerBundles('pdflatex')).toEqual([]);
        });
    });

    describe('isReady', () => {
        it('should return false initially', () => {
            expect(compiler.isReady()).toBe(false);
        });

        it('should return true after init', async () => {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;

            expect(compiler.isReady()).toBe(true);
        });
    });

    describe('isLoaded', () => {
        it('should return false initially', () => {
            expect(compiler.isLoaded()).toBe(false);
        });

        it('should return true after init', async () => {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;

            expect(compiler.isLoaded()).toBe(true);
        });
    });

    describe('per-engine bootstrap', () => {
        it.each(['pdflatex', 'xelatex'] as const)('fetches only the initial %s runtime and marks worker ownership correctly', async initialEngine => {
            const runtime = { identity: 'bootstrap-test', apiUrl: 'http://test.com/api.mjs', jsUrl: 'http://test.com/pdftex.js', wasmUrl: 'http://test.com/pdftex.wasm' };
            compiler = new SiglumCompiler({ wasmUrl: 'http://test.com/busytex.wasm', checkpointRuntime: runtime, initialEngine });
            const fetches: string[] = [];
            const prior = fetchMock.getMockImplementation()!;
            fetchMock.mockImplementation(async url => {
                const name = String(url); fetches.push(name);
                if (name === runtime.wasmUrl) return { ok: true, clone: () => ({ ok: true }), arrayBuffer: async () => new ArrayBuffer(100) };
                return prior(url);
            });
            const messages: any[] = [];
            vi.stubGlobal('Worker', class extends MockCompilerWorker {
                constructor(url: string | URL) { super(url); workerInstances.push(this); }
                postMessage(message: unknown, transfer?: Transferable[]) { messages.push(message); super.postMessage(message, transfer); }
            });
            await compiler.init();
            expect(fetches.filter(url => url.endsWith('.wasm'))).toEqual([initialEngine === 'pdflatex' ? runtime.wasmUrl : 'http://test.com/busytex.wasm']);
            const init = messages.find(message => message.type === 'init');
            expect(init.initialEngine).toBe(initialEngine);
            expect(Boolean(init.wasmModule)).toBe(initialEngine === 'xelatex');
            expect(Boolean(init.checkpointRuntime.wasmModule)).toBe(initialEngine === 'pdflatex');
        });
    });

    describe('init', () => {
        it('should load WASM and initialize worker', async () => {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;

            expect(compiler.worker).not.toBeNull();
            expect(compiler.workerReady).toBe(true);
        });

        it('should load manifests', async () => {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;

            expect(compiler.bundleManager.loadManifest).toHaveBeenCalled();
        });

        it('should return existing promise if already initializing', async () => {
            const initPromise1 = compiler.init();
            const initPromise2 = compiler.init();

            // They should be the same promise object
            expect(initPromise1).toBe(initPromise2);

            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });

            await Promise.all([initPromise1, initPromise2]);
        });

        function holdWorkerReady() {
            vi.stubGlobal('Worker', class extends MockCompilerWorker {
                constructor(url: string | URL) {
                    super(url);
                    this.setHandler('init', () => null);
                    workerInstances.push(this);
                }
            });
        }

        it('rejects initialization on a worker script error and allows a clean retry', async () => {
            holdWorkerReady();
            const first = compiler.init().catch(error => error);
            await vi.waitFor(() => expect(workerInstances).toHaveLength(1));
            workerInstances[0].sendError(new Error('Worker script blocked'));
            const error = await Promise.race([first, new Promise(resolve => setTimeout(resolve, 80))]);
            expect(error).toEqual(new Error('Worker initialization failed: Worker script blocked'));
            expect(compiler.worker).toBeNull();
            expect(compiler.workerReady).toBe(false);
            expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
            expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-worker-url');

            const retry = compiler.init();
            await vi.waitFor(() => expect(workerInstances).toHaveLength(2));
            workerInstances[1].sendResponse({ type: 'ready' });
            await retry;
            expect(compiler.worker).toBe(workerInstances[1]);
            expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
        });

        it('joins a background initialization before the worker assets are ready', async () => {
            holdWorkerReady();
            const manifest = { 'base/article.cls': 'base' };
            let finishManifest!: (value: typeof manifest) => void;
            vi.mocked(compiler.bundleManager.loadManifest).mockImplementationOnce(() =>
                new Promise(resolve => { finishManifest = resolve; }));
            const warming = compiler.prewarm();
            const compilation = compiler.compile(SIMPLE_DOCUMENT);
            try {
                await new Promise(resolve => setTimeout(resolve, 25));
                expect(workerInstances).toHaveLength(0);
            } finally {
                finishManifest(manifest);
            }
            await vi.waitFor(() => expect(workerInstances).toHaveLength(1));
            workerInstances[0].sendResponse({ type: 'ready' });
            await warming;
            await expect(compilation).resolves.toMatchObject({ success: true });
        });

        it('holds an early compile until worker readiness has been reported', async () => {
            holdWorkerReady();
            const initialization = compiler.init();
            await vi.waitFor(() => expect(workerInstances).toHaveLength(1));
            const worker = workerInstances[0];
            const post = vi.spyOn(worker, 'postMessage');
            const compilation = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(resolve => setTimeout(resolve, 25));
            expect(post.mock.calls.every(([message]) => (message as { type: string }).type !== 'compile')).toBe(true);
            worker.sendResponse({ type: 'ready' });
            await initialization;
            await expect(compilation).resolves.toMatchObject({ success: true });
        });

        it('cancels a pending worker handshake without disturbing a new initialization', async () => {
            holdWorkerReady();
            const old = compiler.init().catch(error => error);
            await vi.waitFor(() => expect(workerInstances).toHaveLength(1));
            const staleHandler = workerInstances[0].onmessage!;
            compiler.terminate();
            const fresh = compiler.init();
            await vi.waitFor(() => expect(workerInstances).toHaveLength(2));
            staleHandler(new MessageEvent('message', { data: { type: 'ready' } }));
            expect(compiler.workerReady).toBe(false);
            expect(await old).toEqual(new Error('Compiler worker terminated'));
            workerInstances[1].sendResponse({ type: 'ready' });
            await fresh;
            expect(compiler.worker).toBe(workerInstances[1]);
        });

        it('settles the former owner when a second compiler takes the global worker slot', async () => {
            holdWorkerReady();
            const displaced = compiler.init().catch(error => error);
            await vi.waitFor(() => expect(workerInstances).toHaveLength(1));
            const replacement = new SiglumCompiler({
                bundlesUrl: 'http://test.com/bundles',
                wasmUrl: 'http://test.com/busytex.wasm',
                workerUrl: '/worker.js',
            });
            try {
                const next = replacement.init();
                await vi.waitFor(() => expect(workerInstances).toHaveLength(2));
                workerInstances[1].sendResponse({ type: 'ready' });
                await next;
                const error = await Promise.race([displaced, new Promise(resolve => setTimeout(resolve, 80))]);
                expect(error).toEqual(new Error('Compiler worker terminated'));
                expect(compiler.worker).toBeNull();
                expect(compiler.workerReady).toBe(false);
                expect(replacement.worker).toBe(workerInstances[1]);
            } finally {
                replacement.terminate();
            }
        });
    });

    describe('prewarm', () => {
        it('should call init', async () => {
            const initPromise = compiler.prewarm();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;

            expect(compiler.isReady()).toBe(true);
        });

        it('should return existing promise on subsequent calls', async () => {
            const prewarm1 = compiler.prewarm();
            const prewarm2 = compiler.prewarm();

            // They should be the same promise object
            expect(prewarm1).toBe(prewarm2);

            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });

            await Promise.all([prewarm1, prewarm2]);
        });
    });

    describe('compile', () => {
        async function initCompiler() {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;
        }

        it('loads local preamble bundles when CTAN fetching is disabled', async () => {
            compiler.enableCtan = false;
            await initCompiler();
            vi.mocked(compiler.bundleManager.prescanForCtanPackages).mockReturnValueOnce({
                bundledPackages: ['article', 'hyperref'],
                ctanPackages: ['xstring'],
                additionalBundles: ['hyperref'],
            });
            const post = vi.spyOn(workerInstances[0], 'postMessage');
            const additionalFiles = { 'local.cls': '\\LoadClass{article}\\RequirePackage{hyperref,xstring}' };
            const source = '\\documentclass{local}\\begin{document}Hello\\end{document}';

            expect((await compiler.compile(source, { additionalFiles })).success).toBe(true);
            expect(post).toHaveBeenCalledWith(expect.objectContaining({
                type: 'compile',
                bundleNames: expect.arrayContaining(['base', 'hyperref']),
            }), expect.any(Array));
            expect(compiler.ctanFetcher.batchFetchPackages).not.toHaveBeenCalled();
        });

        it('resends mutated bytes and recovers from a stale project snapshot', async () => {
            await initCompiler();
            compiler.workerProjectFileDeltas = true;
            const requests: any[] = [];
            let resetNext = false;
            workerInstances[0]?.setHandler('compile', message => {
                const request = message as any;
                requests.push(request.projectFiles);
                if (resetNext) {
                    resetNext = false;
                    return { type: 'compile-response', id: request.id, success: false,
                        projectFilesNeedReset: true, error: 'Snapshot reset needed' };
                }
                return {
                    type: 'compile-response', id: request.id, success: true,
                    projectFileRevision: request.id,
                    pdfData: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                };
            });

            const asset = new Uint8Array([1, 2]);
            const options = { additionalFiles: { 'asset.bin': asset, 'chapter.tex': 'Chapter' } };
            expect((await compiler.compile(SIMPLE_DOCUMENT, options)).success).toBe(true);
            asset[1] = 3;
            expect((await compiler.compile(SIMPLE_DOCUMENT, options)).success).toBe(true);
            expect(Object.keys(requests[1].changed)).toEqual(['/asset.bin']);
            expect([...requests[1].changed['/asset.bin']]).toEqual([1, 3]);

            resetNext = true;
            expect((await compiler.compile(SIMPLE_DOCUMENT, options)).success).toBe(true);
            expect(Object.keys(requests[2].changed)).toEqual([]);
            expect(requests[3].baseRevision).toBeNull();
            expect(Object.keys(requests[3].changed)).toEqual(['/asset.bin', '/chapter.tex']);
        });

        it('should return cached PDF if available', async () => {
            const { getCachedPdf } = await import('../../src/storage.js');
            vi.mocked(getCachedPdf).mockResolvedValueOnce(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

            await initCompiler();
            const result = await compiler.compile(SIMPLE_DOCUMENT);

            expect(result.cached).toBe(true);
            expect(result.pdf).toBeDefined();
        });

        it('compiles an extended KOMA class without reading or writing stale PDF and format caches', async () => {
            const { getCachedPdf, saveCachedPdf } = await import('../../src/storage.js');
            await initCompiler();
            await mockFileSystem.writeBinary('/fmt-cache/test.fmt', new Uint8Array([42]), { createParents: true });
            const post = vi.spyOn(workerInstances[0], 'postMessage');

            expect((await compiler.compile(KOMA_EXTENDED_DOCUMENT)).success).toBe(true);

            expect(getCachedPdf).not.toHaveBeenCalled();
            expect(saveCachedPdf).not.toHaveBeenCalled();
            expect(mockFileSystem.readBinary).not.toHaveBeenCalledWith('/fmt-cache/test.fmt');
            expect(post).toHaveBeenCalledWith(expect.objectContaining({
                type: 'compile',
                cachedFormat: null,
            }), expect.any(Array));
        });

        it('retries only the diagnosed pinned Chemfig setter failure and keeps supplied packages untouched', async () => {
            await initCompiler();
            const source = [
                '\\documentclass{article}',
                '\\usepackage{chemfig}',
                '\\begin{document}',
                '\\setatomsep{1.5em}',
                '\\chemfig{A-\\lewis{0.,O}}',
                '\\end{document}',
            ].join('\n');
            const log = 'Package: chemfig 2025/10/30 v1.71 Draw molecule with an easy syntax (CT)\n'
                + '/document.tex:4: Undefined control sequence.\nl.4 \\setatomsep\n{1.5em}\n';
            const requests: string[] = [];
            let retryFails = false;
            workerInstances[0].setHandler('compile', message => {
                const request = message as { id: string; source: string };
                requests.push(request.source);
                if (request.source === source) {
                    return { type: 'compile-response', id: request.id, success: false, error: 'Original Chemfig error', log };
                }
                if (retryFails) {
                    return { type: 'compile-response', id: request.id, success: false, error: 'Unrelated retry error' };
                }
                return { type: 'compile-response', id: request.id, success: true,
                    pdfData: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, syncTexData: 'fresh' };
            });

            const recovered = await compiler.compile(source);
            expect(recovered).toMatchObject({ success: true, syncTexData: 'fresh' });
            expect(requests).toHaveLength(2);
            expect(requests[0]).toBe(source);
            expect(requests[1]).toContain('\\setchemfig{atom sep=1.5em}');
            expect(requests[1]).toContain('\\input{chemfig-lewis.tex}');
            expect(requests[1].split('\n')).toHaveLength(source.split('\n').length);

            requests.length = 0;
            retryFails = true;
            expect(await compiler.compile(source)).toMatchObject({ success: false, error: 'Original Chemfig error' });
            expect(requests).toHaveLength(2);

            requests.length = 0;
            const additionalFiles = { 'vendor/chemfig.sty': '% user supplied' };
            expect(await compiler.compile(source, { additionalFiles })).toMatchObject({ success: false, error: 'Original Chemfig error' });
            expect(requests).toEqual([source]);
        });

        it('should compile document and return result', async () => {
            await initCompiler();

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse({
                type: 'compile-response',
                success: true,
                pdfData: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                pdfDataIsShared: false,
                syncTexData: null,
                stats: {},
                log: 'Output written on document.pdf',
            });

            const result = await compilePromise;
            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();
        });

        it('reuses transferred PDF bytes while protecting the document cache', async () => {
            const { getCachedPdf, saveCachedPdf } = await import('../../src/storage.js');
            await initCompiler();
            workerInstances[0]?.setHandler('compile', () => null);

            const compiled = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));
            const buffer = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;
            workerInstances[0]?.sendResponse({ type: 'compile-response', success: true, pdfData: buffer });
            const result = await compiled;
            expect(result.pdf?.buffer).toBe(buffer);
            const saved = vi.mocked(saveCachedPdf).mock.lastCall?.[2];
            expect(saved?.buffer).not.toBe(buffer);
            structuredClone(buffer, { transfer: [buffer] });
            expect(buffer.byteLength).toBe(0);
            expect(Array.from(saved!)).toEqual([0x25, 0x50, 0x44, 0x46]);

            vi.mocked(getCachedPdf).mockResolvedValueOnce(saved!);
            const cached = await compiler.compile(SIMPLE_DOCUMENT);
            expect(cached.cached).toBe(true);
            expect(cached.pdf?.buffer).not.toBe(saved?.buffer);
            expect(Array.from(cached.pdf!)).toEqual([0x25, 0x50, 0x44, 0x46]);
        });

        it('copies a legacy shared PDF response', async () => {
            await initCompiler();
            workerInstances[0]?.setHandler('compile', () => null);
            const compiled = compiler.compile(SIMPLE_DOCUMENT, { useCache: false });
            await new Promise(r => setTimeout(r, 20));
            const shared = new SharedArrayBuffer(4);
            new Uint8Array(shared).set([0x25, 0x50, 0x44, 0x46]);
            workerInstances[0]?.sendResponse({ type: 'compile-response', success: true, pdfData: shared });
            const result = await compiled;
            expect(result.pdf?.buffer).toBeInstanceOf(ArrayBuffer);
            expect(Array.from(result.pdf!)).toEqual([0x25, 0x50, 0x44, 0x46]);
        });

        it('should handle compilation failure', async () => {
            await initCompiler();

            // Disable the auto-success handler so our explicit failure response drives the result.
            workerInstances[0]?.setHandler('compile', () => null);

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse({
                type: 'compile-response',
                success: false,
                error: 'Undefined control sequence',
                exitCode: 1,
                log: '! Undefined control sequence.',
            });

            const result = await compilePromise;
            expect(result.success).toBe(false);
            expect(result.error).toBe('Undefined control sequence');
        });

        it('should cache successful compilation', async () => {
            const { saveCachedPdf } = await import('../../src/storage.js');

            await initCompiler();

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse({
                type: 'compile-response',
                success: true,
                pdfData: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                pdfDataIsShared: false,
                syncTexData: null,
                stats: {},
                log: 'Output written',
            });

            await compilePromise;

            // saveCachedPdf is fire-and-forget, give it time
            await new Promise(r => setTimeout(r, 10));
            expect(saveCachedPdf).toHaveBeenCalled();
        });

        it('should timeout after 120 seconds', async () => {
            // Init under real timers — initCompiler() relies on setTimeout-based
            // waits and the mock worker's async response, which fake timers freeze.
            await initCompiler();

            // Disable default compile handler so it doesn't auto-respond
            workerInstances[0]?.setHandler('compile', () => null);

            vi.useFakeTimers();
            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            // Attach the rejection handler before advancing the clock, otherwise the
            // timeout rejection fires with no handler attached → unhandled rejection.
            const assertion = expect(compilePromise).rejects.toThrow('timeout');
            // Async variant flushes the compile()'s setup microtasks between ticks
            // so the 120s timeout is actually armed before we advance past it.
            await vi.advanceTimersByTimeAsync(121000);
            await assertion;

            vi.useRealTimers();
        });

        it('should skip cache when useCache is false', async () => {
            const { getCachedPdf } = await import('../../src/storage.js');

            await initCompiler();

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT, { useCache: false });
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse({
                type: 'compile-response',
                success: true,
                pdfData: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                pdfDataIsShared: false,
            });

            await compilePromise;

            // getCachedPdf should not be called when useCache is false
            expect(getCachedPdf).not.toHaveBeenCalled();
        });
    });

    describe('generateFormat', () => {
        beforeEach(async () => {
            const { getFmtPath } = await import('../../src/storage.js');
            vi.mocked(getFmtPath).mockReturnValue('fmt-cache/test.fmt');
        });

        async function initCompiler() {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;
        }

        it('keeps document identity in format jobs and does not share frozen jobname state', async () => {
            const { hashPreamble, extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');
            const { hashPreamble: realHash } = await vi.importActual<typeof import('../../src/hash.js')>('../../src/hash.js');
            const { getFmtPath } = await import('../../src/storage.js');
            const previous = vi.mocked(hashPreamble).getMockImplementation();
            vi.mocked(hashPreamble).mockImplementation(realHash);
            vi.mocked(getFmtPath).mockImplementation(key => 'fmt-cache/' + key + '.fmt');
            try {
                await initCompiler();
                const posted = vi.spyOn(workerInstances[0]!, 'postMessage');
                await compiler.generateFormat(SIMPLE_DOCUMENT, { mainFile: 'first.tex' });
                await compiler.generateFormat(SIMPLE_DOCUMENT, { mainFile: 'second.tex' });
                const jobs = posted.mock.calls.map(([m]) => m as any).filter(m => m.type === 'generate-format');
                expect(jobs.map(m => m.mainFile)).toEqual(['first.tex', 'second.tex']);
                expect(new Set(vi.mocked(getFmtPath).mock.calls.map(([key]) => key)).size).toBe(2);
            } finally {
                vi.mocked(hashPreamble).mockImplementation(previous!);
            }
        });

        it('preserves the same converged aux when a preamble format becomes available', async () => {
            const { getAuxCache, saveAuxCache } = await import('../../src/storage.js');
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');
            await initCompiler();
            vi.spyOn(compiler, 'generateFormat').mockResolvedValue(null);
            const worker = workerInstances[0]!;
            const posted = vi.spyOn(worker, 'postMessage');
            const files = { '/note.aux': '\\relax\n\\newlabel{a}{{1}{1}}' };
            vi.mocked(getAuxCache).mockResolvedValue({ files } as any);
            worker.setHandler('compile', (m: any) => ({ type: 'compile-response', id: m.id, success: true,
                pdfData: new TextEncoder().encode('%PDF-fixture').buffer, auxFilesToCache: files }));
            try {
                await compiler.compile(SIMPLE_DOCUMENT, { mainFile: 'note.tex', engine: 'pdflatex', useCache: false });
                (compiler as any)._fmtMemCache = { key: (compiler as any)._formatKey('\\documentclass{article}', 'pdflatex', 'note.tex'), data: new Uint8Array([1]) };
                await compiler.compile(SIMPLE_DOCUMENT, { mainFile: 'note.tex', engine: 'pdflatex', useCache: false });
                await compiler.compile(SIMPLE_DOCUMENT, { mainFile: 'note.tex', engine: 'pdflatex', useCache: false, usePreambleCache: false });
                const jobs = posted.mock.calls.map(([m]) => m as any).filter(m => m.type === 'compile');
                expect(jobs).toHaveLength(3);
                expect(jobs[0].cachedFormat).toBeNull();
                expect(jobs[1].cachedFormat).not.toBeNull();
                expect(jobs[2].cachedFormat).toBeNull();
                expect(jobs.map(m => m.cachedAuxFiles)).toEqual([files, files, files]);
                expect(new Set(vi.mocked(getAuxCache).mock.calls.map(([key]) => key)).size).toBe(1);
                expect(new Set(vi.mocked(saveAuxCache).mock.calls.map(([key]) => key)).size).toBe(1);
            } finally { vi.mocked(getAuxCache).mockResolvedValue(null); }
        });

        it('uses advertised source analysis with exact request correlation', async () => {
            await initCompiler();
            (compiler as any).workerSourceAnalysis = true;
            const worker = workerInstances[0]!;
            worker.setHandler('analyze-source', () => null);
            const posted = vi.spyOn(worker, 'postMessage');
            const result = (compiler as any)._sourcePassCount('\\tableofcontents');
            const request = posted.mock.calls.map(([m]) => m as any).find(m => m.type === 'analyze-source');
            worker.sendResponse({ type: 'source-analysis-response', id: 'stale', passes: 1 });
            expect((compiler as any).pendingAnalysis.size).toBe(1);
            worker.sendResponse({ type: 'source-analysis-response', id: request.id, passes: 3 });
            await expect(result).resolves.toBe(3);
            expect((compiler as any).pendingAnalysis.size).toBe(0);
        });
        it('does not send optional source analysis to older workers', async () => {
            await initCompiler();
            const posted = vi.spyOn(workerInstances[0]!, 'postMessage');
            await expect((compiler as any)._sourcePassCount('source')).resolves.toBeNull();
            expect(posted.mock.calls.some(([m]) => (m as any).type === 'analyze-source')).toBe(false);
        });
        it('rejects pending analysis immediately when its worker terminates', async () => {
            await initCompiler();
            (compiler as any).workerSourceAnalysis = true;
            workerInstances[0]!.setHandler('analyze-source', () => null);
            const result = expect((compiler as any)._sourcePassCount('source')).rejects.toThrow('Compiler worker terminated');
            compiler.terminate();
            await result;
            expect((compiler as any).pendingAnalysis.size).toBe(0);
        });

        it('isolates auxiliary labels between projects with the same main filename and preamble', async () => {
            const { webcrypto } = await import('node:crypto');
            vi.stubGlobal('crypto', webcrypto);
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');
            const { getAuxCache, saveAuxCache } = await import('../../src/storage.js');
            const stored = new Map();
            vi.mocked(getAuxCache).mockImplementation(async key => stored.get(key) || null);
            vi.mocked(saveAuxCache).mockImplementation(async (key, files) => { stored.set(key, { files }); });
            try {
                await initCompiler();
                vi.spyOn(compiler, 'generateFormat').mockResolvedValue(null);
                const worker = workerInstances[0]!;
                worker.setHandler('compile', (m: any) => ({ type: 'compile-response', id: m.id, success: true,
                    pdfData: new TextEncoder().encode('%PDF-fixture').buffer, auxFilesToCache: { '/main.aux': m.source } }));
                const posted = vi.spyOn(worker, 'postMessage');
                for (const projectId of ['folder-a', 'folder-b', 'folder-a']) {
                    await compiler.compile(SIMPLE_DOCUMENT + projectId, { engine: 'pdflatex', mainFile: 'main.tex', projectId, useCache: false });
                }
                const jobs = posted.mock.calls.map(([m]) => m as any).filter(m => m.type === 'compile');
                expect(jobs[0].cachedAuxFiles).toBeNull();
                expect(jobs[1].cachedAuxFiles).toBeNull();
                expect(jobs[2].cachedAuxFiles).toEqual({ '/main.aux': SIMPLE_DOCUMENT + 'folder-a' });
                expect(stored.size).toBe(2);
            } finally {
                vi.mocked(getAuxCache).mockResolvedValue(null);
                vi.mocked(saveAuxCache).mockResolvedValue(undefined);
            }
        });

        it('should return null for xelatex', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');

            await initCompiler();

            const result = await compiler.generateFormat(XELATEX_DOCUMENT, { engine: 'xelatex' });
            expect(result).toBeNull();
        });

        it('declines dependency-sensitive format generation instead of returning a stale format', async () => {
            await initCompiler();
            const first = await compiler.generateFormat(SIMPLE_DOCUMENT, { additionalFiles: { 'local.sty': 'version one' } });
            const second = await compiler.generateFormat(SIMPLE_DOCUMENT, { additionalFiles: { 'local.sty': 'version two' } });
            expect(first).toBeNull();
            expect(second).toBeNull();
            expect(await compiler.generateFormat(SIMPLE_DOCUMENT, { mainFile: 'revision/main.tex' })).toBeNull();
        });

        it('declines explicit format generation for an extended KOMA class size', async () => {
            await mockFileSystem.writeBinary('/fmt-cache/test.fmt', new Uint8Array([42]), { createParents: true });

            expect(await compiler.generateFormat(KOMA_EXTENDED_DOCUMENT)).toBeNull();
            expect(mockFileSystem.readBinary).not.toHaveBeenCalledWith('/fmt-cache/test.fmt');
            expect(workerInstances).toHaveLength(0);
        });

        it('should throw if no preamble', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue(null);

            await initCompiler();

            await expect(compiler.generateFormat(SIMPLE_DOCUMENT)).rejects.toThrow('No preamble');
        });

        it('should generate format for pdflatex', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');

            await initCompiler();

            // Disable the auto-responder so our explicit response provides the format bytes.
            workerInstances[0]?.setHandler('generate-format', () => null);

            const generatePromise = compiler.generateFormat(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            const fmtBytes = new TextEncoder().encode('FMT-DATA');
            workerInstances[0]?.sendResponse({
                type: 'format-generate-response',
                success: true,
                formatData: fmtBytes.buffer,
            });

            // generateFormat resolves with the format file bytes (Uint8Array).
            const result = await generatePromise;
            expect(result).toBeInstanceOf(Uint8Array);
            expect(new TextDecoder().decode(result)).toBe('FMT-DATA');
        });

        it('coalesces simultaneous format requests before reading the cache and gives each caller its own bytes', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');
            await initCompiler();
            const worker = workerInstances[0]!;
            worker.setHandler('generate-format', () => null);
            const posted = vi.spyOn(worker, 'postMessage');
            const first = compiler.generateFormat(SIMPLE_DOCUMENT);
            const second = compiler.generateFormat(SIMPLE_DOCUMENT + '\n% body-only edit');
            const messages = () => posted.mock.calls.map(([message]) => message as { type: string; id: string })
                .filter(message => message.type === 'generate-format');
            await vi.waitFor(() => expect(messages().length).toBeGreaterThan(0));
            const [{ id }] = messages();
            const bytes = new Uint8Array([10, 20]);
            worker.sendResponse({ type: 'format-generate-response', id, success: true, formatData: bytes.buffer });
            expect(messages()).toHaveLength(1);
            const [a, b] = await Promise.all([first, second]);
            expect(a).toEqual(bytes);
            expect(b).toEqual(bytes);
            expect(a!.buffer).not.toBe(b!.buffer);
        });

        it('keeps generated bytes usable and retries when a required sidecar cannot be saved', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');
            await initCompiler();
            const worker = workerInstances[0]!;
            const fmtPath = '/fmt-cache/test.fmt';
            const sidePath = fmtPath + '.side.json';
            const bytes = new Uint8Array([10, 20]);
            const sideFile = new Uint8Array([1, 2, 3]);
            const generate = vi.fn(message => ({
                type: 'format-generate-response', id: message.id, success: true, formatData: bytes.buffer,
                sideEffectFiles: { '/generated.tex': sideFile.buffer },
            }));
            worker.setHandler('generate-format', generate);

            const write = mockFileSystem.writeBinary.getMockImplementation()!;
            let failSidecar = true;
            mockFileSystem.writeBinary.mockImplementation((path, content, options) => {
                if (failSidecar && path === sidePath) return Promise.reject(new Error('Sidecar quota exceeded'));
                return write(path, content, options);
            });

            const first = await compiler.generateFormat(SIMPLE_DOCUMENT);
            expect(first).toEqual(bytes);
            expect(first!.buffer).not.toBe(bytes.buffer);
            first![0] = 99;
            expect(mockFileSystem.writeBinary.mock.calls.map(([path]) => path)).toEqual([sidePath]);
            expect(getMockFile(fmtPath)).toBeNull();

            failSidecar = false;
            await expect(compiler.generateFormat(SIMPLE_DOCUMENT)).resolves.toEqual(new Uint8Array([10, 20]));
            expect(generate).toHaveBeenCalledTimes(2);
            expect(mockFileSystem.writeBinary.mock.calls.map(([path]) => path)).toEqual([sidePath, sidePath, fmtPath]);
            expect(getMockFile(fmtPath)).toEqual(bytes);
            expect(JSON.parse(new TextDecoder().decode(getMockFile(sidePath)!))).toEqual({ '/generated.tex': 'AQID' });
        });

        it('replaces an orphan sidecar with an explicit empty map before publishing a retried format', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');
            await initCompiler();
            const worker = workerInstances[0]!;
            const fmtPath = '/fmt-cache/test.fmt';
            const sidePath = fmtPath + '.side.json';
            const bytes = new Uint8Array([10, 20]);
            let sideEffectFiles: Record<string, ArrayBuffer> = { '/stale.tex': new Uint8Array([4]).buffer };
            worker.setHandler('generate-format', message => ({
                type: 'format-generate-response', id: message.id, success: true, formatData: bytes.buffer, sideEffectFiles,
            }));

            const write = mockFileSystem.writeBinary.getMockImplementation()!;
            let failFormat = true;
            mockFileSystem.writeBinary.mockImplementation((path, content, options) => {
                if (failFormat && path === fmtPath) return Promise.reject(new Error('Format quota exceeded'));
                return write(path, content, options);
            });

            await expect(compiler.generateFormat(SIMPLE_DOCUMENT)).resolves.toEqual(bytes);
            expect(getMockFile(fmtPath)).toBeNull();
            expect(getMockFile(sidePath)).not.toBeNull();
            expect(JSON.parse(new TextDecoder().decode(getMockFile(sidePath)!))).toEqual({ '/stale.tex': 'BA==' });

            failFormat = false;
            sideEffectFiles = {};
            await expect(compiler.generateFormat(SIMPLE_DOCUMENT)).resolves.toEqual(bytes);
            expect(mockFileSystem.writeBinary.mock.calls.map(([path]) => path)).toEqual([sidePath, fmtPath, sidePath, fmtPath]);
            expect(getMockFile(fmtPath)).toEqual(bytes);
            expect(JSON.parse(new TextDecoder().decode(getMockFile(sidePath)!))).toEqual({});
        });

        it('uses a legacy format without a sidecar while offline', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');
            await initCompiler();
            const bytes = new Uint8Array([7, 11]);
            setMockFile('/fmt-cache/test.fmt', bytes);
            compiler.enableCtan = false;
            fetchMock.mockClear().mockRejectedValue(new Error('Offline'));
            const posted = vi.spyOn(workerInstances[0]!, 'postMessage');

            await expect(compiler.compile(SIMPLE_DOCUMENT, { useCache: false })).resolves.toMatchObject({ success: true });
            expect(posted).toHaveBeenCalledWith(expect.objectContaining({
                type: 'compile', cachedFormat: expect.objectContaining({ fmtData: bytes }),
            }), expect.any(Array));
            expect(posted).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'compile', cachedFormat: expect.objectContaining({ sideEffectFiles: expect.anything() }),
            }), expect.any(Array));
            await expect(compiler.generateFormat(SIMPLE_DOCUMENT)).resolves.toEqual(bytes);
            expect(posted).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'generate-format' }), expect.any(Array));
            expect(fetchMock).not.toHaveBeenCalled();
            expect(mockFileSystem.writeBinary).not.toHaveBeenCalled();
        });

        it('restores a committed sidecar on a fresh compiler with warmed runtime assets and no network', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');
            const bytes = new Uint8Array([7, 11]);
            setMockFile('/fmt-cache/test.fmt', bytes);
            setMockFile('/fmt-cache/test.fmt.side.json', JSON.stringify({ '/generated.tex': 'AQID' }));
            const cache = await caches.open('siglum-wasm-tl2026-v2');
            vi.mocked(cache.match).mockResolvedValueOnce(new Response(new Uint8Array([1])));
            fetchMock.mockClear().mockRejectedValue(new Error('Offline'));
            compiler = new SiglumCompiler({
                bundlesUrl: 'http://test.com/bundles', wasmUrl: 'http://test.com/busytex.wasm',
                workerUrl: '/worker.js', enableCtan: false,
            });
            await compiler.init();
            const posted = vi.spyOn(workerInstances[0]!, 'postMessage');

            await expect(compiler.compile(SIMPLE_DOCUMENT, { useCache: false })).resolves.toMatchObject({ success: true });
            expect(posted).toHaveBeenCalledWith(expect.objectContaining({
                type: 'compile', cachedFormat: expect.objectContaining({
                    fmtData: bytes, sideEffectFiles: { '/generated.tex': new Uint8Array([1, 2, 3]) },
                }),
            }), expect.any(Array));
            expect(fetchMock).not.toHaveBeenCalled();
            expect(mockFileSystem.writeBinary).not.toHaveBeenCalled();
        });

        it('queues different preambles and ignores a stale reply with the previous request ID', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValueOnce('first preamble').mockReturnValueOnce('second preamble');
            await initCompiler();
            const worker = workerInstances[0]!;
            worker.setHandler('generate-format', () => null);
            const posted = vi.spyOn(worker, 'postMessage');
            const first = compiler.generateFormat(SIMPLE_DOCUMENT);
            const failure = expect(first).rejects.toThrow('first failed');
            const second = compiler.generateFormat(SIMPLE_DOCUMENT);
            const messages = () => posted.mock.calls.map(([message]) => message as { type: string; id: string; preambleContent: string })
                .filter(message => message.type === 'generate-format');
            await vi.waitFor(() => expect(messages().length).toBeGreaterThan(0));
            expect(messages().map(message => message.preambleContent)).toEqual(['first preamble']);
            const [{ id: firstId }] = messages();
            worker.sendResponse({ type: 'format-generate-response', id: firstId, success: false, error: 'first failed' });
            await failure;
            await vi.waitFor(() => expect(messages()).toHaveLength(2));
            const [, { id: secondId, preambleContent }] = messages();
            expect(preambleContent).toBe('second preamble');
            worker.sendResponse({ type: 'format-generate-response', id: firstId, success: true, formatData: new Uint8Array([1]).buffer });
            worker.sendResponse({ type: 'format-generate-response', id: secondId, success: true, formatData: new Uint8Array([2]).buffer });
            await expect(second).resolves.toEqual(new Uint8Array([2]));
        });

        it('rejects the running and queued format requests when their worker terminates', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValueOnce('running preamble').mockReturnValueOnce('queued preamble');
            await initCompiler();
            const worker = workerInstances[0]!;
            worker.setHandler('generate-format', () => null);
            const posted = vi.spyOn(worker, 'postMessage');
            const a = expect(compiler.generateFormat(SIMPLE_DOCUMENT)).rejects.toThrow('Compiler worker terminated');
            const b = expect(compiler.generateFormat(SIMPLE_DOCUMENT)).rejects.toThrow('Compiler worker terminated');
            await vi.waitFor(() => expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: 'generate-format' }), expect.any(Array)));
            compiler.terminate();
            await Promise.all([a, b]);
            expect(workerInstances).toHaveLength(1);
        });

        it('rejects a terminated format caller even after the worker has begun saving the result', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');
            await initCompiler();
            const worker = workerInstances[0]!;
            const bytes = new Uint8Array([10, 20]);
            worker.setHandler('generate-format', message => ({
                type: 'format-generate-response', id: message.id, success: true, formatData: bytes.buffer,
            }));
            let finishWrite!: () => void;
            const writing = new Promise<void>(resolve => { finishWrite = resolve; });
            mockFileSystem.writeBinary.mockImplementationOnce(() => writing);
            const result = expect(compiler.generateFormat(SIMPLE_DOCUMENT)).rejects.toThrow('Compiler worker terminated');
            try {
                await vi.waitFor(() => expect(mockFileSystem.writeBinary).toHaveBeenCalledWith(
                    '/fmt-cache/test.fmt.side.json', new TextEncoder().encode('{}'), { createParents: true },
                ));
                compiler.terminate();
            } finally {
                finishWrite();
            }
            await result;
            expect(workerInstances).toHaveLength(1);
        });
    });

    describe('preloadBundles', () => {
        it('should preload specified bundles', async () => {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;

            await compiler.preloadBundles(['amsmath', 'graphics']);

            expect(compiler.bundleManager.loadBundle).toHaveBeenCalledWith('amsmath');
            expect(compiler.bundleManager.loadBundle).toHaveBeenCalledWith('graphics');
        });
    });

    describe('clearCache', () => {
        it('should clear CTAN cache', async () => {
            const { clearCTANCache } = await import('../../src/storage.js');

            await compiler.clearCache();

            expect(clearCTANCache).toHaveBeenCalled();
            expect(compiler.ctanFetcher.clearMountedFiles).toHaveBeenCalled();
        });
    });

    describe('clearBundleMemoryCache', () => {
        it('should clear bundle manager cache', () => {
            compiler.clearBundleMemoryCache();
            expect(compiler.bundleManager.clearCache).toHaveBeenCalled();
        });
    });

    describe('getStats', () => {
        it('should return bundle and ctan stats', () => {
            const stats = compiler.getStats();

            expect(stats).toHaveProperty('bundles');
            expect(stats).toHaveProperty('ctan');
        });
    });

    describe('terminate', () => {
        it('should terminate worker', async () => {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;

            expect(compiler.worker).not.toBeNull();

            compiler.terminate();

            expect(compiler.worker).toBeNull();
            expect(compiler.workerReady).toBe(false);
        });

        it('should handle terminate when no worker', () => {
            expect(compiler.worker).toBeNull();
            expect(() => compiler.terminate()).not.toThrow();
        });
    });

    describe('unload', () => {
        it('should terminate and clear caches', async () => {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;

            compiler.unload();

            expect(compiler.worker).toBeNull();
            expect(compiler.bundleManager.clearCache).toHaveBeenCalled();
            expect(compiler.ctanFetcher.clearMountedFiles).toHaveBeenCalled();
        });
    });

    describe('worker message handling', () => {
        async function initCompiler() {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;
        }

        it('should handle log messages', async () => {
            await initCompiler();

            workerInstances[0]?.sendResponse({
                type: 'log',
                message: 'Test log message',
            });

            await new Promise(r => setTimeout(r, 10));

            expect(compiler.onLog).toHaveBeenCalled();
        });

        it('should handle progress messages', async () => {
            await initCompiler();

            workerInstances[0]?.sendResponse({
                type: 'progress',
                stage: 'compile',
                detail: '50%',
            });

            await new Promise(r => setTimeout(r, 10));

            expect(compiler.onProgress).toHaveBeenCalled();
        });

        it('should handle CTAN fetch requests', async () => {
            await initCompiler();

            // Don't auto-complete the compile; we want to observe the in-flight CTAN request.
            workerInstances[0]?.setHandler('compile', () => null);

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            // The worker requests a single package by name (see _handleCtanFetchRequest).
            workerInstances[0]?.sendResponse({
                type: 'ctan-fetch-request',
                requestId: 'req1',
                packageName: 'fancyhdr',
            });

            await new Promise(r => setTimeout(r, 20));

            expect(compiler.ctanFetcher.fetchPackage).toHaveBeenCalledWith('fancyhdr', { tlYear: undefined });

            // Complete the compile to clean up
            workerInstances[0]?.sendResponse({
                type: 'compile-response',
                success: true,
                pdfData: new Uint8Array([1]).buffer,
                pdfDataIsShared: false,
            });
            await compilePromise.catch(() => {});
        });

        it('requests the exact indexed Babel language package and ignores unknown options', async () => {
            await initCompiler();
            const lookup = vi.mocked(compiler.ctanFetcher.lookupPackageForFile);
            const fetch = vi.mocked(compiler.ctanFetcher.fetchPackage);
            const post = vi.spyOn(workerInstances[0], 'postMessage');
            lookup.mockResolvedValueOnce('babel-german').mockResolvedValueOnce(null);
            fetch.mockClear();

            await compiler._handleCtanFetchRequest({
                requestId: 'german', packageName: 'ngerman', fileName: 'ngerman.ldf',
            });
            await compiler._handleCtanFetchRequest({
                requestId: 'unknown', packageName: 'typo', fileName: 'typo.ldf',
            });

            expect(lookup).toHaveBeenCalledWith('ngerman.ldf');
            expect(lookup).toHaveBeenCalledWith('typo.ldf');
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(fetch).toHaveBeenCalledWith('babel-german', { tlYear: undefined });
            expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
                type: 'ctan-fetch-response', requestId: 'unknown', success: false,
            }));
        });

        it('should handle bundle fetch requests', async () => {
            await initCompiler();

            // Don't auto-complete the compile; we want to observe the in-flight bundle request.
            workerInstances[0]?.setHandler('compile', () => null);

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            // The worker requests a single bundle by name (see _handleBundleFetchRequest).
            workerInstances[0]?.sendResponse({
                type: 'bundle-fetch-request',
                requestId: 'req1',
                bundleName: 'amsmath',
            });

            await new Promise(r => setTimeout(r, 20));

            expect(compiler.bundleManager.loadBundle).toHaveBeenCalledWith('amsmath');

            // Complete the compile
            workerInstances[0]?.sendResponse({
                type: 'compile-response',
                success: true,
                pdfData: new Uint8Array([1]).buffer,
                pdfDataIsShared: false,
            });
            await compilePromise.catch(() => {});
        });

        it('should handle memory snapshot messages', async () => {
            const { saveWasmMemorySnapshot } = await import('../../src/storage.js');

            await initCompiler();

            workerInstances[0]?.sendResponse({
                type: 'memory-snapshot',
                snapshot: new ArrayBuffer(1000),
                byteLength: 1000,
            });

            await new Promise(r => setTimeout(r, 10));

            expect(saveWasmMemorySnapshot).toHaveBeenCalled();
        });

        it('should handle worker errors', async () => {
            await initCompiler();

            // Disable auto-success so the worker error is what settles the compile.
            workerInstances[0]?.setHandler('compile', () => null);

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendError(new Error('Worker crashed'));

            await expect(compilePromise).rejects.toThrow('Worker crashed');
            expect(compiler.worker).toBeNull();
        });
    });

    describe('_coalesceRanges', () => {
        it('should merge adjacent ranges', () => {
            const ranges = [
                { start: 0, end: 100 },
                { start: 100, end: 200 },
            ];
            // _coalesceRanges groups requests that fall within the gap threshold;
            // each returned element is the group of original requests to fetch together.
            const coalesced = compiler['_coalesceRanges'](ranges);
            expect(coalesced).toHaveLength(1);
            expect(coalesced[0]).toEqual([
                { start: 0, end: 100 },
                { start: 100, end: 200 },
            ]);
        });

        it('should merge nearby ranges within gap threshold', () => {
            const ranges = [
                { start: 0, end: 100 },
                { start: 150, end: 200 },
            ];
            // Gap of 50 bytes, threshold is 64KB
            const coalesced = compiler['_coalesceRanges'](ranges, 65536);
            expect(coalesced).toHaveLength(1);
        });

        it('should not merge distant ranges', () => {
            const ranges = [
                { start: 0, end: 100 },
                { start: 200000, end: 200100 },
            ];
            const coalesced = compiler['_coalesceRanges'](ranges, 65536);
            expect(coalesced).toHaveLength(2);
        });
    });

    describe('BusyTeXCompiler alias', () => {
        it('should be an alias for SiglumCompiler', () => {
            expect(BusyTeXCompiler).toBe(SiglumCompiler);
        });
    });
});

describe('tool implementation cache identity', () => {
    it('separates build-state caches by provider revision while reusing the same version', async () => {
        const { hashPreamble } = await import('../../src/bundles.js');
        vi.mocked(hashPreamble).mockImplementation(value => value);
        try {
            const provider = { command: 'Rscript', revision: 'content-a', run: () => ({ exitCode: 0 }) };
            const first = new SiglumCompiler({ tools: [provider] });
            const same = new SiglumCompiler({ tools: [provider] });
            const updated = new SiglumCompiler({ tools: [{ ...provider, revision: 'content-b' }] });
            expect(first.runtimeKey).toBe(same.runtimeKey);
            expect(first.runtimeKey).not.toBe(updated.runtimeKey);
            expect(first._formatKey('preamble', 'pdflatex')).not.toBe(updated._formatKey('preamble', 'pdflatex'));
            expect(first.bundlesUrl).toBe(updated.bundlesUrl);
        } finally { vi.mocked(hashPreamble).mockReturnValue('preamblehash'); }
    });
    it('keeps unversioned providers and legacy callbacks out of cross-instance build-state reuse', async () => {
        const { hashPreamble } = await import('../../src/bundles.js');
        vi.mocked(hashPreamble).mockImplementation(value => value);
        try {
            const options = { tools: [{ command: 'custom-tool', run: () => ({}) }] };
            expect(new SiglumCompiler(options).runtimeKey).not.toBe(new SiglumCompiler(options).runtimeKey);
            const legacy = { toolRunner: () => ({ bytes: new Uint8Array([1]) }) };
            expect(new SiglumCompiler(legacy).runtimeKey).not.toBe(new SiglumCompiler(legacy).runtimeKey);
        } finally { vi.mocked(hashPreamble).mockReturnValue('preamblehash'); }
    });
});
