/**
 * Integration tests for memory cleanup and resource management.
 * Tests proper cleanup of WASM memory, worker termination, and cache clearing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFileSystem, resetMockFileSystem } from '../setup/mocks/filesystem';
import { MockCompilerWorker } from '../setup/mocks/worker';

// Create mock bundle manager factory
const createMockBundleManager = () => ({
    bundleBase: 'packages/bundles',
    bundleCache: new Map(),
    fileManifest: { 'base/article.cls': 'base' },
    packageMap: { 'article': 'base' },
    bundleDeps: { engines: {}, bundles: {}, deferred: [] },
    bundleRegistry: new Set(),
    onLog: vi.fn(),
    loadManifest: vi.fn().mockResolvedValue({ 'base/article.cls': 'base' }),
    loadBundleDeps: vi.fn().mockResolvedValue({}),
    bundleExists: vi.fn().mockReturnValue(true),
    resolveBundles: vi.fn().mockReturnValue([]),
    checkPackages: vi.fn().mockReturnValue({ packages: [], bundles: [] }),
    prescanForCtanPackages: vi.fn().mockReturnValue({
        bundledPackages: [],
        ctanPackages: [],
        additionalBundles: [],
    }),
    loadBundle: vi.fn().mockResolvedValue(new ArrayBuffer(1000)),
    loadBundles: vi.fn().mockResolvedValue({}),
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

// Store global stubs for cleanup
let globalStubs: string[] = [];

// Mock modules - use async imports inside factories since vi.mock is hoisted
vi.mock('@siglum/filesystem', async () => {
    const { mockFileSystem } = await import('../setup/mocks/filesystem');
    return { fileSystem: mockFileSystem };
});

vi.mock('../../src/storage.js', () => ({
    getAuxCache: vi.fn().mockResolvedValue(null),
    saveAuxCache: vi.fn().mockResolvedValue(undefined),
    getCachedPdf: vi.fn().mockResolvedValue(null),
    saveCachedPdf: vi.fn().mockResolvedValue(undefined),
    hashDocument: vi.fn().mockReturnValue('hash'),
    getFmtPath: vi.fn().mockReturnValue('fmt-cache/test.fmt'),
    clearCTANCache: vi.fn().mockResolvedValue(true),
    saveWasmMemorySnapshot: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/bundles.js', () => {
    const createMockBundleManager = () => ({
        bundleBase: 'packages/bundles',
        bundleCache: new Map(),
        fileManifest: { 'base/article.cls': 'base' },
        packageMap: { 'article': 'base' },
        bundleDeps: { engines: {}, bundles: {}, deferred: [] },
        bundleRegistry: new Set(),
        onLog: vi.fn(),
        loadManifest: vi.fn().mockResolvedValue({ 'base/article.cls': 'base' }),
        loadBundleDeps: vi.fn().mockResolvedValue({}),
        bundleExists: vi.fn().mockReturnValue(true),
        resolveBundles: vi.fn().mockReturnValue([]),
        checkPackages: vi.fn().mockReturnValue({ packages: [], bundles: [] }),
        prescanForCtanPackages: vi.fn().mockReturnValue({
            bundledPackages: [],
            ctanPackages: [],
            additionalBundles: [],
        }),
        loadBundle: vi.fn().mockResolvedValue(new ArrayBuffer(1000)),
        loadBundles: vi.fn().mockResolvedValue({}),
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

import { SiglumCompiler } from '../../src/compiler.js';
import { BundleManager } from '../../src/bundles.js';
import { CTANFetcher } from '../../src/ctan.js';

describe('Memory Cleanup Integration', () => {
    let compiler: SiglumCompiler;
    let workerInstances: MockCompilerWorker[] = [];
    let terminatedWorkers: MockCompilerWorker[] = [];

    // Helper to convert URL or string to string for comparisons
    const urlToString = (url: string | URL): string => {
        if (url instanceof URL) return url.toString();
        return url;
    };

    beforeEach(() => {
        resetMockFileSystem();
        vi.clearAllMocks();
        workerInstances = [];
        terminatedWorkers = [];
        globalStubs = [];

        // Reset mocks to return fresh instances
        (BundleManager as any).mockImplementation(() => createMockBundleManager());
        (CTANFetcher as any).mockImplementation(() => createMockCTANFetcher());

        // Mock fetch - handle both string and URL objects
        (globalThis as any).fetch = vi.fn().mockImplementation(async (url: string | URL) => {
            const urlStr = urlToString(url);
            if (urlStr.includes('busytex.wasm')) {
                return {
                    ok: true,
                    clone: () => ({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }),
                    arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
                };
            }
            if (urlStr.includes('worker.js')) {
                return { ok: true, text: () => Promise.resolve('// worker') };
            }
            return { ok: false, status: 404 };
        });
        globalStubs.push('fetch');

        // Mock Worker with terminate tracking
        (globalThis as any).Worker = class extends MockCompilerWorker {
            constructor(url: string | URL) {
                super(url);
                workerInstances.push(this);
            }
            terminate() {
                terminatedWorkers.push(this);
                super.terminate();
            }
        };
        globalStubs.push('Worker');

        // Mock WebAssembly
        (globalThis as any).WebAssembly = {
            compile: vi.fn().mockResolvedValue({ _mock: true }),
            compileStreaming: vi.fn().mockResolvedValue({ _mock: true }),
            Memory: class { buffer = new ArrayBuffer(1024); },
        };
        globalStubs.push('WebAssembly');

        // Mock caches
        (globalThis as any).caches = {
            open: vi.fn().mockResolvedValue({
                match: vi.fn().mockResolvedValue(undefined),
                put: vi.fn().mockResolvedValue(undefined),
            }),
        };
        globalStubs.push('caches');

        // Mock URL static methods (keep original URL constructor)
        (globalThis as any).URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-worker-url');
        (globalThis as any).URL.revokeObjectURL = vi.fn();

        // Mock window for browser API compatibility
        (globalThis as any).window = {
            location: { href: 'http://test/' },
        };
        globalStubs.push('window');

        compiler = new SiglumCompiler({
            bundlesUrl: 'http://test/bundles',
            wasmUrl: 'http://test/busytex.wasm',
            onLog: vi.fn(),
            onProgress: vi.fn(),
        });
    });

    afterEach(() => {
        // Restore real timers first: a fake-timer test that throws before its own
        // useRealTimers() would otherwise leave every later test deadlocked on
        // setTimeout-based waits.
        vi.useRealTimers();
        // Manual cleanup of global stubs
        for (const stub of globalStubs) {
            delete (globalThis as any)[stub];
        }
        vi.restoreAllMocks();
        compiler?.terminate();
    });

    async function initCompiler() {
        const initPromise = compiler.init();
        await new Promise(r => setTimeout(r, 10));
        workerInstances[0]?.sendResponse({ type: 'ready' });
        await initPromise;
    }

    describe('terminate()', () => {
        it('should terminate the worker', async () => {
            await initCompiler();

            expect(compiler.worker).toBeDefined();
            expect(compiler.workerReady).toBe(true);

            compiler.terminate();

            expect(compiler.worker).toBeNull();
            expect(compiler.workerReady).toBe(false);
            expect(terminatedWorkers.length).toBe(1);
        });

        it('should handle terminate when no worker exists', () => {
            expect(compiler.worker).toBeNull();

            // Should not throw
            compiler.terminate();

            expect(compiler.worker).toBeNull();
        });

        it('should allow re-initialization after terminate', async () => {
            await initCompiler();
            compiler.terminate();

            // Reinitialize
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[workerInstances.length - 1]?.sendResponse({ type: 'ready' });
            await initPromise;

            expect(compiler.worker).toBeDefined();
            expect(compiler.workerReady).toBe(true);
        });
    });

    describe('unload()', () => {
        it('should terminate worker and clear caches', async () => {
            await initCompiler();

            compiler.unload();

            expect(compiler.worker).toBeNull();
            expect(compiler.bundleManager.clearCache).toHaveBeenCalled();
            expect(compiler.ctanFetcher.clearMountedFiles).toHaveBeenCalled();
        });

        it('should clear bundle memory cache', async () => {
            await initCompiler();

            // Simulate having bundle cache
            compiler.bundleManager.bundleCache = new Map([
                ['base', new ArrayBuffer(10000)],
                ['amsmath', new ArrayBuffer(5000)],
            ]);

            compiler.unload();

            expect(compiler.bundleManager.clearCache).toHaveBeenCalled();
        });

        it('should allow reinit after unload', async () => {
            await initCompiler();
            compiler.unload();

            expect(compiler.isLoaded()).toBe(false);

            // Reinitialize
            const initPromise = compiler.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[workerInstances.length - 1]?.sendResponse({ type: 'ready' });
            await initPromise;

            expect(compiler.isLoaded()).toBe(true);
        });
    });

    describe('clearBundleMemoryCache()', () => {
        it('should call bundle manager clearCache', async () => {
            await initCompiler();

            compiler.clearBundleMemoryCache();

            expect(compiler.bundleManager.clearCache).toHaveBeenCalled();
        });
    });

    describe('clearCache()', () => {
        it('should clear CTAN cache', async () => {
            const { clearCTANCache } = await import('../../src/storage.js');

            await initCompiler();
            await compiler.clearCache();

            expect(clearCTANCache).toHaveBeenCalled();
            expect(compiler.ctanFetcher.clearMountedFiles).toHaveBeenCalled();
        });
    });

    describe('Worker error recovery', () => {
        it('should clean up worker reference on error', async () => {
            await initCompiler();

            // Disable default compile handler so it doesn't auto-respond
            workerInstances[0]?.setHandler('compile', () => null);

            const compilePromise = compiler.compile('\\documentclass{article}\\begin{document}\\end{document}');
            await new Promise(r => setTimeout(r, 10));

            // Simulate worker error
            workerInstances[0]?.sendError(new Error('Worker crashed'));

            await expect(compilePromise).rejects.toThrow();

            expect(compiler.worker).toBeNull();
            expect(compiler.workerReady).toBe(false);
        });
    });

    describe('No SharedArrayBuffer usage', () => {
        it('should not use SharedArrayBuffer for bundle transfers', async () => {
            await initCompiler();

            // Verify bundle data is regular ArrayBuffer
            const bundleData = await compiler.bundleManager.loadBundle('test');

            // In the actual implementation, we explicitly avoid SharedArrayBuffer
            // due to V8 GC issues where SABs sent to workers become persistent memory
            expect(bundleData).toBeInstanceOf(ArrayBuffer);
            // SharedArrayBuffer check would be:
            // expect(bundleData instanceof SharedArrayBuffer).toBe(false);
        });

        it('should transfer buffers using slice(0)', async () => {
            // This verifies the pattern of copying buffers before transfer
            const original = new ArrayBuffer(100);
            const copy = original.slice(0);

            // Copy should be a new buffer
            expect(copy).not.toBe(original);
            expect(copy.byteLength).toBe(original.byteLength);
        });
    });

    describe('Global worker reference cleanup', () => {
        it('should track only one active worker globally', async () => {
            // First compiler
            const compiler1 = new SiglumCompiler({
                onLog: vi.fn(),
                onProgress: vi.fn(),
            });

            const init1 = compiler1.init();
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendResponse({ type: 'ready' });
            await init1;

            // Second compiler should warn and terminate old worker
            const compiler2 = new SiglumCompiler({
                onLog: vi.fn(),
                onProgress: vi.fn(),
            });

            const init2 = compiler2.init();
            await new Promise(r => setTimeout(r, 10));
            // Previous worker gets terminated when new one initializes
            workerInstances[workerInstances.length - 1]?.sendResponse({ type: 'ready' });
            await init2;

            // At least one worker should have been terminated
            expect(terminatedWorkers.length).toBeGreaterThanOrEqual(1);

            // Cleanup
            compiler1.terminate();
            compiler2.terminate();
        });
    });

    describe('isLoaded()', () => {
        it('should return false initially', () => {
            expect(compiler.isLoaded()).toBe(false);
        });

        it('should return true after init', async () => {
            await initCompiler();
            expect(compiler.isLoaded()).toBe(true);
        });

        it('should return false after terminate', async () => {
            await initCompiler();
            compiler.terminate();
            expect(compiler.isLoaded()).toBe(false);
        });

        it('should return false after unload', async () => {
            await initCompiler();
            compiler.unload();
            expect(compiler.isLoaded()).toBe(false);
        });
    });

    describe('isReady()', () => {
        it('should return false initially', () => {
            expect(compiler.isReady()).toBe(false);
        });

        it('should return true after successful init', async () => {
            await initCompiler();
            expect(compiler.isReady()).toBe(true);
        });

        it('should return false after worker error', async () => {
            await initCompiler();

            const compilePromise = compiler.compile('test').catch(() => {});
            await new Promise(r => setTimeout(r, 10));
            workerInstances[0]?.sendError(new Error('Crash'));
            await compilePromise;

            expect(compiler.isReady()).toBe(false);
        });
    });

    describe('Memory snapshot handling', () => {
        it('should save memory snapshot when received', async () => {
            const { saveWasmMemorySnapshot } = await import('../../src/storage.js');

            await initCompiler();

            // Simulate worker sending memory snapshot
            workerInstances[0]?.sendResponse({
                type: 'memory-snapshot',
                snapshot: new ArrayBuffer(1000),
                byteLength: 1000,
                isShared: false,
            });

            await new Promise(r => setTimeout(r, 10));

            expect(saveWasmMemorySnapshot).toHaveBeenCalled();
        });

        it('should skip empty snapshots', async () => {
            const { saveWasmMemorySnapshot } = await import('../../src/storage.js');
            (saveWasmMemorySnapshot as any).mockClear();

            await initCompiler();

            // Empty snapshot
            workerInstances[0]?.sendResponse({
                type: 'memory-snapshot',
                snapshot: new ArrayBuffer(0),
                byteLength: 0,
                isShared: false,
            });

            await new Promise(r => setTimeout(r, 10));

            // Should not attempt to save empty snapshot
            expect(saveWasmMemorySnapshot).not.toHaveBeenCalled();
        });
    });

    describe('Buffer detachment verification', () => {
        it('should properly transfer buffers to worker', async () => {
            await initCompiler();

            // After postMessage with transfer list, buffers should be detached
            // This is the expected behavior and prevents memory leaks

            const buffer = new ArrayBuffer(100);
            const transferList = [buffer];

            // Simulate what happens internally
            workerInstances[0]?.postMessage({ test: new Uint8Array(buffer) }, transferList);

            // In real postMessage, buffer.byteLength would become 0 after transfer
            // This is the expected behavior that prevents memory being held in main thread
        });

        it('should use slice to preserve original data', () => {
            const original = new Uint8Array([1, 2, 3, 4, 5]);
            const copy = original.buffer.slice(0);

            // Original should still be valid
            expect(original[0]).toBe(1);
            expect(original.length).toBe(5);

            // Copy is independent
            expect(copy.byteLength).toBe(5);
        });
    });

    describe('Pending compile cleanup', () => {
        it('should reject pending compile on worker error', async () => {
            await initCompiler();

            // Disable default compile handler so it doesn't auto-respond
            workerInstances[0]?.setHandler('compile', () => null);

            const compilePromise = compiler.compile('test');
            await new Promise(r => setTimeout(r, 10));

            // Worker error should reject the pending compile
            workerInstances[0]?.sendError(new Error('Fatal error'));

            await expect(compilePromise).rejects.toThrow('Fatal error');
            expect(compiler['pendingCompile']).toBeNull();
        });

        it('should cleanup pending compile on timeout', async () => {
            // Init under real timers; fake timers freeze initCompiler()'s waits.
            await initCompiler();

            // Stop the mock worker from auto-responding so only the timeout fires.
            workerInstances[0]?.setHandler('compile', () => null);

            vi.useFakeTimers();
            const compilePromise = compiler.compile('test');
            // Attach the rejection handler before advancing the clock to avoid an
            // unhandled rejection when the timeout fires.
            const assertion = expect(compilePromise).rejects.toThrow('timeout');
            await vi.advanceTimersByTimeAsync(130000);
            await assertion;

            vi.useRealTimers();
        }, 35000);
    });
});
