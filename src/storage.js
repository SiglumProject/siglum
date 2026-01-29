// Storage module - uses @siglum/filesystem for all file operations

import { fileSystem } from '@siglum/filesystem';

function getFileSystem() {
    return fileSystem;
}

let wasmCacheMounted = false;
async function ensureWasmCacheMounted() {
    if (wasmCacheMounted) return true;
    const fs = await getFileSystem();
    if (!fs) return false;
    try {
        await fs.mountAuto('/wasm-cache');
        wasmCacheMounted = true;
        return true;
    } catch (e) {
        console.warn('Failed to mount wasm-cache filesystem:', e);
        return false;
    }
}

const IDB_NAME = 'siglum-ctan-cache';
const IDB_STORE = 'packages';
const CTAN_CACHE_VERSION = 9; // Bumped to force refetch from TexLive 2025 (enumitem v3.11 fix)
const BUNDLE_CACHE_VERSION = 4;
const MANIFEST_CACHE_VERSION = 5; // Bumped: consolidated metadata into bundles.json

let idbCache = null;

// IndexedDB operations
export async function openIDBCache() {
    if (idbCache) return idbCache;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            idbCache = request.result;
            resolve(idbCache);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'name' });
            }
        };
    });
}

export async function getPackageMeta(packageName) {
    try {
        const db = await openIDBCache();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const request = store.get(packageName);
            request.onerror = () => resolve(null);
            request.onsuccess = () => resolve(request.result);
        });
    } catch (e) {
        return null;
    }
}

export async function savePackageMeta(packageName, meta) {
    try {
        const db = await openIDBCache();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const request = store.put({ name: packageName, ...meta, timestamp: Date.now() });
            request.onerror = () => resolve(false);
            request.onsuccess = () => resolve(true);
        });
    } catch (e) {
        return false;
    }
}

// List all cached CTAN packages and their file paths
export async function listAllCachedPackages() {
    try {
        const db = await openIDBCache();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const request = store.getAll();
            request.onerror = () => resolve([]);
            request.onsuccess = () => resolve(request.result || []);
        });
    } catch (e) {
        return [];
    }
}

// Mount for manifests
let manifestsMounted = false;
async function ensureManifestsMounted() {
    if (manifestsMounted) return true;
    const fs = await getFileSystem();
    if (!fs) return false;
    try {
        await fs.mountAuto('/manifests');
        manifestsMounted = true;
        return true;
    } catch (e) {
        console.warn('Failed to mount manifests filesystem:', e);
        return false;
    }
}

// Mount for format cache
let fmtCacheMounted = false;
async function ensureFmtCacheMounted() {
    if (fmtCacheMounted) return true;
    const fs = await getFileSystem();
    if (!fs) return false;
    try {
        await fs.mountAuto('/fmt-cache');
        fmtCacheMounted = true;
        return true;
    } catch (e) {
        console.warn('Failed to mount fmt-cache filesystem:', e);
        return false;
    }
}

// Backwards-compatible file operations using @siglum/filesystem
export async function readFromOPFS(filePath) {
    try {
        const fs = await getFileSystem();
        if (!fs) return null;
        // Ensure the appropriate mount exists based on path
        if (filePath.startsWith('/fmt-cache') || filePath.startsWith('fmt-cache')) {
            if (!await ensureFmtCacheMounted()) return null;
        }
        return await fs.readBinary(filePath.startsWith('/') ? filePath : '/' + filePath);
    } catch (e) {
        return null;
    }
}

export async function writeToOPFS(filePath, content) {
    try {
        const fs = await getFileSystem();
        if (!fs) return false;
        // Ensure the appropriate mount exists based on path
        if (filePath.startsWith('/fmt-cache') || filePath.startsWith('fmt-cache')) {
            if (!await ensureFmtCacheMounted()) return false;
        }
        const normalizedPath = filePath.startsWith('/') ? filePath : '/' + filePath;
        await fs.writeBinary(normalizedPath, content, { createParents: true });
        return true;
    } catch (e) {
        return false;
    }
}

// Bundle cache operations
let bundleCacheMounted = false;

async function ensureBundleCacheMounted() {
    if (bundleCacheMounted) return true;
    const fs = await getFileSystem();
    if (!fs) return false;
    try {
        await fs.mountAuto('/bundle-cache');
        bundleCacheMounted = true;

        // Check version and clear if outdated
        try {
            const versionStr = await fs.readFile('/bundle-cache/version');
            const version = parseInt(versionStr) || 0;
            if (version < BUNDLE_CACHE_VERSION) {
                if (version > 0) {
                    console.log(`Bundle cache version upgrade (${version} → ${BUNDLE_CACHE_VERSION}), clearing...`);
                }
                await fs.rmdir('/bundle-cache', { recursive: true });
                await fs.mountAuto('/bundle-cache');
            }
        } catch (e) {
            // Version file doesn't exist, will be created on first write
        }

        // Write current version
        await fs.writeFile('/bundle-cache/version', String(BUNDLE_CACHE_VERSION));
        return true;
    } catch (e) {
        console.warn('Failed to mount bundle-cache filesystem:', e);
        return false;
    }
}

export async function getBundleFromOPFS(bundleName) {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureBundleCacheMounted()) return null;

        const data = await fs.readBinary(`/bundle-cache/bundles/${bundleName}.data`);
        return data?.buffer || null;
    } catch (e) {
        return null;
    }
}

export async function saveBundleToOPFS(bundleName, data) {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureBundleCacheMounted()) return false;

        await fs.mkdir('/bundle-cache/bundles');
        // Convert SharedArrayBuffer to regular ArrayBuffer for IndexedDB compatibility
        // (SharedArrayBuffer can't be serialized for storage)
        let buffer = data;
        if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
            buffer = new ArrayBuffer(data.byteLength);
            new Uint8Array(buffer).set(new Uint8Array(data));
        }
        await fs.writeBinary(`/bundle-cache/bundles/${bundleName}.data`, new Uint8Array(buffer));
        return true;
    } catch (e) {
        console.warn(`Failed to save bundle ${bundleName}:`, e);
        return false;
    }
}

// Manifest cache
export async function getManifestFromOPFS(name) {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureManifestsMounted()) return null;

        const content = await fs.readFile(`/manifests/${name}.json`);
        return JSON.parse(content);
    } catch (e) {
        return null;
    }
}

export async function saveManifestToOPFS(name, data) {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureManifestsMounted()) return false;

        await fs.writeFile(`/manifests/${name}.json`, JSON.stringify(data), { createParents: true });
        return true;
    } catch (e) {
        return false;
    }
}

export async function getManifestVersion() {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureManifestsMounted()) return 0;

        const content = await fs.readFile('/manifests/version');
        return parseInt(content) || 0;
    } catch (e) {
        return 0;
    }
}

export async function saveManifestVersion(version) {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureManifestsMounted()) return false;

        await fs.writeFile('/manifests/version', String(version), { createParents: true });
        return true;
    } catch (e) {
        return false;
    }
}

export async function clearManifestCache() {
    try {
        const fs = await getFileSystem();
        if (!fs) return;

        await fs.rmdir('/manifests', { recursive: true });
        manifestsMounted = false; // Force remount next time
    } catch (e) {}
}

// Aux file cache
const AUX_STORE = 'aux-cache';
let auxCacheDb = null;
const auxMemoryCache = new Map();

export async function openAuxCacheDb() {
    if (auxCacheDb) return auxCacheDb;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('siglum-aux-cache', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            auxCacheDb = request.result;
            resolve(auxCacheDb);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(AUX_STORE)) {
                db.createObjectStore(AUX_STORE, { keyPath: 'hash' });
            }
        };
    });
}

export async function getAuxCache(preambleHash) {
    if (auxMemoryCache.has(preambleHash)) {
        return auxMemoryCache.get(preambleHash);
    }
    try {
        const db = await openAuxCacheDb();
        return new Promise((resolve) => {
            const tx = db.transaction(AUX_STORE, 'readonly');
            const store = tx.objectStore(AUX_STORE);
            const request = store.get(preambleHash);
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
                const result = request.result;
                if (result) auxMemoryCache.set(preambleHash, result);
                resolve(result);
            };
        });
    } catch (e) {
        return null;
    }
}

export async function saveAuxCache(preambleHash, auxFiles) {
    const entry = { hash: preambleHash, files: auxFiles, timestamp: Date.now() };
    auxMemoryCache.set(preambleHash, entry);
    try {
        const db = await openAuxCacheDb();
        const tx = db.transaction(AUX_STORE, 'readwrite');
        const store = tx.objectStore(AUX_STORE);
        store.put(entry);
    } catch (e) {}
}

// Document cache for compiled PDFs
const DOC_STORE = 'doc-cache';
let docCacheDb = null;
const docMemoryCache = new Map();
const MAX_DOC_CACHE_SIZE = 10;

export async function openDocCacheDb() {
    if (docCacheDb) return docCacheDb;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('siglum-doc-cache', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            docCacheDb = request.result;
            resolve(docCacheDb);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(DOC_STORE)) {
                db.createObjectStore(DOC_STORE, { keyPath: 'key' });
            }
        };
    });
}

// Re-export hashDocument from centralized hash module (BLAKE3-WASM)
export { hashDocument } from './hash.js';

export async function getCachedPdf(docHash, engine) {
    const key = docHash + '_' + engine;
    if (docMemoryCache.has(key)) {
        return docMemoryCache.get(key);
    }
    try {
        const db = await openDocCacheDb();
        return new Promise((resolve) => {
            const tx = db.transaction(DOC_STORE, 'readonly');
            const store = tx.objectStore(DOC_STORE);
            const request = store.get(key);
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
                const result = request.result;
                if (result) {
                    docMemoryCache.set(key, result.pdfData);
                }
                resolve(result?.pdfData || null);
            };
        });
    } catch (e) {
        return null;
    }
}

export async function saveCachedPdf(docHash, engine, pdfData) {
    const key = docHash + '_' + engine;
    docMemoryCache.set(key, pdfData);

    // Limit memory cache size
    if (docMemoryCache.size > MAX_DOC_CACHE_SIZE) {
        const firstKey = docMemoryCache.keys().next().value;
        docMemoryCache.delete(firstKey);
    }

    try {
        const db = await openDocCacheDb();
        const tx = db.transaction(DOC_STORE, 'readwrite');
        const store = tx.objectStore(DOC_STORE);
        store.put({ key, pdfData, timestamp: Date.now() });
    } catch (e) {}
}

// Format cache - format files stored at /fmt-cache/{fmtKey}.fmt

export function getFmtPath(fmtKey) {
    return `fmt-cache/${fmtKey}.fmt`;
}

// Clear all CTAN cache
export async function clearCTANCache() {
    try {
        const db = await openIDBCache();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.clear();
        await new Promise(r => tx.oncomplete = r);
        return true;
    } catch (e) {
        return false;
    }
}

// WASM cache - stores COMPILED WebAssembly.Module in IndexedDB for instant instantiation
const WASM_CACHE_VERSION = 2; // Bump to invalidate old byte caches
const WASM_DB_NAME = 'siglum-wasm-cache';
const WASM_STORE = 'modules';

let wasmCacheDb = null;

async function openWasmCacheDb() {
    if (wasmCacheDb) return wasmCacheDb;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(WASM_DB_NAME, WASM_CACHE_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            wasmCacheDb = request.result;
            resolve(wasmCacheDb);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            // Clear old stores on version upgrade
            for (const name of db.objectStoreNames) {
                db.deleteObjectStore(name);
            }
            db.createObjectStore(WASM_STORE, { keyPath: 'key' });
        };
    });
}

// Get cached WASM bytes from IndexedDB and compile to module
// We cache bytes (not Module) because WebAssembly.Module can't be serialized to IndexedDB in Chrome/Safari
export async function getCompiledWasmModule() {
    try {
        const db = await openWasmCacheDb();
        return new Promise((resolve) => {
            const tx = db.transaction(WASM_STORE, 'readonly');
            const store = tx.objectStore(WASM_STORE);
            const request = store.get('busytex');
            request.onerror = () => resolve(null);
            request.onsuccess = async () => {
                const result = request.result;
                if (result?.bytes instanceof Uint8Array) {
                    try {
                        const module = await WebAssembly.compile(result.bytes);
                        resolve(module);
                    } catch {
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            };
        });
    } catch (e) {
        console.warn('Failed to get cached WASM:', e);
        return null;
    }
}

// Save WASM bytes to IndexedDB (not Module - Module can't be serialized)
export async function saveWasmBytes(bytes) {
    try {
        const db = await openWasmCacheDb();
        return new Promise((resolve) => {
            const tx = db.transaction(WASM_STORE, 'readwrite');
            const store = tx.objectStore(WASM_STORE);
            const request = store.put({ key: 'busytex', bytes, timestamp: Date.now() });
            request.onerror = () => resolve(false);
            request.onsuccess = () => resolve(true);
        });
    } catch {
        return false;
    }
}

// WASM Memory Snapshot Cache - stores initialized WASM heap for instant restore
// This caches the WASM linear memory after first successful initialization
// Restoring from snapshot skips the ~3-5s initialization overhead
const MEMORY_SNAPSHOT_VERSION = 1;
const MEMORY_SNAPSHOT_PATH = '/wasm-cache/memory-snapshot.bin';
const MEMORY_SNAPSHOT_META_PATH = '/wasm-cache/memory-snapshot-meta.json';

// Prevent concurrent save operations (race condition protection)
let snapshotSaveInProgress = false;

// Save WASM memory snapshot after successful initialization
// Accepts either a WebAssembly.Memory object or a Uint8Array directly
// The snapshot is written to persistent storage for instant restore on next load
export async function saveWasmMemorySnapshot(memoryOrSnapshot, metadata = {}) {
    // Prevent concurrent saves - only one save operation at a time
    if (snapshotSaveInProgress) {
        console.log('Memory snapshot save already in progress, skipping');
        return false;
    }
    snapshotSaveInProgress = true;

    try {
        if (!await ensureWasmCacheMounted()) {
            console.warn('Cannot save memory snapshot - filesystem not available');
            return false;
        }

        // Accept either a memory object (with .buffer) or a Uint8Array directly
        // This avoids unnecessary copies when we already have a Uint8Array
        const snapshot = memoryOrSnapshot instanceof Uint8Array
            ? memoryOrSnapshot
            : new Uint8Array(memoryOrSnapshot.buffer);

        const byteLength = snapshot.byteLength;

        // Write snapshot binary - fileSystem handles any necessary copying internally
        const fs = await getFileSystem();
        if (!fs) return false;
        await fs.writeBinary(MEMORY_SNAPSHOT_PATH, snapshot, { createParents: true, silent: true });

        // Write metadata as JSON (small, no optimization needed)
        const metaData = {
            byteLength,
            metadata,
            timestamp: Date.now(),
            version: MEMORY_SNAPSHOT_VERSION,
        };
        await fs.writeFile(MEMORY_SNAPSHOT_META_PATH, JSON.stringify(metaData), { silent: true });

        console.log(`Saved WASM memory snapshot (${(byteLength / 1024 / 1024).toFixed(1)}MB)`);
        return true;
    } catch (e) {
        console.warn('Failed to save memory snapshot:', e);
        return false;
    } finally {
        snapshotSaveInProgress = false;
    }
}

// Restore WASM memory from cached snapshot
// Returns null if no valid snapshot exists
export async function getWasmMemorySnapshot() {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureWasmCacheMounted()) {
            return null;
        }

        // Read metadata first (small file, fast) to validate before loading large snapshot
        let metaJson;
        try {
            metaJson = await fs.readFile(MEMORY_SNAPSHOT_META_PATH);
        } catch {
            // Metadata doesn't exist - no snapshot available
            return null;
        }

        const meta = JSON.parse(metaJson);

        if (meta.version !== MEMORY_SNAPSHOT_VERSION) {
            console.log('Memory snapshot version mismatch, clearing...');
            // Clear asynchronously - don't block the return
            clearWasmMemorySnapshot().catch(() => {});
            return null;
        }

        // Read snapshot binary - this is the large (~500MB) operation
        let snapshot;
        try {
            snapshot = await fs.readBinary(MEMORY_SNAPSHOT_PATH);
        } catch {
            // Snapshot file missing (possibly corrupted state) - clear metadata
            clearWasmMemorySnapshot().catch(() => {});
            return null;
        }

        // Validate snapshot size matches metadata
        if (snapshot.byteLength !== meta.byteLength) {
            console.warn('Memory snapshot size mismatch, clearing...');
            clearWasmMemorySnapshot().catch(() => {});
            return null;
        }

        console.log(`Loaded WASM memory snapshot (${(meta.byteLength / 1024 / 1024).toFixed(1)}MB)`);
        return {
            snapshot,
            byteLength: meta.byteLength,
            metadata: meta.metadata || {},
        };
    } catch (e) {
        console.warn('Failed to get memory snapshot:', e);
        return null;
    }
}

// Clear memory snapshot (call when WASM version changes)
export async function clearWasmMemorySnapshot() {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureWasmCacheMounted()) {
            return false;
        }

        // Delete both files in parallel for efficiency
        await Promise.all([
            fs.deleteFile(MEMORY_SNAPSHOT_PATH, { silent: true }).catch(() => {}),
            fs.deleteFile(MEMORY_SNAPSHOT_META_PATH, { silent: true }).catch(() => {}),
        ]);

        console.log('Cleared WASM memory snapshot');
        return true;
    } catch (e) {
        console.warn('Failed to clear memory snapshot:', e);
        return false;
    }
}

export {
    CTAN_CACHE_VERSION,
    BUNDLE_CACHE_VERSION,
    MANIFEST_CACHE_VERSION,
    WASM_CACHE_VERSION,
    MEMORY_SNAPSHOT_VERSION,
};
