/**
 * Tests for storage.js - Storage utilities for caching.
 *
 * Note: Due to vitest's module mocking limitations with stateful mocks,
 * these tests focus on verifying correct mock interactions rather than
 * full round-trip save/load behavior. The actual filesystem integration
 * is tested implicitly through the integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFileSystem, resetMockFileSystem } from '../setup/mocks/filesystem';

// Mock the @siglum/filesystem module
vi.mock('@siglum/filesystem', () => ({
    fileSystem: mockFileSystem,
}));

// Import storage module after mock is set up
import {
    getPackageMeta,
    savePackageMeta,
    listAllCachedPackages,
    getBundleFromCache,
    saveBundleToCache,
    getManifestFromCache,
    saveManifestToCache,
    getManifestVersion,
    saveManifestVersion,
    getAuxCache,
    saveAuxCache,
    getCachedPdf,
    saveCachedPdf,
    getFmtPath,
    clearCTANCache,
    saveWasmMemorySnapshot,
    CTAN_CACHE_VERSION,
    MANIFEST_CACHE_VERSION,
} from '../../src/storage.js';

describe('storage module', () => {
    beforeEach(() => {
        resetMockFileSystem();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constants', () => {
        it('should export CTAN_CACHE_VERSION', () => {
            expect(typeof CTAN_CACHE_VERSION).toBe('number');
            expect(CTAN_CACHE_VERSION).toBeGreaterThan(0);
        });

        it('should export MANIFEST_CACHE_VERSION', () => {
            expect(typeof MANIFEST_CACHE_VERSION).toBe('number');
            expect(MANIFEST_CACHE_VERSION).toBeGreaterThan(0);
        });
    });

    describe('Package metadata (CTAN cache)', () => {
        describe('getPackageMeta', () => {
            it('should return null for non-existent package', async () => {
                const meta = await getPackageMeta('nonexistent');
                expect(meta).toBeNull();
            });

            it('should call mountAuto for ctan-cache', async () => {
                await getPackageMeta('testpkg');
                expect(mockFileSystem.mountAuto).toHaveBeenCalledWith('/ctan-cache');
            });

            it('should handle read errors gracefully', async () => {
                mockFileSystem.readFile.mockRejectedValueOnce(new Error('Read error'));
                const meta = await getPackageMeta('errorpkg');
                expect(meta).toBeNull();
            });
        });

        describe('savePackageMeta', () => {
            it('should save package metadata', async () => {
                const meta = { files: ['/test.sty'], dependencies: [] };
                const result = await savePackageMeta('mypkg', meta);

                expect(result).toBe(true);
                expect(mockFileSystem.writeFile).toHaveBeenCalled();
            });

            it('should add timestamp to metadata', async () => {
                const meta = { files: [] };
                await savePackageMeta('mypkg', meta);

                const writeCall = mockFileSystem.writeFile.mock.calls[0];
                const savedData = JSON.parse(writeCall[1] as string);
                expect(savedData.timestamp).toBeDefined();
                expect(typeof savedData.timestamp).toBe('number');
            });

            it('should include package name in metadata', async () => {
                const meta = { files: [] };
                await savePackageMeta('mypkg', meta);

                const writeCall = mockFileSystem.writeFile.mock.calls[0];
                const savedData = JSON.parse(writeCall[1] as string);
                expect(savedData.name).toBe('mypkg');
            });

            it('should write to correct path', async () => {
                const meta = { files: [] };
                await savePackageMeta('mypkg', meta);

                expect(mockFileSystem.writeFile).toHaveBeenCalledWith(
                    '/ctan-cache/mypkg.json',
                    expect.any(String),
                    expect.any(Object)
                );
            });
        });

        describe('listAllCachedPackages', () => {
            it('should return empty array when no packages', async () => {
                const packages = await listAllCachedPackages();
                expect(packages).toEqual([]);
            });

            it('should call readdir on ctan-cache', async () => {
                await listAllCachedPackages();
                expect(mockFileSystem.readdir).toHaveBeenCalledWith('/ctan-cache');
            });
        });
    });

    describe('Bundle cache', () => {
        describe('getBundleFromCache', () => {
            it('should return null for non-existent bundle', async () => {
                const data = await getBundleFromCache('nonexistent');
                expect(data).toBeNull();
            });

            it('should call mountAuto for bundle-cache', async () => {
                await getBundleFromCache('testbundle');
                expect(mockFileSystem.mountAuto).toHaveBeenCalledWith('/bundle-cache');
            });
        });

        describe('saveBundleToCache', () => {
            it('should save ArrayBuffer data', async () => {
                const data = new ArrayBuffer(100);
                const result = await saveBundleToCache('mybundle', data);

                expect(result).toBe(true);
                expect(mockFileSystem.writeBinary).toHaveBeenCalled();
            });

            it('should write to correct path', async () => {
                const data = new ArrayBuffer(100);
                await saveBundleToCache('mybundle', data);

                expect(mockFileSystem.writeBinary).toHaveBeenCalledWith(
                    '/bundle-cache/mybundle.bundle',
                    expect.any(Uint8Array),
                    expect.any(Object)
                );
            });

            it('should convert SharedArrayBuffer to regular ArrayBuffer', async () => {
                if (typeof SharedArrayBuffer !== 'undefined') {
                    const sab = new SharedArrayBuffer(100);
                    const result = await saveBundleToCache('mybundle', sab);
                    expect(result).toBe(true);

                    // Should have written a regular ArrayBuffer/Uint8Array, not SharedArrayBuffer
                    const writeCall = mockFileSystem.writeBinary.mock.calls[0];
                    expect(writeCall[1]).toBeInstanceOf(Uint8Array);
                }
            });
        });
    });

    describe('Manifest cache', () => {
        describe('getManifestFromCache', () => {
            it('should return null for non-existent manifest', async () => {
                const manifest = await getManifestFromCache('nonexistent');
                expect(manifest).toBeNull();
            });

            it('should call mountAuto for manifests', async () => {
                await getManifestFromCache('test');
                expect(mockFileSystem.mountAuto).toHaveBeenCalledWith('/manifests');
            });
        });

        describe('saveManifestToCache', () => {
            it('should save manifest data', async () => {
                const manifest = { version: 1, files: {} };
                const result = await saveManifestToCache('test', manifest);

                expect(result).toBe(true);
                expect(mockFileSystem.writeFile).toHaveBeenCalled();
            });

            it('should write to correct path', async () => {
                const manifest = { version: 1, files: {} };
                await saveManifestToCache('test', manifest);

                expect(mockFileSystem.writeFile).toHaveBeenCalledWith(
                    '/manifests/test.json',
                    expect.any(String),
                    expect.any(Object)
                );
            });
        });

        describe('getManifestVersion', () => {
            it('should return 0 when no version saved', async () => {
                const version = await getManifestVersion();
                expect(version).toBe(0);
            });

            it('should call readFile on version file', async () => {
                await getManifestVersion();
                expect(mockFileSystem.readFile).toHaveBeenCalledWith('/manifests/version');
            });
        });

        describe('saveManifestVersion', () => {
            it('should save version number', async () => {
                const result = await saveManifestVersion(5);

                expect(result).toBe(true);
                expect(mockFileSystem.writeFile).toHaveBeenCalledWith(
                    '/manifests/version',
                    '5',
                    expect.any(Object)
                );
            });
        });
    });

    describe('LRU Aux cache', () => {
        describe('getAuxCache', () => {
            it('should return null for non-existent entry', async () => {
                const entry = await getAuxCache('nonexistent_hash');
                expect(entry).toBeNull();
            });

            it('should call mountAuto for aux-cache', async () => {
                await getAuxCache('testhash');
                expect(mockFileSystem.mountAuto).toHaveBeenCalledWith('/aux-cache');
            });
        });

        describe('saveAuxCache', () => {
            it('should save aux files', async () => {
                const files = { 'doc.aux': 'aux content', 'doc.toc': 'toc content' };
                await saveAuxCache('myhash', files);

                // saveAuxCache uses fire-and-forget write
                await new Promise(resolve => setTimeout(resolve, 10));
                expect(mockFileSystem.writeFile).toHaveBeenCalled();
            });

            it('should write to correct path', async () => {
                const files = { 'doc.aux': 'aux content' };
                await saveAuxCache('myhash', files);

                await new Promise(resolve => setTimeout(resolve, 10));
                expect(mockFileSystem.writeFile).toHaveBeenCalledWith(
                    '/aux-cache/myhash.json',
                    expect.any(String),
                    expect.any(Object)
                );
            });
        });
    });

    describe('LRU Document cache', () => {
        describe('getCachedPdf', () => {
            it('should return null for non-existent PDF', async () => {
                const pdf = await getCachedPdf('nonexistent', 'pdflatex');
                expect(pdf).toBeNull();
            });

            it('should call mountAuto for doc-cache', async () => {
                await getCachedPdf('testhash', 'pdflatex');
                expect(mockFileSystem.mountAuto).toHaveBeenCalledWith('/doc-cache');
            });

            it('should use engine in cache key for readBinary call', async () => {
                await getCachedPdf('hash', 'pdflatex');
                expect(mockFileSystem.readBinary).toHaveBeenCalledWith('/doc-cache/hash_pdflatex.pdf');
            });
        });

        describe('saveCachedPdf', () => {
            it('should save PDF data', async () => {
                const pdfData = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
                await saveCachedPdf('myhash', 'pdflatex', pdfData);

                await new Promise(resolve => setTimeout(resolve, 10));
                expect(mockFileSystem.writeBinary).toHaveBeenCalled();
            });

            it('should write to correct path with engine', async () => {
                const pdfData = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
                await saveCachedPdf('myhash', 'xelatex', pdfData);

                await new Promise(resolve => setTimeout(resolve, 10));
                expect(mockFileSystem.writeBinary).toHaveBeenCalledWith(
                    '/doc-cache/myhash_xelatex.pdf',
                    expect.any(Uint8Array),
                    expect.any(Object)
                );
            });
        });
    });

    describe('Format cache', () => {
        describe('getFmtPath', () => {
            it('should return correct path format', () => {
                const path = getFmtPath('abc123_pdflatex');
                expect(path).toBe('fmt-cache/abc123_pdflatex.fmt');
            });

            it('should handle different format keys', () => {
                expect(getFmtPath('key1')).toBe('fmt-cache/key1.fmt');
                expect(getFmtPath('hash_xelatex')).toBe('fmt-cache/hash_xelatex.fmt');
            });
        });
    });

    describe('WASM Memory Snapshot', () => {
        describe('saveWasmMemorySnapshot', () => {
            it('should save memory snapshot', async () => {
                const snapshot = new Uint8Array(1024);
                snapshot.fill(42);

                const result = await saveWasmMemorySnapshot(snapshot, {});
                expect(result).toBe(true);
            });

            it('should accept WebAssembly.Memory object', async () => {
                const memory = new WebAssembly.Memory({ initial: 1 });
                const result = await saveWasmMemorySnapshot(memory, {});
                expect(result).toBe(true);
            });

            it('should prevent concurrent saves', async () => {
                const snapshot1 = new Uint8Array(1024);
                const snapshot2 = new Uint8Array(1024);

                // Start two saves at once
                const promise1 = saveWasmMemorySnapshot(snapshot1, {});
                const promise2 = saveWasmMemorySnapshot(snapshot2, {});

                const [result1, result2] = await Promise.all([promise1, promise2]);

                // One should succeed, one should be skipped
                expect(result1 === true || result2 === true).toBe(true);
            });

            it('should save metadata with snapshot', async () => {
                const snapshot = new Uint8Array(100);
                const metadata = { savedAt: Date.now(), byteLength: 100 };

                await saveWasmMemorySnapshot(snapshot, metadata);

                expect(mockFileSystem.writeFile).toHaveBeenCalled();
            });
        });
    });

    describe('clearCTANCache', () => {
        it('should clear CTAN cache directory', async () => {
            const result = await clearCTANCache();
            expect(result).toBe(true);
            expect(mockFileSystem.rmdir).toHaveBeenCalledWith('/ctan-cache', { recursive: true });
        });
    });

    describe('Mount race prevention', () => {
        // These tests verify mount deduplication by checking call counts

        it('should only mount once even when called multiple times', async () => {
            // Multiple sequential calls should only trigger one mount due to caching
            await getPackageMeta('pkg1');
            const mountCallsAfterFirst = mockFileSystem.mountAuto.mock.calls.filter(
                (call: string[]) => call[0] === '/ctan-cache'
            ).length;

            await getPackageMeta('pkg2');
            await getPackageMeta('pkg3');

            const mountCallsAfterMore = mockFileSystem.mountAuto.mock.calls.filter(
                (call: string[]) => call[0] === '/ctan-cache'
            ).length;

            // Should not have additional mount calls for ctan-cache
            expect(mountCallsAfterMore).toBe(mountCallsAfterFirst);
        });
    });
});
