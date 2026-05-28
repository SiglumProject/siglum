/**
 * Integration tests for compilation flow.
 * Tests the complete compilation pipeline from source to PDF.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFileSystem, resetMockFileSystem } from '../setup/mocks/filesystem';
import { MockCompilerWorker } from '../setup/mocks/worker';
import {
    SIMPLE_DOCUMENT,
    XELATEX_DOCUMENT,
    DOCUMENT_WITH_PACKAGE,
    DOCUMENT_WITH_REFS,
    DOCUMENT_WITH_TOC,
} from '../setup/fixtures/latex-samples';

// Create mock bundle manager factory
const createMockBundleManager = () => ({
    bundleBase: 'packages/bundles',
    bundleCache: new Map(),
    fileManifest: { 'base/article.cls': 'base' },
    packageMap: { 'article': 'base', 'amsmath': 'amsmath' },
    bundleDeps: {
        engines: { pdflatex: ['base'], xelatex: ['base', 'fontspec'] },
        bundles: {},
        deferred: ['cm-super'],
    },
    bundleRegistry: new Set(['base', 'amsmath', 'fontspec']),
    onLog: vi.fn(),
    loadManifest: vi.fn().mockResolvedValue({ 'base/article.cls': 'base' }),
    loadBundleDeps: vi.fn().mockResolvedValue({}),
    bundleExists: vi.fn().mockReturnValue(true),
    resolveBundles: vi.fn().mockReturnValue(['base']),
    checkPackages: vi.fn().mockImplementation((source: string) => {
        const packages: string[] = [];
        const match = source.match(/\\usepackage\{([^}]+)\}/g);
        if (match) {
            match.forEach(m => {
                const pkg = m.match(/\{([^}]+)\}/)?.[1];
                if (pkg) packages.push(...pkg.split(',').map(p => p.trim()));
            });
        }
        return { packages, bundles: ['base'] };
    }),
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

// Mock modules
vi.mock('@siglum/filesystem', async () => {
    const { mockFileSystem } = await import('../setup/mocks/filesystem');
    return { fileSystem: mockFileSystem };
});

vi.mock('../../src/storage.js', () => ({
    getAuxCache: vi.fn().mockResolvedValue(null),
    saveAuxCache: vi.fn().mockResolvedValue(undefined),
    getCachedPdf: vi.fn().mockResolvedValue(null),
    saveCachedPdf: vi.fn().mockResolvedValue(undefined),
    hashDocument: vi.fn().mockImplementation((s: string) => {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
        return Math.abs(h).toString(16);
    }),
    getFmtPath: vi.fn().mockImplementation((k: string) => `fmt-cache/${k}.fmt`),
    clearCTANCache: vi.fn().mockResolvedValue(true),
    saveWasmMemorySnapshot: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/bundles.js', () => {
    const createMockBundleManager = () => ({
        bundleBase: 'packages/bundles',
        bundleCache: new Map(),
        fileManifest: { 'base/article.cls': 'base' },
        packageMap: { 'article': 'base', 'amsmath': 'amsmath' },
        bundleDeps: {
            engines: { pdflatex: ['base'], xelatex: ['base', 'fontspec'] },
            bundles: {},
            deferred: ['cm-super'],
        },
        bundleRegistry: new Set(['base', 'amsmath', 'fontspec']),
        onLog: vi.fn(),
        loadManifest: vi.fn().mockResolvedValue({ 'base/article.cls': 'base' }),
        loadBundleDeps: vi.fn().mockResolvedValue({}),
        bundleExists: vi.fn().mockReturnValue(true),
        resolveBundles: vi.fn().mockReturnValue(['base']),
        checkPackages: vi.fn().mockImplementation((source: string) => {
            const packages: string[] = [];
            const match = source.match(/\\usepackage\{([^}]+)\}/g);
            if (match) {
                match.forEach(m => {
                    const pkg = m.match(/\{([^}]+)\}/)?.[1];
                    if (pkg) packages.push(...pkg.split(',').map(p => p.trim()));
                });
            }
            return { packages, bundles: ['base'] };
        }),
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

describe('Compilation Flow Integration', () => {
    let compiler: SiglumCompiler;
    let workerInstances: MockCompilerWorker[] = [];

    // Helper to convert URL or string to string for comparisons
    const urlToString = (url: string | URL): string => {
        if (url instanceof URL) return url.toString();
        return url;
    };

    // Helper to create a successful compile response
    const createCompileResponse = (overrides: Record<string, any> = {}) => ({
        type: 'compile-response',
        success: true,
        pdfData: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, // %PDF
        pdfDataIsShared: false,
        stats: { totalTime: 1000 },
        log: 'Output written on document.pdf',
        ...overrides,
    });

    beforeEach(() => {
        resetMockFileSystem();
        vi.clearAllMocks();
        workerInstances = [];
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

        // Mock Worker
        (globalThis as any).Worker = class extends MockCompilerWorker {
            constructor(url: string | URL) {
                super(url);
                workerInstances.push(this);
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

    describe('Simple document compilation', () => {
        it('should compile simple document successfully', async () => {
            await initCompiler();

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse());

            const result = await compilePromise;

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();
            expect(result.pdf?.[0]).toBe(0x25); // %
            expect(result.pdf?.[1]).toBe(0x50); // P
        });

        it('should detect pdflatex engine for simple document', async () => {
            await initCompiler();

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse());

            await compilePromise;
        });
    });

    describe('XeLaTeX document compilation', () => {
        it('should detect xelatex engine for fontspec document', async () => {
            await initCompiler();

            const compilePromise = compiler.compile(XELATEX_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse());

            await compilePromise;
        });
    });

    describe('Document cache', () => {
        it('should return cached PDF for identical document', async () => {
            const { getCachedPdf } = await import('../../src/storage.js');
            const cachedPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D]);
            (getCachedPdf as any).mockResolvedValueOnce(cachedPdf);

            await initCompiler();

            const result = await compiler.compile(SIMPLE_DOCUMENT);

            expect(result.success).toBe(true);
            expect(result.cached).toBe(true);
        });

        it('should cache compiled PDF', async () => {
            const { saveCachedPdf } = await import('../../src/storage.js');

            await initCompiler();

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse());

            await compilePromise;

            // Give time for async cache save
            await new Promise(r => setTimeout(r, 10));
            expect(saveCachedPdf).toHaveBeenCalled();
        });

        it('should not use cache when useCache is false', async () => {
            const { getCachedPdf } = await import('../../src/storage.js');

            await initCompiler();

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT, { useCache: false });
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse());

            await compilePromise;

            expect(getCachedPdf).not.toHaveBeenCalled();
        });
    });

    describe('Cross-reference rerun detection', () => {
        it('should compile document with references', async () => {
            await initCompiler();

            const compilePromise = compiler.compile(DOCUMENT_WITH_REFS);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse({
                log: 'References resolved',
            }));

            const result = await compilePromise;
            expect(result.success).toBe(true);
        });
    });

    describe('TOC generation', () => {
        it('should compile document with table of contents', async () => {
            await initCompiler();

            const compilePromise = compiler.compile(DOCUMENT_WITH_TOC);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse({
                auxFilesToCache: {
                    'document.toc': '\\contentsline...',
                },
            }));

            const result = await compilePromise;
            expect(result.success).toBe(true);
        });
    });

    describe('CTAN package fetching', () => {
        it('should pre-fetch CTAN packages before compile', async () => {
            await initCompiler();

            // CTAN pre-fetch only runs when CTAN is enabled (off by default with no proxy).
            compiler.enableCtan = true;

            // Override prescanForCtanPackages to return CTAN packages
            compiler.bundleManager.prescanForCtanPackages = vi.fn().mockReturnValue({
                bundledPackages: [],
                ctanPackages: ['tikz'],
                additionalBundles: [],
            });

            const compilePromise = compiler.compile('\\usepackage{tikz}');
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse());

            await compilePromise;

            expect(compiler.ctanFetcher.batchFetchPackages).toHaveBeenCalledWith(['tikz']);
        });
    });

    describe('Bundle loading', () => {
        it('should request bundles based on packages', async () => {
            await initCompiler();

            compiler.compile(DOCUMENT_WITH_PACKAGE);
            await new Promise(r => setTimeout(r, 20));

            expect(compiler.bundleManager.checkPackages).toHaveBeenCalled();
        });
    });

    describe('Engine selection', () => {
        it('should allow explicit engine override', async () => {
            await initCompiler();

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT, { engine: 'xelatex' });
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse());

            await compilePromise;
        });
    });

    describe('Additional files injection', () => {
        it('should pass additional files to worker', async () => {
            await initCompiler();

            const additionalFiles = {
                'chapter1.tex': '\\section{Chapter 1}',
                'data.csv': new Uint8Array([1, 2, 3]),
            };

            const compilePromise = compiler.compile(
                '\\documentclass{article}\\begin{document}\\input{chapter1}\\end{document}',
                { additionalFiles }
            );
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse());

            await compilePromise;
        });
    });

    describe('Error handling', () => {
        it('should handle compilation errors gracefully', async () => {
            await initCompiler();

            // Disable auto-success so our explicit failure response drives the result.
            workerInstances[0]?.setHandler('compile', () => null);

            const compilePromise = compiler.compile('\\invalid{latex}');
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse({
                type: 'compile-response',
                success: false,
                error: 'Undefined control sequence \\invalid',
                exitCode: 1,
                log: '! Undefined control sequence.',
            });

            const result = await compilePromise;

            expect(result.success).toBe(false);
            expect(result.error).toContain('Undefined');
            expect(result.exitCode).toBe(1);
        });

        it('should handle worker errors', async () => {
            await initCompiler();

            // Disable auto-success so the worker error is what settles the compile.
            workerInstances[0]?.setHandler('compile', () => null);

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendError(new Error('Worker crashed'));

            await expect(compilePromise).rejects.toThrow('Worker');
        });

        it('should handle timeout', async () => {
            // Init under real timers; fake timers freeze initCompiler()'s waits.
            await initCompiler();

            // Stop the mock worker from auto-responding so only the timeout fires.
            workerInstances[0]?.setHandler('compile', () => null);

            vi.useFakeTimers();
            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            // Attach the rejection handler before advancing the clock to avoid an
            // unhandled rejection when the timeout fires.
            const assertion = expect(compilePromise).rejects.toThrow('timeout');
            await vi.advanceTimersByTimeAsync(130000); // 130s > 120s timeout
            await assertion;

            vi.useRealTimers();
        });
    });

    describe('Statistics', () => {
        it('should return compilation stats', async () => {
            await initCompiler();

            // Disable auto-success so our explicit stats payload drives the result.
            workerInstances[0]?.setHandler('compile', () => null);

            const compilePromise = compiler.compile(SIMPLE_DOCUMENT);
            await new Promise(r => setTimeout(r, 20));

            workerInstances[0]?.sendResponse(createCompileResponse({
                stats: {
                    totalTime: 1500,
                    wasmTime: 1200,
                    vfsTime: 100,
                    wasmHeapBytes: 64 * 1024 * 1024,
                },
            }));

            const result = await compilePromise;

            expect(result.stats).toBeDefined();
            expect(result.stats?.totalTime).toBe(1500);
        });
    });
});
