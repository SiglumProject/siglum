// Storage module for OPFS and IndexedDB caching
import { fileSystem } from '@siglum/filesystem';

// Safari detection - Safari has issues with ArrayBuffer detachment and WebAssembly.Module serialization
const isSafari = typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// Mount filesystem for WASM cache - uses OPFS when available, IndexedDB fallback
let wasmCacheMounted = false;
async function ensureWasmCacheMounted() {
    if (wasmCacheMounted) return true;
    try {
        await fileSystem.mountAuto('/wasm-cache');
        wasmCacheMounted = true;
        return true;
    } catch (e) {
        console.warn('Failed to mount wasm-cache filesystem:', e);
        return false;
    }
}

const IDB_NAME = 'siglum-ctan-cache';
const IDB_STORE = 'packages';
const CTAN_CACHE_VERSION = 7;
const BUNDLE_CACHE_VERSION = 4;

let idbCache = null;
let opfsRoot = null;

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

// OPFS operations
let opfsInitAttempted = false;
let opfsDisabled = false; // Set to true after persistent failures to avoid spam

export async function getOPFSRoot() {
    if (opfsRoot) return opfsRoot;
    if (opfsDisabled) return null; // Don't retry after persistent failure

    // Safari workaround: request persistent storage first to initialize storage subsystem
    if (!opfsInitAttempted && navigator.storage?.persist) {
        opfsInitAttempted = true;
        try {
            await navigator.storage.persist();
        } catch (e) {
            // Ignore - just a workaround attempt
        }
    }

    // Safari can have transient OPFS failures - retry a few times
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            opfsRoot = await navigator.storage.getDirectory();
            return opfsRoot;
        } catch (e) {
            if (attempt === maxRetries) {
                // Only log once, then disable OPFS for this session
                console.warn('OPFS not available, disabling for this session:', e.message || e);
                opfsDisabled = true;
                return null;
            }
            // Wait briefly before retry (Safari transient errors often resolve quickly)
            await new Promise(r => setTimeout(r, 100 * attempt));
        }
    }
    return null;
}

export async function readFromOPFS(filePath) {
    try {
        const root = await getOPFSRoot();
        if (!root) return null;

        const parts = filePath.split('/').filter(p => p);
        let current = root;

        for (let i = 0; i < parts.length - 1; i++) {
            current = await current.getDirectoryHandle(parts[i]);
        }

        const fileName = parts[parts.length - 1];
        const fileHandle = await current.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        // Create a TRUE copy to avoid Safari ArrayBuffer detachment issues
        // new Uint8Array(buffer) creates a VIEW, not a copy - the buffer can be detached
        const copy = new Uint8Array(buffer.byteLength);
        copy.set(new Uint8Array(buffer));
        return copy;
    } catch (e) {
        return null;
    }
}

export async function writeToOPFS(filePath, content) {
    try {
        const root = await getOPFSRoot();
        if (!root) return false;

        const parts = filePath.split('/').filter(p => p);
        let current = root;

        for (let i = 0; i < parts.length - 1; i++) {
            current = await current.getDirectoryHandle(parts[i], { create: true });
        }

        const fileName = parts[parts.length - 1];
        const fileHandle = await current.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return true;
    } catch (e) {
        return false;
    }
}

// Bundle cache operations
let bundleCacheVersionChecked = false;

export async function checkBundleCacheVersion() {
    if (bundleCacheVersionChecked) return;
    bundleCacheVersionChecked = true;

    try {
        const root = await getOPFSRoot();
        if (!root) return;

        const versionHandle = await root.getFileHandle('bundle-cache-version', { create: true });
        const file = await versionHandle.getFile();
        const text = await file.text();
        const version = parseInt(text) || 0;

        if (version < BUNDLE_CACHE_VERSION) {
            // Only log on actual upgrade, not first run (version 0)
            if (version > 0) {
                console.log(`Bundle cache version upgrade (${version} → ${BUNDLE_CACHE_VERSION}), clearing cache...`);
            }
            await clearBundleCache();
            const writable = await versionHandle.createWritable();
            await writable.write(String(BUNDLE_CACHE_VERSION));
            await writable.close();
        }
    } catch (e) {
        // First run, create version file
        try {
            const root = await getOPFSRoot();
            if (root) {
                const versionHandle = await root.getFileHandle('bundle-cache-version', { create: true });
                const writable = await versionHandle.createWritable();
                await writable.write(String(BUNDLE_CACHE_VERSION));
                await writable.close();
            }
        } catch (e2) {}
    }
}

export async function clearBundleCache() {
    try {
        const root = await getOPFSRoot();
        if (!root) return;
        await root.removeEntry('bundles', { recursive: true });
    } catch (e) {}
}

export async function getBundleFromOPFS(bundleName) {
    await checkBundleCacheVersion();
    try {
        const root = await getOPFSRoot();
        if (!root) return null;

        const bundlesDir = await root.getDirectoryHandle('bundles');
        const fileHandle = await bundlesDir.getFileHandle(bundleName + '.data');
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        // Create a TRUE copy to avoid Safari ArrayBuffer detachment issues
        const copy = new Uint8Array(buffer.byteLength);
        copy.set(new Uint8Array(buffer));
        return copy.buffer;
    } catch (e) {
        return null;
    }
}

export async function saveBundleToOPFS(bundleName, data) {
    try {
        const root = await getOPFSRoot();
        if (!root) return;

        const bundlesDir = await root.getDirectoryHandle('bundles', { create: true });
        const fileHandle = await bundlesDir.getFileHandle(bundleName + '.data', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
    } catch (e) {}
}

// Aux file cache
const AUX_CACHE_VERSION = 1;
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
const DOC_CACHE_VERSION = 1;
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

export function hashDocument(source) {
    let hash = 5381;
    for (let i = 0; i < source.length; i++) {
        hash = ((hash << 5) + hash) + source.charCodeAt(i);
        hash = hash & hash;
    }
    return hash.toString(16);
}

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

// Format cache - simplified to use direct OPFS paths
// Format files are stored at fmt-cache/{fmtKey}.fmt
// No IndexedDB metadata layer needed - paths are deterministic from the key

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

        const root = await getOPFSRoot();
        if (root) {
            try {
                await root.removeEntry('ctan-packages', { recursive: true });
            } catch (e) {}
        }

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
                console.log('[WASM-CACHE] Checking IndexedDB cache...', { hasResult: !!result });
                if (result?.bytes instanceof Uint8Array) {
                    console.log('[WASM-CACHE] ✅ HIT - Found cached bytes, compiling...');
                    const startTime = performance.now();
                    try {
                        const module = await WebAssembly.compile(result.bytes);
                        const elapsed = (performance.now() - startTime).toFixed(0);
                        console.log(`[WASM-CACHE] ✅ Compiled from cache in ${elapsed}ms`);
                        resolve(module);
                    } catch (e) {
                        console.log('[WASM-CACHE] ❌ Compile from cache failed:', e.message);
                        resolve(null);
                    }
                } else {
                    console.log('[WASM-CACHE] ❌ MISS - No cached bytes');
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
            request.onerror = () => {
                console.warn('[WASM-CACHE] Failed to save bytes');
                resolve(false);
            };
            request.onsuccess = () => {
                console.log(`[WASM-CACHE] ✅ Saved ${(bytes.length / 1024 / 1024).toFixed(1)}MB to cache`);
                resolve(true);
            };
        });
    } catch (e) {
        console.warn('[WASM-CACHE] Failed to save bytes:', e);
        return false;
    }
}

// Keep old function name for backwards compat but it's now a no-op
export async function saveCompiledWasmModule(module) {
    console.log('[WASM-CACHE] saveCompiledWasmModule called but ignored - use saveWasmBytes instead');
    return false;
}

// Legacy OPFS functions - keep for backwards compatibility during transition
export async function getWasmFromOPFS() {
    // Try new IndexedDB cache first
    return null; // Disable legacy OPFS cache - use getCompiledWasmModule instead
}

export async function saveWasmToOPFS(wasmBytes) {
    // No longer used - we cache compiled modules instead of bytes
    return false;
}

// WASM Memory Snapshot Cache - stores initialized WASM heap for instant restore
// This caches the WASM linear memory after first successful initialization
// Restoring from snapshot skips the ~3-5s initialization overhead
// Uses siglum-filesystem for storage (OPFS when available, IndexedDB fallback)
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
        await fileSystem.writeBinary(MEMORY_SNAPSHOT_PATH, snapshot, { createParents: true, silent: true });

        // Write metadata as JSON (small, no optimization needed)
        const metaData = {
            byteLength,
            metadata,
            timestamp: Date.now(),
            version: MEMORY_SNAPSHOT_VERSION,
        };
        await fileSystem.writeFile(MEMORY_SNAPSHOT_META_PATH, JSON.stringify(metaData), { silent: true });

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
        if (!await ensureWasmCacheMounted()) {
            return null;
        }

        // Read metadata first (small file, fast) to validate before loading large snapshot
        let metaJson;
        try {
            metaJson = await fileSystem.readFile(MEMORY_SNAPSHOT_META_PATH);
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
            snapshot = await fileSystem.readBinary(MEMORY_SNAPSHOT_PATH);
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
        if (!await ensureWasmCacheMounted()) {
            return false;
        }

        // Delete both files in parallel for efficiency
        await Promise.all([
            fileSystem.deleteFile(MEMORY_SNAPSHOT_PATH, { silent: true }).catch(() => {}),
            fileSystem.deleteFile(MEMORY_SNAPSHOT_META_PATH, { silent: true }).catch(() => {}),
        ]);

        console.log('Cleared WASM memory snapshot');
        return true;
    } catch (e) {
        console.warn('Failed to clear memory snapshot:', e);
        return false;
    }
}

export { CTAN_CACHE_VERSION, BUNDLE_CACHE_VERSION, WASM_CACHE_VERSION, MEMORY_SNAPSHOT_VERSION };
