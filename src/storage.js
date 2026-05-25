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
let wasmCacheMounting = null;
async function ensureWasmCacheMounted() {
    if (wasmCacheMounted) return true;
    if (wasmCacheMounting) return wasmCacheMounting;
    const fs = getFileSystem();
    if (!fs) return false;
    wasmCacheMounting = (async () => {
        try {
            await fs.mountAuto('/wasm-cache');
            wasmCacheMounted = true;
            return true;
        } catch (e) {
            console.warn('Failed to mount wasm-cache filesystem:', e);
            return false;
        } finally {
            wasmCacheMounting = null;
        }
    })();
    return wasmCacheMounting;
}

const CTAN_CACHE_VERSION = 10; // Bumped: include all data files (.csv, .lua, etc.) in CTAN extractions
const BUNDLE_CACHE_VERSION = 5; // Bumped: TL2026 rebuild with correct offsets
const MANIFEST_CACHE_VERSION = 6; // Bumped: TL2026 rebuild with regenerated file-manifest.json

// CTAN cache mount
let ctanCacheMounted = false;
let ctanCacheMounting = null;
async function ensureCtanCacheMounted() {
    if (ctanCacheMounted) return true;
    if (ctanCacheMounting) return ctanCacheMounting;
    const fs = getFileSystem();
    if (!fs) return false;
    ctanCacheMounting = (async () => {
        try {
            await fs.mountAuto('/ctan-cache');
            ctanCacheMounted = true;
            return true;
        } catch (e) {
            console.warn('Failed to mount ctan-cache filesystem:', e);
            return false;
        } finally {
            ctanCacheMounting = null;
        }
    })();
    return ctanCacheMounting;
}

/**
 * Get metadata for a cached CTAN package.
 * @param {string} packageName - Package name
 * @returns {Promise<Object|null>} Package metadata or null
 */
export async function getPackageMeta(packageName) {
    try {
        if (!await ensureCtanCacheMounted()) return null;
        const fs = getFileSystem();
        const content = await fs.readFile(`/ctan-cache/${packageName}.json`);
        return JSON.parse(content);
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
        if (!await ensureCtanCacheMounted()) return false;
        const fs = getFileSystem();
        const data = { name: packageName, ...meta, timestamp: Date.now() };
        await fs.writeFile(`/ctan-cache/${packageName}.json`, JSON.stringify(data), { createParents: true });
        return true;
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
        if (!await ensureCtanCacheMounted()) return [];
        const fs = getFileSystem();
        const entries = await fs.readdir('/ctan-cache');
        const jsonFiles = entries.filter(e => e.name.endsWith('.json'));
        const results = await Promise.all(
            jsonFiles.map(async (entry) => {
                try {
                    const content = await fs.readFile(entry.path);
                    return JSON.parse(content);
                } catch {
                    return null;
                }
            })
        );
        return results.filter(r => r !== null);
    } catch (e) {
        return [];
    }
}

// Mount for manifests
let manifestsMounted = false;
let manifestsMounting = null;
async function ensureManifestsMounted() {
    if (manifestsMounted) return true;
    if (manifestsMounting) return manifestsMounting;
    const fs = getFileSystem();
    if (!fs) return false;
    manifestsMounting = (async () => {
        try {
            await fs.mountAuto('/manifests');
            manifestsMounted = true;
            return true;
        } catch (e) {
            console.warn('Failed to mount manifests filesystem:', e);
            return false;
        } finally {
            manifestsMounting = null;
        }
    })();
    return manifestsMounting;
}

// Mount for format cache
let fmtCacheMounted = false;
let fmtCacheMounting = null;
async function ensureFmtCacheMounted() {
    if (fmtCacheMounted) return true;
    if (fmtCacheMounting) return fmtCacheMounting;
    const fs = getFileSystem();
    if (!fs) return false;
    fmtCacheMounting = (async () => {
        try {
            await fs.mountAuto('/fmt-cache');
            fmtCacheMounted = true;
            return true;
        } catch (e) {
            console.warn('Failed to mount fmt-cache filesystem:', e);
            return false;
        } finally {
            fmtCacheMounting = null;
        }
    })();
    return fmtCacheMounting;
}

// Mount for texlive/CTAN cache
let texliveMounted = false;
let texliveMounting = null;

/**
 * Ensure the /texlive filesystem is mounted for CTAN package storage.
 * @returns {Promise<boolean>} True if mounted successfully
 */
export async function ensureTexliveMounted() {
    if (texliveMounted) return true;
    if (texliveMounting) return texliveMounting;
    const fs = getFileSystem();
    if (!fs) return false;
    texliveMounting = (async () => {
        try {
            await fs.mountAuto('/texlive');
            texliveMounted = true;
            return true;
        } catch (e) {
            console.warn('Failed to mount texlive filesystem:', e);
            return false;
        } finally {
            texliveMounting = null;
        }
    })();
    return texliveMounting;
}

// Bundle cache operations
let bundleCacheMounted = false;
let bundleCacheMounting = null;

async function ensureBundleCacheMounted() {
    if (bundleCacheMounted) return true;
    if (bundleCacheMounting) return bundleCacheMounting;
    const fs = getFileSystem();
    if (!fs) return false;
    bundleCacheMounting = (async () => {
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
        } finally {
            bundleCacheMounting = null;
        }
    })();
    return bundleCacheMounting;
}

/**
 * Get a bundle from the cache.
 * @param {string} bundleName - Bundle name
 * @returns {Promise<ArrayBuffer|null>} Bundle data or null if not cached
 */
export async function getBundleFromCache(bundleName) {
    try {
        if (!await ensureBundleCacheMounted()) return null;
        const fs = getFileSystem();
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
        if (!await ensureBundleCacheMounted()) return false;
        const fs = getFileSystem();
        await fs.mkdir('/bundle-cache/bundles');
        // Convert SharedArrayBuffer to regular ArrayBuffer for storage
        // (SharedArrayBuffer can't be serialized)
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
        if (!await ensureManifestsMounted()) return null;
        const fs = getFileSystem();
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
        if (!await ensureManifestsMounted()) return false;
        const fs = getFileSystem();
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
        if (!await ensureManifestsMounted()) return 0;
        const fs = getFileSystem();
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
        if (!await ensureManifestsMounted()) return false;
        const fs = getFileSystem();
        await fs.writeFile('/manifests/version', String(version), { createParents: true });
        return true;
    } catch (e) {
        return false;
    }
}

// Aux file cache with LRU eviction
const auxMemoryCache = new Map();
const MAX_AUX_CACHE_SIZE = 20;
let auxCacheMounted = false;
let auxCacheMounting = null;

async function ensureAuxCacheMounted() {
    if (auxCacheMounted) return true;
    if (auxCacheMounting) return auxCacheMounting;
    const fs = getFileSystem();
    if (!fs) return false;
    auxCacheMounting = (async () => {
        try {
            await fs.mountAuto('/aux-cache');
            auxCacheMounted = true;
            return true;
        } catch (e) {
            console.warn('Failed to mount aux-cache filesystem:', e);
            return false;
        } finally {
            auxCacheMounting = null;
        }
    })();
    return auxCacheMounting;
}

/**
 * Get cached aux files for a preamble hash.
 * @param {string} preambleHash - Hash of the document preamble
 * @returns {Promise<{hash: string, files: Object, timestamp: number}|null>} Cached entry or null
 */
export async function getAuxCache(preambleHash) {
    if (auxMemoryCache.has(preambleHash)) {
        // Move to end for LRU (delete + set maintains insertion order)
        const value = auxMemoryCache.get(preambleHash);
        auxMemoryCache.delete(preambleHash);
        auxMemoryCache.set(preambleHash, value);
        return value;
    }
    try {
        if (!await ensureAuxCacheMounted()) return null;
        const fs = getFileSystem();
        const content = await fs.readFile(`/aux-cache/${preambleHash}.json`);
        const result = JSON.parse(content);
        if (result) {
            // Evict oldest if at capacity
            if (auxMemoryCache.size >= MAX_AUX_CACHE_SIZE) {
                const firstKey = auxMemoryCache.keys().next().value;
                auxMemoryCache.delete(firstKey);
            }
            auxMemoryCache.set(preambleHash, result);
        }
        return result;
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

    // LRU: delete first to ensure it moves to end on set
    const exists = auxMemoryCache.has(preambleHash);
    if (exists) {
        auxMemoryCache.delete(preambleHash);
    } else if (auxMemoryCache.size >= MAX_AUX_CACHE_SIZE) {
        // Evict oldest if at capacity and adding new entry
        const firstKey = auxMemoryCache.keys().next().value;
        auxMemoryCache.delete(firstKey);
    }
    auxMemoryCache.set(preambleHash, entry);

    // Fire-and-forget write to disk (memory cache already has the data)
    // Don't await - matches original IndexedDB behavior where transaction was queued but not awaited
    ensureAuxCacheMounted().then(mounted => {
        if (!mounted) return;
        const fs = getFileSystem();
        fs.writeFile(`/aux-cache/${preambleHash}.json`, JSON.stringify(entry), { createParents: true }).catch(() => {});
    });
}

// Document cache for compiled PDFs
const docMemoryCache = new Map();
const MAX_DOC_CACHE_SIZE = 10;
let docCacheMounted = false;
let docCacheMounting = null;

async function ensureDocCacheMounted() {
    if (docCacheMounted) return true;
    if (docCacheMounting) return docCacheMounting;
    const fs = getFileSystem();
    if (!fs) return false;
    docCacheMounting = (async () => {
        try {
            await fs.mountAuto('/doc-cache');
            docCacheMounted = true;
            return true;
        } catch (e) {
            console.warn('Failed to mount doc-cache filesystem:', e);
            return false;
        } finally {
            docCacheMounting = null;
        }
    })();
    return docCacheMounting;
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
        // Move to end for LRU
        const value = docMemoryCache.get(key);
        docMemoryCache.delete(key);
        docMemoryCache.set(key, value);
        return value;
    }
    try {
        if (!await ensureDocCacheMounted()) return null;
        const fs = getFileSystem();
        const pdfData = await fs.readBinary(`/doc-cache/${key}.pdf`);
        if (pdfData) {
            // Evict oldest if at capacity
            if (docMemoryCache.size >= MAX_DOC_CACHE_SIZE) {
                const firstKey = docMemoryCache.keys().next().value;
                docMemoryCache.delete(firstKey);
            }
            docMemoryCache.set(key, pdfData);
        }
        return pdfData || null;
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

    // LRU: delete first to ensure it moves to end on set
    const exists = docMemoryCache.has(key);
    if (exists) {
        docMemoryCache.delete(key);
    } else if (docMemoryCache.size >= MAX_DOC_CACHE_SIZE) {
        // Evict oldest if at capacity and adding new entry
        const firstKey = docMemoryCache.keys().next().value;
        docMemoryCache.delete(firstKey);
    }
    docMemoryCache.set(key, pdfData);

    // Fire-and-forget write to disk (memory cache already has the data)
    // Don't await - matches original IndexedDB behavior where transaction was queued but not awaited
    ensureDocCacheMounted().then(mounted => {
        if (!mounted) return;
        const fs = getFileSystem();
        fs.writeBinary(`/doc-cache/${key}.pdf`, pdfData, { createParents: true }).catch(() => {});
    });
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
        if (!await ensureCtanCacheMounted()) return false;
        const fs = getFileSystem();
        await fs.rmdir('/ctan-cache', { recursive: true });
        // Reset mounted flag so next access will remount
        ctanCacheMounted = false;
        await ensureCtanCacheMounted();
        return true;
    } catch (e) {
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
        const fs = getFileSystem();
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

/**
 * Reset all module-level mount flags and in-memory caches. These are process-wide
 * singletons, so without a reset a mounted flag set by one test would short-circuit
 * the mount logic in the next. Intended for tests only; no-op effect in production.
 */
export function __resetStorageStateForTests() {
    wasmCacheMounted = ctanCacheMounted = manifestsMounted = fmtCacheMounted =
        texliveMounted = bundleCacheMounted = auxCacheMounted = docCacheMounted = false;
    wasmCacheMounting = ctanCacheMounting = manifestsMounting = fmtCacheMounting =
        texliveMounting = bundleCacheMounting = auxCacheMounting = docCacheMounting = null;
    auxMemoryCache.clear();
    docMemoryCache.clear();
}
