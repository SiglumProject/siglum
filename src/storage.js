/**
 * @module @siglum/engine/storage
 * Storage utilities for caching bundles, manifests, compiled PDFs, and CTAN packages.
 * Uses @siglum/filesystem for persistent file operations.
 */

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
async function openIDBCache() {
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

/**
 * Get metadata for a cached CTAN package.
 * @param {string} packageName - Package name
 * @returns {Promise<Object|null>} Package metadata or null
 */
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

/**
 * Save metadata for a CTAN package.
 * @param {string} packageName - Package name
 * @param {Object} meta - Package metadata
 * @returns {Promise<boolean>} True if saved successfully
 */
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

/**
 * List all cached CTAN packages and their metadata.
 * @returns {Promise<Object[]>} Array of package metadata objects
 */
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

// Mount for texlive/CTAN cache
let texliveMounted = false;

/**
 * Ensure the /texlive filesystem is mounted for CTAN package storage.
 * @returns {Promise<boolean>} True if mounted successfully
 */
export async function ensureTexliveMounted() {
    if (texliveMounted) return true;
    const fs = await getFileSystem();
    if (!fs) return false;
    try {
        await fs.mountAuto('/texlive');
        texliveMounted = true;
        return true;
    } catch (e) {
        console.warn('Failed to mount texlive filesystem:', e);
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

/**
 * Get a bundle from the cache.
 * @param {string} bundleName - Bundle name
 * @returns {Promise<ArrayBuffer|null>} Bundle data or null if not cached
 */
export async function getBundleFromCache(bundleName) {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureBundleCacheMounted()) return null;

        const data = await fs.readBinary(`/bundle-cache/bundles/${bundleName}.data`);
        return data?.buffer || null;
    } catch (e) {
        return null;
    }
}

/**
 * Save a bundle to the cache.
 * @param {string} bundleName - Bundle name
 * @param {ArrayBuffer|SharedArrayBuffer} data - Bundle data
 * @returns {Promise<boolean>} True if saved successfully
 */
export async function saveBundleToCache(bundleName, data) {
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

/**
 * Get a manifest from the cache.
 * @param {string} name - Manifest name (without .json extension)
 * @returns {Promise<Object|null>} Parsed manifest or null
 */
export async function getManifestFromCache(name) {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureManifestsMounted()) return null;

        const content = await fs.readFile(`/manifests/${name}.json`);
        return JSON.parse(content);
    } catch (e) {
        return null;
    }
}

/**
 * Save a manifest to the cache.
 * @param {string} name - Manifest name (without .json extension)
 * @param {Object} data - Manifest data
 * @returns {Promise<boolean>} True if saved successfully
 */
export async function saveManifestToCache(name, data) {
    try {
        const fs = await getFileSystem();
        if (!fs || !await ensureManifestsMounted()) return false;

        await fs.writeFile(`/manifests/${name}.json`, JSON.stringify(data), { createParents: true });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Get the cached manifest version number.
 * @returns {Promise<number>} Version number (0 if not set)
 */
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

/**
 * Save the manifest version number.
 * @param {number} version - Version number
 * @returns {Promise<boolean>} True if saved successfully
 */
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

// Aux file cache
const AUX_STORE = 'aux-cache';
let auxCacheDb = null;
const auxMemoryCache = new Map();

async function openAuxCacheDb() {
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

/**
 * Get cached aux files for a preamble hash.
 * @param {string} preambleHash - Hash of the document preamble
 * @returns {Promise<{hash: string, files: Object, timestamp: number}|null>} Cached entry or null
 */
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

/**
 * Save aux files for a preamble hash.
 * @param {string} preambleHash - Hash of the document preamble
 * @param {Object} auxFiles - Aux files to cache
 * @returns {Promise<void>}
 */
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

async function openDocCacheDb() {
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

/**
 * Get a cached compiled PDF.
 * @param {string} docHash - Document content hash
 * @param {string} engine - Engine used ('pdflatex', 'xelatex', 'lualatex')
 * @returns {Promise<Uint8Array|null>} PDF data or null if not cached
 */
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

/**
 * Save a compiled PDF to the cache.
 * @param {string} docHash - Document content hash
 * @param {string} engine - Engine used ('pdflatex', 'xelatex', 'lualatex')
 * @param {Uint8Array} pdfData - PDF data
 * @returns {Promise<void>}
 */
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

/**
 * Get the path for a format file.
 * @param {string} fmtKey - Format key
 * @returns {string} Path to format file
 */
export function getFmtPath(fmtKey) {
    return `fmt-cache/${fmtKey}.fmt`;
}

/**
 * Clear all cached CTAN package metadata.
 * @returns {Promise<boolean>} True if cleared successfully
 */
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

/**
 * Get cached WASM bytes and compile to WebAssembly.Module.
 * @returns {Promise<WebAssembly.Module|null>} Compiled module or null
 */
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

/**
 * Save WASM bytes to IndexedDB for future compilation.
 * @param {Uint8Array} bytes - WASM bytes
 * @returns {Promise<boolean>} True if saved successfully
 */
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

/**
 * Save WASM memory snapshot for instant restore on next load.
 * @param {WebAssembly.Memory|Uint8Array} memoryOrSnapshot - Memory object or snapshot bytes
 * @param {Object} [metadata] - Optional metadata to save with snapshot
 * @returns {Promise<boolean>} True if saved successfully
 */
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

/**
 * Current CTAN cache version. Bump to invalidate cached packages.
 * @type {number}
 */
export { CTAN_CACHE_VERSION };

/**
 * Current manifest cache version. Bump to invalidate cached manifests.
 * @type {number}
 */
export { MANIFEST_CACHE_VERSION };
