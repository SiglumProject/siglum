/**
 * Tests for VirtualFileSystem (inlined in worker.js).
 * Tests the VFS class behavior for file mounting, lazy loading, and deferred bundles.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    SAMPLE_FILE_MANIFEST,
    createMockBundleData,
} from '../setup/fixtures/manifests';

// Mock Emscripten FS and MEMFS for testing VFS behavior
interface MockFSNode {
    contents: Uint8Array | { __siglum_lazy__?: boolean; __siglum_deferred__?: boolean; bundleName: string; start: number; end: number; length: number; byteLength: number };
    usedBytes: number;
}

interface MockMEMFS {
    createNode: (parent: { contents: Record<string, MockFSNode> }, name: string, mode: number, dev: number) => MockFSNode;
    stream_ops: {
        read: (stream: unknown, buffer: unknown, offset: number, length: number, position: number) => number;
        mmap?: (stream: unknown, length: number, position: number, prot: number, flags: number) => unknown;
    };
    ops_table?: {
        file?: {
            stream?: {
                read?: (stream: unknown, buffer: unknown, offset: number, length: number, position: number) => number;
            };
        };
    };
}

interface MockFS {
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    mkdir: (path: string) => void;
    stat: (path: string) => { isDirectory: boolean };
    lookupPath: (path: string) => { node: { contents?: Record<string, MockFSNode> } };
    analyzePath: (path: string) => { exists: boolean };
    filesystems: {
        MEMFS: MockMEMFS;
    };
}

// Recreate VFS class for testing (mirrors worker.js implementation)
class VirtualFileSystem {
    FS: MockFS;
    MEMFS: MockMEMFS;
    onLog: (msg: string) => void;
    mountedFiles: Set<string>;
    mountedDirs: Set<string>;
    pendingFontMaps: Set<string>;
    bundleCache: Map<string, ArrayBuffer>;
    lazyEnabled: boolean;
    lazyMarkerSymbol: string;
    deferredMarkerSymbol: string;
    deferredBundles: Map<string, { files: Array<[string, { start: number; end: number }]>; manifest: Record<string, unknown> }>;
    onBundleNeeded: ((bundleName: string) => Promise<void>) | null;
    fetchedFiles: Map<string, Uint8Array>;
    pendingDeferredFiles: Array<{ bundleName: string; start: number; end: number }>;
    pendingDeferredBundles?: Set<string>;
    fontFileLocations?: Map<string, string>;

    constructor(FS: MockFS, options: { onLog?: (msg: string) => void; lazyEnabled?: boolean; onBundleNeeded?: (bundleName: string) => Promise<void>; fetchedFilesCache?: Map<string, Uint8Array> } = {}) {
        this.FS = FS;
        this.MEMFS = FS.filesystems.MEMFS;
        this.onLog = options.onLog || (() => {});
        this.mountedFiles = new Set();
        this.mountedDirs = new Set();
        this.pendingFontMaps = new Set();
        this.bundleCache = new Map();
        this.lazyEnabled = options.lazyEnabled || false;
        this.lazyMarkerSymbol = '__siglum_lazy__';
        this.deferredMarkerSymbol = '__siglum_deferred__';
        this.deferredBundles = new Map();
        this.onBundleNeeded = options.onBundleNeeded || null;
        this.fetchedFiles = options.fetchedFilesCache || new Map();
        this.pendingDeferredFiles = [];
    }

    mount(path: string, content: string | Uint8Array, trackFontMaps = true) {
        this._ensureDirectory(path);
        const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        try {
            this.FS.writeFile(path, data);
            this.mountedFiles.add(path);
            if (trackFontMaps) this._trackFontFile(path);
        } catch (e) {
            this.onLog(`Failed to mount ${path}: ${(e as Error).message}`);
        }
    }

    mountLazy(path: string, bundleName: string, start: number, end: number, trackFontMaps = true) {
        this._ensureDirectory(path);
        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        try {
            const parentNode = this.FS.lookupPath(dirPath).node;
            if (parentNode.contents?.[fileName]) return;
            const node = this.MEMFS.createNode(parentNode as { contents: Record<string, MockFSNode> }, fileName, 33206, 0);
            node.contents = this._createLazyMarker(bundleName, start, end);
            node.usedBytes = end - start;
            this.mountedFiles.add(path);
            if (trackFontMaps) this._trackFontFile(path);
        } catch (e) {
            this.onLog(`Failed to mount lazy ${path}: ${(e as Error).message}`);
        }
    }

    mountDeferredBundle(bundleName: string, manifest: Record<string, unknown>) {
        const bundleFiles = this._getBundleFiles(bundleName, manifest);
        if (bundleFiles.length === 0) return 0;

        this.deferredBundles.set(bundleName, { files: bundleFiles, manifest });

        const dirs = new Set<string>();
        for (const [path] of bundleFiles) {
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) dirs.add(dir);
        }
        for (const dir of dirs) this._ensureDirectoryPath(dir);

        let mounted = 0;
        for (const [path, info] of bundleFiles) {
            if (this.mountedFiles.has(path)) continue;
            this._mountDeferredFile(path, bundleName, info.start, info.end);
            mounted++;
        }
        this.onLog(`Registered ${mounted} deferred files from bundle ${bundleName}`);
        return mounted;
    }

    _mountDeferredFile(path: string, bundleName: string, start: number, end: number) {
        this._ensureDirectory(path);
        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        try {
            const parentNode = this.FS.lookupPath(dirPath).node;
            if (parentNode.contents?.[fileName]) return;
            const node = this.MEMFS.createNode(parentNode as { contents: Record<string, MockFSNode> }, fileName, 33206, 0);
            node.contents = this._createDeferredMarker(bundleName, start, end);
            node.usedBytes = end - start;
            this.mountedFiles.add(path);
        } catch (e) {
            this.onLog(`Failed to mount deferred ${path}: ${(e as Error).message}`);
        }
    }

    _createDeferredMarker(bundleName: string, start: number, end: number) {
        return { [this.deferredMarkerSymbol]: true, bundleName, start, end, length: end - start, byteLength: end - start };
    }

    isDeferredMarker(obj: unknown): boolean {
        return obj !== null && typeof obj === 'object' && (obj as Record<string, unknown>)[this.deferredMarkerSymbol] === true;
    }

    _createLazyMarker(bundleName: string, start: number, end: number) {
        return { [this.lazyMarkerSymbol]: true, bundleName, start, end, length: end - start, byteLength: end - start };
    }

    isLazyMarker(obj: unknown): boolean {
        return obj !== null && typeof obj === 'object' && (obj as Record<string, unknown>)[this.lazyMarkerSymbol] === true;
    }

    _getBundleFiles(bundleName: string, manifest: Record<string, unknown>): Array<[string, { start: number; end: number }]> {
        const bundleFiles: Array<[string, { start: number; end: number }]> = [];
        for (const [path, info] of Object.entries(manifest)) {
            if ((info as { bundle: string }).bundle === bundleName) {
                bundleFiles.push([path, info as { start: number; end: number }]);
            }
        }
        return bundleFiles;
    }

    mountBundle(bundleName: string, bundleData: ArrayBuffer, manifest: Record<string, unknown>) {
        this.bundleCache.set(bundleName, bundleData);
        let mounted = 0;
        const bundleFiles = this._getBundleFiles(bundleName, manifest);

        const dirs = new Set<string>();
        for (const [path] of bundleFiles) {
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) dirs.add(dir);
        }
        for (const dir of dirs) this._ensureDirectoryPath(dir);

        for (const [path, info] of bundleFiles) {
            if (this.mountedFiles.has(path)) continue;
            if (this.lazyEnabled) {
                this.mountLazy(path, bundleName, info.start, info.end, false);
            } else {
                const content = new Uint8Array(bundleData.slice(info.start, info.end));
                this.mount(path, content, false);
            }
            mounted++;
        }
        this.onLog(`Mounted ${mounted} files from bundle ${bundleName}`);
        return mounted;
    }

    mountCtanFiles(files: Map<string, Uint8Array> | Record<string, Uint8Array>, options: { forceOverride?: boolean } = {}) {
        const { forceOverride = false } = options;
        const filesMap = files instanceof Map ? files : new Map(Object.entries(files));
        let mounted = 0;
        for (const [path, content] of filesMap) {
            const alreadyMounted = this.mountedFiles.has(path);
            if (alreadyMounted && !forceOverride) continue;
            this.mount(path, content, true);
            mounted++;
        }
        return mounted;
    }

    resolveLazy(marker: { bundleName: string; start: number; end: number }): Uint8Array {
        const bundleData = this.bundleCache.get(marker.bundleName);
        if (!bundleData) {
            this.onLog(`ERROR: Bundle not in cache: ${marker.bundleName}`);
            return new Uint8Array(0);
        }
        return new Uint8Array(bundleData.slice(marker.start, marker.end));
    }

    resolveDeferred(marker: { bundleName: string; start: number; end: number }): Uint8Array {
        const bundleData = this.bundleCache.get(marker.bundleName);
        if (bundleData) {
            return new Uint8Array(bundleData.slice(marker.start, marker.end));
        }

        const fileKey = `${marker.bundleName}:${marker.start}:${marker.end}`;
        if (this.fetchedFiles.has(fileKey)) {
            return this.fetchedFiles.get(fileKey)!;
        }

        const alreadyPending = this.pendingDeferredFiles.some(
            f => f.bundleName === marker.bundleName && f.start === marker.start && f.end === marker.end
        );
        if (!alreadyPending) {
            this.pendingDeferredFiles.push({
                bundleName: marker.bundleName,
                start: marker.start,
                end: marker.end,
            });
        }

        return new Uint8Array(0);
    }

    storeFetchedFile(bundleName: string, start: number, end: number, data: Uint8Array) {
        const key = `${bundleName}:${start}:${end}`;
        const maxEntries = 200;
        while (this.fetchedFiles.size >= maxEntries) {
            const oldestKey = this.fetchedFiles.keys().next().value;
            this.fetchedFiles.delete(oldestKey as string);
        }
        this.fetchedFiles.set(key, data);
    }

    getPendingDeferredFiles(): Array<{ bundleName: string; start: number; end: number }> {
        const pending = this.pendingDeferredFiles || [];
        this.pendingDeferredFiles = [];
        return pending;
    }

    getPendingDeferredBundles(): string[] {
        const pending = this.pendingDeferredBundles ? [...this.pendingDeferredBundles] : [];
        if (this.pendingDeferredBundles) this.pendingDeferredBundles.clear();
        return pending;
    }

    generateLsR(basePath = '/texlive/texmf-dist'): string {
        const output = ['% ls-R -- filename database.', '% Created by Siglum VFS', ''];
        const dirs = new Map<string, string[]>();

        for (const path of this.mountedFiles) {
            if (!path.startsWith(basePath)) continue;
            const dir = path.substring(0, path.lastIndexOf('/'));
            const file = path.substring(path.lastIndexOf('/') + 1);
            if (!dirs.has(dir)) dirs.set(dir, []);
            dirs.get(dir)!.push(file);
        }

        for (const [dir, files] of [...dirs.entries()].sort()) {
            output.push(`${dir}:`);
            for (const f of files.sort()) output.push(f);
            output.push('');
        }

        return output.join('\n');
    }

    _ensureDirectory(filePath: string) {
        const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
        this._ensureDirectoryPath(dirPath);
    }

    _ensureDirectoryPath(dirPath: string) {
        if (this.mountedDirs.has(dirPath)) return;
        const parts = dirPath.split('/').filter(p => p);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            if (this.mountedDirs.has(current)) continue;
            try { this.FS.stat(current); } catch { try { this.FS.mkdir(current); } catch {} }
            this.mountedDirs.add(current);
        }
    }

    _trackFontFile(path: string) {
        if (path.endsWith('.map') && !path.endsWith('pdftex.map')) {
            this.pendingFontMaps.add(path);
        }
    }
}

describe('VirtualFileSystem', () => {
    let mockFS: MockFS;
    let vfs: VirtualFileSystem;
    let writeFileCalls: Array<[string, Uint8Array]>;
    let mkdirCalls: string[];
    let nodes: Map<string, MockFSNode>;

    beforeEach(() => {
        writeFileCalls = [];
        mkdirCalls = [];
        nodes = new Map();

        const mockMEMFS: MockMEMFS = {
            createNode: vi.fn((parent, name, mode, dev) => {
                const node: MockFSNode = {
                    contents: new Uint8Array(0),
                    usedBytes: 0,
                };
                if (parent.contents) {
                    parent.contents[name] = node;
                }
                nodes.set(name, node);
                return node;
            }),
            stream_ops: {
                read: vi.fn().mockReturnValue(0),
            },
        };

        mockFS = {
            writeFile: vi.fn((path, data) => {
                writeFileCalls.push([path, data]);
            }),
            readFile: vi.fn().mockReturnValue(new Uint8Array(0)),
            mkdir: vi.fn((path) => {
                mkdirCalls.push(path);
            }),
            stat: vi.fn().mockImplementation((path) => {
                if (mkdirCalls.includes(path)) {
                    return { isDirectory: true };
                }
                throw new Error('ENOENT');
            }),
            lookupPath: vi.fn().mockImplementation((path) => ({
                node: { contents: {} },
            })),
            analyzePath: vi.fn().mockReturnValue({ exists: false }),
            filesystems: {
                MEMFS: mockMEMFS,
            },
        };

        vfs = new VirtualFileSystem(mockFS, { onLog: vi.fn() });
    });

    describe('mount', () => {
        it('should mount string content as Uint8Array', () => {
            vfs.mount('/test/file.txt', 'test content');

            expect(writeFileCalls.length).toBe(1);
            expect(writeFileCalls[0][0]).toBe('/test/file.txt');
            expect(new TextDecoder().decode(writeFileCalls[0][1])).toBe('test content');
        });

        it('should mount Uint8Array content directly', () => {
            const content = new Uint8Array([1, 2, 3]);
            vfs.mount('/test/file.bin', content);

            expect(writeFileCalls.length).toBe(1);
            expect(writeFileCalls[0][1]).toEqual(content);
        });

        it('should create parent directories', () => {
            vfs.mount('/a/b/c/file.txt', 'content');

            expect(mkdirCalls).toContain('/a');
            expect(mkdirCalls).toContain('/a/b');
            expect(mkdirCalls).toContain('/a/b/c');
        });

        it('should track mounted files', () => {
            vfs.mount('/test.txt', 'content');

            expect(vfs.mountedFiles.has('/test.txt')).toBe(true);
        });

        it('should track font map files', () => {
            vfs.mount('/fonts/test.map', 'map content');

            expect(vfs.pendingFontMaps.has('/fonts/test.map')).toBe(true);
        });

        it('should not track pdftex.map as pending', () => {
            vfs.mount('/fonts/pdftex.map', 'content');

            expect(vfs.pendingFontMaps.has('/fonts/pdftex.map')).toBe(false);
        });
    });

    describe('mountLazy', () => {
        it('should create lazy marker', () => {
            vfs.mountLazy('/test.sty', 'base', 0, 100);

            expect(vfs.mountedFiles.has('/test.sty')).toBe(true);
            expect(mockFS.filesystems.MEMFS.createNode).toHaveBeenCalled();
        });

        it('should not mount if file already exists', () => {
            // Pre-populate the contents
            mockFS.lookupPath = vi.fn().mockReturnValue({
                node: { contents: { 'existing.sty': {} } },
            });

            vfs.mountLazy('/test/existing.sty', 'base', 0, 100);

            // Should not create a new node
            expect(vfs.mountedFiles.has('/test/existing.sty')).toBe(false);
        });
    });

    describe('mountDeferredBundle', () => {
        it('should register deferred files', () => {
            const count = vfs.mountDeferredBundle('base', SAMPLE_FILE_MANIFEST);

            expect(count).toBeGreaterThan(0);
            expect(vfs.deferredBundles.has('base')).toBe(true);
        });

        it('should not remount already mounted files', () => {
            vfs.mountedFiles.add('/texlive/texmf-dist/tex/latex/base/article.cls');

            const count = vfs.mountDeferredBundle('base', SAMPLE_FILE_MANIFEST);

            // Should skip the already mounted file
            const expectedFiles = Object.entries(SAMPLE_FILE_MANIFEST)
                .filter(([, info]) => info.bundle === 'base').length - 1;
            expect(count).toBeLessThanOrEqual(expectedFiles);
        });
    });

    describe('mountBundle', () => {
        it('should cache bundle data', () => {
            const bundleData = new ArrayBuffer(1000);
            vfs.mountBundle('test', bundleData, SAMPLE_FILE_MANIFEST);

            expect(vfs.bundleCache.has('test')).toBe(true);
        });

        it('should mount files from bundle', () => {
            const bundleData = new ArrayBuffer(5000);
            const count = vfs.mountBundle('base', bundleData, SAMPLE_FILE_MANIFEST);

            expect(count).toBeGreaterThan(0);
        });

        it('should use lazy mounting when enabled', () => {
            vfs.lazyEnabled = true;
            const bundleData = new ArrayBuffer(5000);

            vfs.mountBundle('base', bundleData, SAMPLE_FILE_MANIFEST);

            // Should have created lazy markers instead of writing files
            expect(mockFS.filesystems.MEMFS.createNode).toHaveBeenCalled();
        });
    });

    describe('mountCtanFiles', () => {
        it('should mount files from Map', () => {
            const files = new Map([
                ['/test1.sty', new Uint8Array([1, 2, 3])],
                ['/test2.sty', new Uint8Array([4, 5, 6])],
            ]);

            const count = vfs.mountCtanFiles(files);

            expect(count).toBe(2);
        });

        it('should mount files from object', () => {
            const files = {
                '/test1.sty': new Uint8Array([1, 2, 3]),
                '/test2.sty': new Uint8Array([4, 5, 6]),
            };

            const count = vfs.mountCtanFiles(files);

            expect(count).toBe(2);
        });

        it('should skip already mounted unless forceOverride', () => {
            vfs.mountedFiles.add('/existing.sty');

            const files = { '/existing.sty': new Uint8Array([1]) };
            const count = vfs.mountCtanFiles(files);

            expect(count).toBe(0);
        });

        it('should override with forceOverride option', () => {
            vfs.mountedFiles.add('/existing.sty');

            const files = { '/existing.sty': new Uint8Array([1]) };
            const count = vfs.mountCtanFiles(files, { forceOverride: true });

            expect(count).toBe(1);
        });
    });

    describe('lazy marker handling', () => {
        it('should identify lazy markers', () => {
            const marker = { __siglum_lazy__: true, bundleName: 'test', start: 0, end: 100, length: 100, byteLength: 100 };
            expect(vfs.isLazyMarker(marker)).toBe(true);
        });

        it('should not identify non-markers', () => {
            expect(vfs.isLazyMarker(null)).toBe(false);
            expect(vfs.isLazyMarker({})).toBe(false);
            expect(vfs.isLazyMarker(new Uint8Array(10))).toBe(false);
        });

        it('should resolve lazy marker to data', () => {
            const bundleData = new ArrayBuffer(100);
            new Uint8Array(bundleData).fill(42);
            vfs.bundleCache.set('test', bundleData);

            const marker = { bundleName: 'test', start: 0, end: 50 };
            const resolved = vfs.resolveLazy(marker);

            expect(resolved.length).toBe(50);
            expect(resolved[0]).toBe(42);
        });

        it('should return empty array if bundle not cached', () => {
            const marker = { bundleName: 'missing', start: 0, end: 50 };
            const resolved = vfs.resolveLazy(marker);

            expect(resolved.length).toBe(0);
        });
    });

    describe('deferred marker handling', () => {
        it('should identify deferred markers', () => {
            const marker = { __siglum_deferred__: true, bundleName: 'test', start: 0, end: 100, length: 100, byteLength: 100 };
            expect(vfs.isDeferredMarker(marker)).toBe(true);
        });

        it('should resolve if bundle is loaded', () => {
            const bundleData = new ArrayBuffer(100);
            new Uint8Array(bundleData).fill(99);
            vfs.bundleCache.set('test', bundleData);

            const marker = { bundleName: 'test', start: 10, end: 30 };
            const resolved = vfs.resolveDeferred(marker);

            expect(resolved.length).toBe(20);
            expect(resolved[0]).toBe(99);
        });

        it('should check fetchedFiles cache', () => {
            const data = new Uint8Array([1, 2, 3]);
            vfs.fetchedFiles.set('test:0:100', data);

            const marker = { bundleName: 'test', start: 0, end: 100 };
            const resolved = vfs.resolveDeferred(marker);

            expect(resolved).toBe(data);
        });

        it('should track pending requests', () => {
            const marker = { bundleName: 'missing', start: 0, end: 100 };
            vfs.resolveDeferred(marker);

            expect(vfs.pendingDeferredFiles.length).toBe(1);
            expect(vfs.pendingDeferredFiles[0]).toEqual({
                bundleName: 'missing',
                start: 0,
                end: 100,
            });
        });

        it('should not duplicate pending requests', () => {
            const marker = { bundleName: 'missing', start: 0, end: 100 };
            vfs.resolveDeferred(marker);
            vfs.resolveDeferred(marker);

            expect(vfs.pendingDeferredFiles.length).toBe(1);
        });
    });

    describe('storeFetchedFile', () => {
        it('should store file data', () => {
            const data = new Uint8Array([1, 2, 3]);
            vfs.storeFetchedFile('bundle', 0, 100, data);

            expect(vfs.fetchedFiles.get('bundle:0:100')).toBe(data);
        });

        it('should evict oldest when at capacity (200)', () => {
            // Fill to capacity
            for (let i = 0; i < 200; i++) {
                vfs.storeFetchedFile('bundle', i * 100, (i + 1) * 100, new Uint8Array([i]));
            }

            expect(vfs.fetchedFiles.size).toBe(200);

            // Add one more
            vfs.storeFetchedFile('bundle', 20000, 20100, new Uint8Array([99]));

            // Should still be at 200, oldest evicted
            expect(vfs.fetchedFiles.size).toBe(200);
            expect(vfs.fetchedFiles.has('bundle:0:100')).toBe(false); // First was evicted
        });
    });

    describe('getPendingDeferredFiles', () => {
        it('should return and clear pending files', () => {
            vfs.pendingDeferredFiles = [
                { bundleName: 'a', start: 0, end: 100 },
                { bundleName: 'b', start: 0, end: 200 },
            ];

            const pending = vfs.getPendingDeferredFiles();

            expect(pending.length).toBe(2);
            expect(vfs.pendingDeferredFiles.length).toBe(0);
        });
    });

    describe('getPendingDeferredBundles', () => {
        it('should return and clear pending bundles', () => {
            vfs.pendingDeferredBundles = new Set(['bundle1', 'bundle2']);

            const pending = vfs.getPendingDeferredBundles();

            expect(pending).toEqual(['bundle1', 'bundle2']);
            expect(vfs.pendingDeferredBundles?.size).toBe(0);
        });

        it('should return empty array if no pending bundles', () => {
            const pending = vfs.getPendingDeferredBundles();
            expect(pending).toEqual([]);
        });
    });

    describe('generateLsR', () => {
        it('should generate ls-R format', () => {
            vfs.mountedFiles.add('/texlive/texmf-dist/tex/latex/base/article.cls');
            vfs.mountedFiles.add('/texlive/texmf-dist/tex/latex/base/size10.clo');

            const lsR = vfs.generateLsR();

            expect(lsR).toContain('% ls-R');
            expect(lsR).toContain('/texlive/texmf-dist/tex/latex/base:');
            expect(lsR).toContain('article.cls');
            expect(lsR).toContain('size10.clo');
        });

        it('should exclude files outside basePath', () => {
            vfs.mountedFiles.add('/other/path/file.txt');
            vfs.mountedFiles.add('/texlive/texmf-dist/tex/file.sty');

            const lsR = vfs.generateLsR('/texlive/texmf-dist');

            expect(lsR).not.toContain('/other');
            expect(lsR).toContain('file.sty');
        });
    });

    describe('directory management', () => {
        it('should track created directories', () => {
            vfs._ensureDirectoryPath('/a/b/c');

            expect(vfs.mountedDirs.has('/a')).toBe(true);
            expect(vfs.mountedDirs.has('/a/b')).toBe(true);
            expect(vfs.mountedDirs.has('/a/b/c')).toBe(true);
        });

        it('should not recreate existing directories', () => {
            vfs.mountedDirs.add('/existing');

            vfs._ensureDirectoryPath('/existing/new');

            // mkdir should only be called for /existing/new, not /existing
            const newDirCalls = mkdirCalls.filter(p => p === '/existing');
            expect(newDirCalls.length).toBe(0);
        });
    });
});
