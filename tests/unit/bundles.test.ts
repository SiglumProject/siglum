/**
 * Tests for bundles.js - Bundle loading and package resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BundleManager, detectEngine, extractPreamble, hashPreamble } from '../../src/bundles.js';
import bundleRegistry from '../../packages/bundles/bundles.json';
import {
    SAMPLE_FILE_MANIFEST,
    SAMPLE_BUNDLES_JSON,
    SAMPLE_PACKAGE_MAP,
    SAMPLE_BUNDLE_DEPS,
    createMockBundleData,
} from '../setup/fixtures/manifests';
import {
    SIMPLE_DOCUMENT,
    XELATEX_DOCUMENT,
    DOCUMENT_WITH_PACKAGE,
    DOCUMENT_WITH_MULTIPLE_PACKAGES,
    DOCUMENT_WITH_COMBINED_PACKAGES,
    DOCUMENT_WITH_REQUIRE,
    DOCUMENT_WITH_CUSTOM_CLASS,
    DOCUMENT_NO_BEGIN,
    PREAMBLE_ONLY,
} from '../setup/fixtures/latex-samples';
import { mockFileSystem, resetMockFileSystem } from '../setup/mocks/filesystem';

const COMMAND_BUNDLES = {
    ...SAMPLE_BUNDLES_JSON,
    sourceCommands: { FixtureCommand: ['hyperref'] },
};

// Mock the @siglum/filesystem module. Use an async factory with a dynamic import
// rather than referencing the top-level mockFileSystem binding: vi.mock is hoisted
// above the imports, so referencing it directly can throw "Cannot access
// '__vi_import__' before initialization".
vi.mock('@siglum/filesystem', async () => {
    const { mockFileSystem } = await import('../setup/mocks/filesystem');
    return { fileSystem: mockFileSystem };
});

// Mock storage module
vi.mock('../../src/storage.js', async () => {
    const actual = await vi.importActual('../../src/storage.js');
    return {
        ...actual,
        getBundleFromCache: vi.fn().mockResolvedValue(null),
        saveBundleToCache: vi.fn().mockResolvedValue(true),
        getManifestFromCache: vi.fn().mockResolvedValue(null),
        saveManifestToCache: vi.fn().mockResolvedValue(true),
        getManifestVersion: vi.fn().mockResolvedValue(0),
        saveManifestVersion: vi.fn().mockResolvedValue(true),
        MANIFEST_CACHE_VERSION: 5,
    };
});

describe('bundles module', () => {
    describe('detectEngine', () => {
        it('should return pdflatex for simple document', () => {
            expect(detectEngine(SIMPLE_DOCUMENT)).toBe('pdflatex');
        });

        it('should return xelatex when fontspec is used', () => {
            expect(detectEngine(XELATEX_DOCUMENT)).toBe('xelatex');
        });

        it('should return xelatex when unicode-math is used', () => {
            const doc = '\\usepackage{unicode-math}';
            expect(detectEngine(doc)).toBe('xelatex');
        });

        it('should return xelatex when setmainfont is used', () => {
            const doc = '\\setmainfont{Arial}';
            expect(detectEngine(doc)).toBe('xelatex');
        });

        it('should return xelatex when setsansfont is used', () => {
            const doc = '\\setsansfont{Helvetica}';
            expect(detectEngine(doc)).toBe('xelatex');
        });

        it('should return xelatex when setmonofont is used', () => {
            const doc = '\\setmonofont{Courier}';
            expect(detectEngine(doc)).toBe('xelatex');
        });

        it('should return pdflatex for document with amsmath', () => {
            expect(detectEngine(DOCUMENT_WITH_PACKAGE)).toBe('pdflatex');
        });

        it('should return pdflatex for empty string', () => {
            expect(detectEngine('')).toBe('pdflatex');
        });

        it('should handle fontspec in comments (still detects)', () => {
            // Note: The implementation doesn't check for comments
            const doc = '% \\usepackage{fontspec}';
            // This will still detect as xelatex because it's a simple string check
            expect(detectEngine(doc)).toBe('xelatex');
        });
    });

    describe('extractPreamble', () => {
        it('should extract preamble before \\begin{document}', () => {
            const preamble = extractPreamble(SIMPLE_DOCUMENT);
            expect(preamble).toBe('\\documentclass{article}\n');
        });

        it('should return empty string if no \\begin{document}', () => {
            const preamble = extractPreamble(DOCUMENT_NO_BEGIN);
            expect(preamble).toBe('');
        });

        it('should return full content for preamble-only document', () => {
            // PREAMBLE_ONLY has no \begin{document}
            const preamble = extractPreamble(PREAMBLE_ONLY);
            expect(preamble).toBe('');
        });

        it('should handle document with packages', () => {
            const preamble = extractPreamble(DOCUMENT_WITH_MULTIPLE_PACKAGES);
            expect(preamble).toContain('\\usepackage{amsmath}');
            expect(preamble).toContain('\\usepackage{graphicx}');
            expect(preamble).not.toContain('Hello with packages');
        });

        it('ignores document delimiters inside comments and macro definitions', () => {
            const prefix = '% example: \\begin{document}\n\\documentclass{article}\n\\newcommand{\\later}{\\begin{document}}\n';
            expect(extractPreamble(prefix + '\\begin{document}Actual body')).toBe(prefix);
        });
        it('keeps escaped percent signs and accepts whitespace before the document argument', () => {
            const prefix = '\\documentclass{article}\n\\newcommand{\\percentage}{10\\%}\n';
            expect(extractPreamble(prefix + '\\begin {document}Actual body')).toBe(prefix);
        });
        it('declines uncertain preamble execution instead of caching a guessed boundary', () => {
            for (const prefix of ['\\iffalse ', '\\catcode37=12 ', '\\begin{filecontents}{local.tex} ']) {
                expect(extractPreamble(prefix + '\\begin{document}')).toBe('');
            }
        });

        it('should handle empty string', () => {
            expect(extractPreamble('')).toBe('');
        });

        it('should handle document class options', () => {
            const doc = '\\documentclass[12pt]{article}\n\\begin{document}\nText\\end{document}';
            const preamble = extractPreamble(doc);
            expect(preamble).toBe('\\documentclass[12pt]{article}\n');
        });
    });

    describe('hashPreamble', () => {
        it('should hash preamble consistently', () => {
            const preamble = '\\documentclass{article}';
            const hash1 = hashPreamble(preamble);
            const hash2 = hashPreamble(preamble);
            expect(hash1).toBe(hash2);
        });

        it('should produce different hashes for different preambles', () => {
            const hash1 = hashPreamble('\\documentclass{article}');
            const hash2 = hashPreamble('\\documentclass{report}');
            expect(hash1).not.toBe(hash2);
        });

        it('should handle empty string', () => {
            const hash = hashPreamble('');
            expect(hash).toBeDefined();
            expect(typeof hash).toBe('string');
        });
    });

    describe('BundleManager', () => {
        let manager: BundleManager;
        let fetchMock: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            resetMockFileSystem();

            // Setup fetch mock
            fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);

            manager = new BundleManager({
                bundleBase: 'http://test.com/bundles',
                onLog: vi.fn(),
                onProgress: vi.fn(),
            });
        });

        afterEach(() => {
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
        });

        describe('constructor', () => {
            it('should set default bundleBase', () => {
                const defaultManager = new BundleManager();
                expect(defaultManager.bundleBase).toBe('packages/bundles');
            });

            it('should accept custom bundleBase', () => {
                expect(manager.bundleBase).toBe('http://test.com/bundles');
            });

            it('should initialize empty bundle cache', () => {
                expect(manager.bundleCache.size).toBe(0);
            });

            it('should accept callbacks', () => {
                const onLog = vi.fn();
                const onProgress = vi.fn();
                const m = new BundleManager({ onLog, onProgress });
                m.onLog('test');
                expect(onLog).toHaveBeenCalledWith('test');
            });
        });

        describe('loadManifest', () => {
            it('should fetch manifest from server', async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    return Promise.resolve({ ok: false });
                });

                const manifest = await manager.loadManifest();
                expect(manifest).toEqual(SAMPLE_FILE_MANIFEST);
                expect(manager.fileManifest).toEqual(SAMPLE_FILE_MANIFEST);
            });

            it('should return cached manifest on subsequent calls', async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    return Promise.resolve({ ok: false });
                });

                await manager.loadManifest();
                await manager.loadManifest();

                // Should only fetch once
                expect(fetchMock).toHaveBeenCalledTimes(2); // manifest + bundles
            });

            it('should initialize packageMap from bundles.json', async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    return Promise.resolve({ ok: false });
                });

                await manager.loadManifest();
                expect(manager.packageMap).toEqual({ ...SAMPLE_BUNDLES_JSON.packages, amsgen: 'amsmath', keyval: 'graphics' });
            });

            it('infers any uniquely bundled style or class without changing cached metadata', () => {
                manager.fileManifest = {
                    '/texlive/tex/latex/arbitrary/custom.sty': { bundle: 'one' },
                    '/texlive/tex/latex/arbitrary/customclass.cls': { bundle: 'two' },
                    '/texlive/tex/latex/arbitrary/ignored.sty': { bundle: 'missing' },
                } as any;
                const metadata = { packages: {}, bundles: { one: {}, two: {} } };
                manager._initFromBundlesData(metadata);
                expect(manager.packageMap).toEqual({ custom: 'one', customclass: 'two' });
                expect(metadata.packages).toEqual({});
            });

            it('keeps explicit owners and refuses ambiguous inferred names', () => {
                manager.fileManifest = {
                    '/texlive/one/explicit.sty': { bundle: 'one' },
                    '/texlive/one/shared.sty': { bundle: 'one' },
                    '/texlive/two/shared.sty': { bundle: 'two' },
                } as any;
                manager._initFromBundlesData({ packages: { explicit: 'two' }, bundles: { one: {}, two: {} } });
                expect(manager.packageMap).toEqual({ explicit: 'two' });
            });

            it('routes a bundled type1ec style through CM-Super without CTAN prefetch', async () => {
                const type1ecPath = '/texlive/texmf-dist/tex/latex/cm-super/type1ec.sty';
                const manifest = {
                    ...SAMPLE_FILE_MANIFEST,
                    [type1ecPath]: { bundle: 'cm-super', start: 0, end: 16, size: 16 },
                };
                const bundles = { ...SAMPLE_BUNDLES_JSON, bundles: {
                    ...SAMPLE_BUNDLES_JSON.bundles, 'cm-super': { files: 1, size: 16 },
                } };
                fetchMock.mockImplementation(async (url: string) => ({
                    ok: true,
                    json: async () => url.includes('file-manifest.json') ? manifest : bundles,
                }));
                await manager.loadManifest();

                const source = String.raw`\usepackage{type1ec}`;
                expect(manager.checkPackages(source, 'pdflatex').bundles).toContain('cm-super');
                expect(manager.prescanForCtanPackages(source).ctanPackages).not.toContain('type1ec');
            });

            it('should initialize bundleRegistry', async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    return Promise.resolve({ ok: false });
                });

                await manager.loadManifest();
                expect(manager.bundleRegistry).toBeInstanceOf(Set);
                expect(manager.bundleRegistry?.has('base')).toBe(true);
                expect(manager.bundleRegistry?.has('amsmath')).toBe(true);
            });
        });

        describe('bundleExists', () => {
            beforeEach(async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    return Promise.resolve({ ok: false });
                });
                await manager.loadManifest();
            });

            it('should return true for existing bundle', () => {
                expect(manager.bundleExists('base')).toBe(true);
            });

            it('should return false for non-existing bundle', () => {
                expect(manager.bundleExists('nonexistent')).toBe(false);
            });

            it('should return false before manifest is loaded', () => {
                const newManager = new BundleManager();
                expect(newManager.bundleExists('base')).toBe(false);
            });
        });

        describe('resolveBundles', () => {
            beforeEach(async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    return Promise.resolve({ ok: false });
                });
                await manager.loadManifest();
            });

            it('should resolve single package to bundle', () => {
                const bundles = manager.resolveBundles(['amsmath']);
                expect(bundles).toContain('base'); // engine required
                expect(bundles).toContain('amsmath');
            });

            it('should resolve multiple packages', () => {
                const bundles = manager.resolveBundles(['amsmath', 'graphicx']);
                expect(bundles).toContain('amsmath');
                expect(bundles).toContain('graphics');
            });

            it('should include engine-required bundles', () => {
                const bundles = manager.resolveBundles([], 'xelatex');
                expect(bundles).toContain('base');
                expect(bundles).toContain('fontspec');
            });

            it('should resolve bundle dependencies', () => {
                const bundles = manager.resolveBundles(['hyperref']);
                expect(bundles).toContain('hyperref');
                expect(bundles).toContain('graphics'); // hyperref requires graphics
            });

            it('should return empty array for no packages', () => {
                const bundles = manager.resolveBundles([]);
                // Will still include engine-required bundles
                expect(bundles).toContain('base');
            });

            it('should filter out non-existent bundles', () => {
                const bundles = manager.resolveBundles(['nonexistent']);
                expect(bundles).not.toContain('nonexistent');
            });
        });

        describe('checkPackages', () => {
            beforeEach(async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    return Promise.resolve({ ok: false });
                });
                await manager.loadManifest();
            });

            it('should extract packages from \\usepackage', () => {
                const { packages } = manager.checkPackages(DOCUMENT_WITH_PACKAGE);
                expect(packages).toContain('amsmath');
                expect(packages).toContain('article');
            });

            it('should extract multiple packages from single \\usepackage', () => {
                const { packages } = manager.checkPackages(DOCUMENT_WITH_COMBINED_PACKAGES);
                expect(packages).toContain('amsmath');
                expect(packages).toContain('amssymb');
                expect(packages).toContain('amsthm');
            });

            it('should extract documentclass', () => {
                const { packages } = manager.checkPackages(SIMPLE_DOCUMENT);
                expect(packages).toContain('article');
            });

            it('should extract \\RequirePackage', () => {
                const { packages } = manager.checkPackages(DOCUMENT_WITH_REQUIRE);
                expect(packages).toContain('xcolor');
            });

            it('should resolve packages to bundles', () => {
                const { bundles } = manager.checkPackages(DOCUMENT_WITH_PACKAGE);
                expect(bundles).toContain('amsmath');
            });

            it('should include beamer class', () => {
                const { packages } = manager.checkPackages(DOCUMENT_WITH_CUSTOM_CLASS);
                expect(packages).toContain('beamer');
            });

            it('loads bare DocumentMetadata support without CTAN', () => {
                manager._initFromBundlesData(bundleRegistry);
                const { packages, bundles } = manager.checkPackages('\\DocumentMetadata{}\n' + SIMPLE_DOCUMENT, 'pdflatex');
                expect(packages).toEqual(expect.arrayContaining(['latex-lab', 'pdfmanagement-testphase', 'tagpdf']));
                expect(bundles).toContain('tex-latex-misc');
            });

            it('loads dependencies for a configured command after an escaped percent', () => {
                manager._initFromBundlesData(COMMAND_BUNDLES);
                const source = String.raw`\% \FixtureCommand{}` + '\n' + SIMPLE_DOCUMENT;
                expect(manager.checkPackages(source, 'pdflatex').bundles).toEqual(['base', 'hyperref', 'graphics']);
            });

            it.each([
                String.raw`% \FixtureCommand{}`,
                String.raw`\\FixtureCommand{}`,
                String.raw`\FixtureCommandOther{}`,
            ])('ignores a false command match in %s', (text) => {
                manager._initFromBundlesData(COMMAND_BUNDLES);
                const { bundles } = manager.checkPackages(text + '\n' + SIMPLE_DOCUMENT, 'pdflatex');
                expect(bundles).toEqual(['base']);
            });
        });

        describe('prescanForCtanPackages', () => {
            beforeEach(async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    return Promise.resolve({ ok: false });
                });
                await manager.loadManifest();
            });

            it('should identify bundled packages', () => {
                const { bundledPackages } = manager.prescanForCtanPackages(DOCUMENT_WITH_PACKAGE);
                expect(bundledPackages).toContain('amsmath');
            });

            it('should identify packages needing CTAN fetch', () => {
                const doc = '\\documentclass{article}\\usepackage{unknownpackage}\\begin{document}\\end{document}';
                const { ctanPackages } = manager.prescanForCtanPackages(doc);
                expect(ctanPackages).toContain('unknownpackage');
            });

            it.each([
                ['\\documentclass[a4paper,9pt]{scrartcl}', true],
                ['\\documentclass[fontsize={14.0 pt}]{scrbook}', true],
                ['\\documentclass[11pt,8pt]{scrreprt}', true],
                ['\\documentclass[9pt,fontsize=11pt]{scrartcl}', false],
                ['\\documentclass[fontsize=9.5pt]{scrartcl}', false],
                ['\\documentclass{scrartcl}', false],
                ['\\documentclass[9pt]{article}', false],
            ])('detects optional size data for %s', (source, expected) => {
                const { ctanPackages } = manager.prescanForCtanPackages(source);
                expect(ctanPackages.includes('extsizes')).toBe(expected);
            });

            it('keeps project-local KOMA classes and size files ahead of the optional archive', () => {
                const source = '\\documentclass[9pt]{scrartcl}';
                for (const override of ['scrartcl.cls', 'scrsize9pt.clo', 'size9.clo']) {
                    const { ctanPackages } = manager.prescanForCtanPackages(source, 'pdflatex', {
                        ['revision/' + override]: '',
                    }, 'revision/main.tex');
                    expect(ctanPackages).not.toContain('extsizes');
                }
            });

            it('should scan additional files', () => {
                const mainDoc = '\\documentclass{article}\\begin{document}\\input{chapter}\\end{document}';
                const additionalFiles = {
                    'chapter.tex': '\\usepackage{hyperref}',
                };
                const { bundledPackages, additionalBundles } = manager.prescanForCtanPackages(mainDoc, 'pdflatex', additionalFiles);
                expect(bundledPackages).toContain('hyperref');
                expect(additionalBundles).toEqual(['hyperref', 'graphics']);
            });

            it('plans bundled dependencies of local preambles without changing plain article bundles', () => {
                const article = '\\documentclass{article}\\begin{document}Hello\\end{document}';
                expect(manager.prescanForCtanPackages(article)).toEqual({
                    bundledPackages: ['article'], ctanPackages: [], additionalBundles: [],
                });

                const source = '\\documentclass{local}\\begin{document}Hello\\end{document}';
                const local = { 'local.cls': '\\LoadClass{article}\\RequirePackage{hyperref}' };
                const planned = manager.checkPackages(source, 'pdflatex').bundles;
                expect(manager.prescanForCtanPackages(source, 'pdflatex', local, 'main.tex', planned)).toEqual({
                    bundledPackages: expect.arrayContaining(['article', 'hyperref']),
                    ctanPackages: [],
                    additionalBundles: ['hyperref', 'graphics'],
                });
            });

            it('adds command dependencies declared in a project file when CTAN is enabled', () => {
                manager._initFromBundlesData(COMMAND_BUNDLES);
                const source = '\\input{settings}\n' + SIMPLE_DOCUMENT;
                const { bundles } = manager.checkPackages(source, 'pdflatex');
                const result = manager.prescanForCtanPackages(source, 'pdflatex', {
                    'settings.tex': '\\FixtureCommand{}',
                }, 'document.tex', bundles);
                expect(result.bundledPackages).toContain('hyperref');
                expect(result.additionalBundles).toEqual(['hyperref', 'graphics']);
                expect(result.ctanPackages).toEqual([]);
            });

            it('scans local styles and classes without fetching their package names', () => {
                const result = manager.prescanForCtanPackages('\\documentclass{custom}\\usepackage{local}', 'pdflatex', {
                    'custom.cls': '\\LoadClass{article}',
                    'local.sty': new TextEncoder().encode('\\RequirePackage{externaldependency}'),
                });
                expect(result.ctanPackages).not.toContain('custom');
                expect(result.ctanPackages).not.toContain('local');
                expect(result.ctanPackages).toContain('externaldependency');
            });

            it('does not confuse tex files or classes with style packages', () => {
                const result = manager.prescanForCtanPackages('\\usepackage{csquotes,custom}', 'pdflatex', {
                    'csquotes.tex': 'a chapter', 'custom.cls': 'a class',
                });
                expect(result.ctanPackages).toContain('csquotes');
                expect(result.ctanPackages).toContain('custom');
            });

            it('prefetches exact package files without affecting class-only or local overrides', () => {
                manager.packageDeps = {
                    filePrefetch: {
                        'standalone.sty': [['currfile', 3876], ['filemod', 3572], ['gincltex', 1924]],
                    },
                };
                const source = String.raw`\documentclass{standalone}`;
                const baseline = manager.prescanForCtanPackages(source);
                expect(baseline.ctanPackages).toEqual(['standalone']);
                expect(manager.prescanForCtanPackages(source + '\n% ' + String.raw`\usepackage{standalone}`)).toEqual(baseline);
                expect(manager.prescanForCtanPackages(source + '\n' + String.raw`\\usepackage{standalone}`)).toEqual(baseline);

                const withPackage = source + '\n' + String.raw`\% \usepackage{standalone}`;
                expect(manager.prescanForCtanPackages(withPackage).ctanPackages)
                    .toEqual(['standalone', 'currfile', 'filemod', 'gincltex']);
                expect(manager.prescanForCtanPackages(withPackage, 'pdflatex', {
                    'nested/standalone.sty': '',
                }, 'nested/main.tex')).toEqual(baseline);

                expect(manager.prescanForCtanPackages(source, 'pdflatex', {
                    'local.sty': String.raw`\RequirePackage{standalone}`,
                }).ctanPackages).toEqual(['standalone', 'currfile', 'filemod', 'gincltex']);
            });

            it('admits complete file plans within the shared archive count and byte budgets', () => {
                manager.packageDeps = {
                    filePrefetch: {
                        'standalone.sty': [['shared', 20_000], ['extra', 10_000]],
                        'large.sty': [['shared', 20_000], ['oversized', 3_000]],
                        'many.sty': Array.from({ length: 5 }, (_, i) => ['archive' + i, 1]),
                        'small.sty': [['shared', 20_000], ['last', 1_000]],
                    },
                };
                const source = String.raw`\usepackage{standalone,large,many,small}`;
                expect(manager.prescanForCtanPackages(source).ctanPackages)
                    .toEqual(['standalone', 'large', 'many', 'small', 'shared', 'extra', 'last']);
            });

            it('resolves nested styles relative to the main directory, including parent paths', () => {
                const result = manager.prescanForCtanPackages('\\usepackage{styles/local,../shared}', 'pdflatex', {
                    '/revision/styles/local.sty': '\\RequirePackage{externaldependency}',
                    'shared.sty': '',
                }, 'revision/main.tex');
                expect(result.ctanPackages).not.toContain('styles/local');
                expect(result.ctanPackages).not.toContain('../shared');
                expect(result.ctanPackages).toContain('externaldependency');
                const other = manager.prescanForCtanPackages('\\usepackage{local}', 'pdflatex', {'elsewhere/local.sty': ''});
                expect(other.ctanPackages).toContain('local');
            });

            it('should return additionalBundles for dependency-only bundles', () => {
                // This tests packages that are only loaded as dependencies
                const doc = '\\documentclass{article}\\usepackage{beamer}\\begin{document}\\end{document}';
                const { additionalBundles } = manager.prescanForCtanPackages(doc);
                // beamer depends on hyperref and xcolor
                expect(additionalBundles).toBeDefined();
            });
        });

        describe('loadBundle', () => {
            beforeEach(async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    if (url.includes('.data.gz')) {
                        const bundleName = url.match(/\/([^\/]+)\.data\.gz/)?.[1] || 'unknown';
                        // Simulate a missing bundle so the 404 path can be exercised.
                        if (bundleName === 'nonexistent') {
                            return Promise.resolve({ ok: false, status: 404 });
                        }
                        const bundleData = createMockBundleData(bundleName);
                        return Promise.resolve({
                            ok: true,
                            headers: new Headers({ 'Content-Encoding': 'br' }), // Pretend brotli so no decompress
                            arrayBuffer: () => Promise.resolve(bundleData),
                        });
                    }
                    return Promise.resolve({ ok: false, status: 404 });
                });
                await manager.loadManifest();
            });

            it('should fetch bundle from server', async () => {
                const data = await manager.loadBundle('base');
                expect(data).toBeInstanceOf(ArrayBuffer);
            });

            it('should cache bundle in memory', async () => {
                await manager.loadBundle('base');
                expect(manager.bundleCache.has('base')).toBe(true);
            });

            it('should return cached bundle on second call', async () => {
                await manager.loadBundle('base');
                const callCount = fetchMock.mock.calls.length;

                await manager.loadBundle('base');
                // No additional fetch for bundle
                expect(fetchMock.mock.calls.length).toBe(callCount);
            });

            it('should throw on 404', async () => {
                await expect(manager.loadBundle('nonexistent')).rejects.toThrow();
            });

            it('should track bytes downloaded', async () => {
                await manager.loadBundle('base');
                expect(manager.bytesDownloaded).toBeGreaterThan(0);
            });
        });

        describe('loadBundles', () => {
            beforeEach(async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    if (url.includes('.data.gz')) {
                        const bundleName = url.match(/\/([^\/]+)\.data\.gz/)?.[1] || 'unknown';
                        // Simulate a missing bundle to exercise partial-failure handling.
                        if (bundleName === 'nonexistent') {
                            return Promise.resolve({ ok: false, status: 404 });
                        }
                        const bundleData = createMockBundleData(bundleName);
                        return Promise.resolve({
                            ok: true,
                            headers: new Headers({ 'Content-Encoding': 'br' }),
                            arrayBuffer: () => Promise.resolve(bundleData),
                        });
                    }
                    return Promise.resolve({ ok: false, status: 404 });
                });
                await manager.loadManifest();
            });

            it('should load multiple bundles in parallel', async () => {
                const bundles = await manager.loadBundles(['base', 'amsmath']);
                expect(bundles['base']).toBeInstanceOf(ArrayBuffer);
                expect(bundles['amsmath']).toBeInstanceOf(ArrayBuffer);
            });

            it('should handle partial failures', async () => {
                const bundles = await manager.loadBundles(['base', 'nonexistent']);
                expect(bundles['base']).toBeInstanceOf(ArrayBuffer);
                expect(bundles['nonexistent']).toBeUndefined();
            });
        });

        describe('getStats', () => {
            it('should return statistics', async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    if (url.includes('.data.gz')) {
                        return Promise.resolve({
                            ok: true,
                            headers: new Headers({ 'Content-Encoding': 'br' }),
                            arrayBuffer: () => Promise.resolve(new ArrayBuffer(1000)),
                        });
                    }
                    return Promise.resolve({ ok: false });
                });
                await manager.loadManifest();
                await manager.loadBundle('base');

                const stats = manager.getStats();
                expect(stats.bytesDownloaded).toBeGreaterThan(0);
                expect(stats.bundlesCached).toBe(1);
            });
        });

        describe('clearCache', () => {
            it('should clear in-memory cache', async () => {
                fetchMock.mockImplementation((url: string) => {
                    if (url.includes('file-manifest.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_FILE_MANIFEST),
                        });
                    }
                    if (url.includes('bundles.json')) {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(SAMPLE_BUNDLES_JSON),
                        });
                    }
                    if (url.includes('.data.gz')) {
                        return Promise.resolve({
                            ok: true,
                            headers: new Headers({ 'Content-Encoding': 'br' }),
                            arrayBuffer: () => Promise.resolve(new ArrayBuffer(1000)),
                        });
                    }
                    return Promise.resolve({ ok: false });
                });
                await manager.loadManifest();
                await manager.loadBundle('base');
                expect(manager.bundleCache.size).toBe(1);

                manager.clearCache();
                expect(manager.bundleCache.size).toBe(0);
            });
        });
    });
});
