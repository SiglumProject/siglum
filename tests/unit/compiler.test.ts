/**
 * Tests for compiler.js - Main SiglumCompiler class.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFileSystem, resetMockFileSystem } from '../setup/mocks/filesystem';
import { MockCompilerWorker, configureCompileScenario } from '../setup/mocks/worker';
import {
    SIMPLE_DOCUMENT,
    XELATEX_DOCUMENT,
    DOCUMENT_WITH_PACKAGE,
} from '../setup/fixtures/latex-samples';

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
    getAuxCache: vi.fn().mockResolvedValue(null),
    saveAuxCache: vi.fn().mockResolvedValue(undefined),
    getCachedPdf: vi.fn().mockResolvedValue(null),
    saveCachedPdf: vi.fn().mockResolvedValue(undefined),
    hashDocument: vi.fn().mockReturnValue('mockhash'),
    getFmtPath: vi.fn().mockReturnValue('fmt-cache/test.fmt'),
    clearCTANCache: vi.fn().mockResolvedValue(true),
    saveWasmMemorySnapshot: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/bundles.js', () => {
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

        it('should return cached PDF if available', async () => {
            const { getCachedPdf } = await import('../../src/storage.js');
            vi.mocked(getCachedPdf).mockResolvedValueOnce(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

            await initCompiler();
            const result = await compiler.compile(SIMPLE_DOCUMENT);

            expect(result.cached).toBe(true);
            expect(result.pdf).toBeDefined();
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
        async function initCompiler() {
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await initPromise;
        }

        it('should return null for xelatex', async () => {
            const { extractPreamble } = await import('../../src/bundles.js');
            vi.mocked(extractPreamble).mockReturnValue('\\documentclass{article}');

            await initCompiler();

            const result = await compiler.generateFormat(XELATEX_DOCUMENT, { engine: 'xelatex' });
            expect(result).toBeNull();
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
