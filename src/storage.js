// Storage module for OPFS and IndexedDB caching

// Safari detection - Safari has issues with ArrayBuffer detachment and WebAssembly.Module serialization
const isSafari = typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// Optional @siglum/filesystem - gracefully degrade when not available (e.g., direct browser ES modules)
let fileSystem = null;
let fileSystemLoaded = false;

// Native OPFS fallback for when @siglum/filesystem isn't available
class NativeOPFSFileSystem {
    constructor() {
        this._root = null;
        this._mounts = new Map(); // path -> DirectoryHandle
    }

    async _getRoot() {
        if (!this._root) {
            this._root = await navigator.storage.getDirectory();
        }
        return this._root;
    }

    async _getDir(path, create = false) {
        const root = await this._getRoot();
        const parts = path.split('/').filter(p => p);
        let current = root;
        for (const part of parts) {
            current = await current.getDirectoryHandle(part, { create });
        }
        return current;
    }

    async mountAuto(path) {
        // Just ensure the directory exists
        const dir = await this._getDir(path, true);
        this._mounts.set(path, dir);
        return true;
    }

    async mkdir(path) {
        await this._getDir(path, true);
    }

    async readBinary(path, options = {}) {
        const parts = path.split('/').filter(p => p);
        const fileName = parts.pop();
        const dirPath = '/' + parts.join('/');
        const dir = await this._getDir(dirPath);
        const fileHandle = await dir.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        return new Uint8Array(buffer);
    }

    async writeBinary(path, data) {
        const parts = path.split('/').filter(p => p);
        const fileName = parts.pop();
        const dirPath = '/' + parts.join('/');
        const dir = await this._getDir(dirPath, true);
        const fileHandle = await dir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
    }

    async readFile(path) {
        const data = await this.readBinary(path);
        return new TextDecoder().decode(data);
    }

    async writeFile(path, content) {
        await this.writeBinary(path, new TextEncoder().encode(content));
    }

    async rmdir(path, options = {}) {
        try {
            const parts = path.split('/').filter(p => p);
            const dirName = parts.pop();
            const parentPath = '/' + parts.join('/');
            const parent = await this._getDir(parentPath);
            await parent.removeEntry(dirName, { recursive: options.recursive });
        } catch {
            // Ignore errors (directory may not exist)
        }
    }

    async deleteFile(path, options = {}) {
        try {
            const parts = path.split('/').filter(p => p);
            const fileName = parts.pop();
            const dirPath = '/' + parts.join('/');
            const dir = await this._getDir(dirPath);
            await dir.removeEntry(fileName);
        } catch {
            // Ignore errors
        }
    }
}

async function getFileSystem() {
    if (fileSystemLoaded) return fileSystem;
    fileSystemLoaded = true;
    try {
        const mod = await import('@siglum/filesystem');
        fileSystem = mod.fileSystem;
        console.log('[storage] Using @siglum/filesystem');
    } catch (e) {
        // Not available (e.g., running in browser without bundler)
        // Fall back to native OPFS API
        console.log('[storage] @siglum/filesystem not available:', e.message);
        if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
            fileSystem = new NativeOPFSFileSystem();
            console.log('[storage] Using native OPFS fallback');
        } else {
            console.log('[storage] No OPFS available');
        }
    }
    return fileSystem;
}

// Mount filesystem for WASM cache - uses OPFS when available, IndexedDB fallback
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
const MANIFEST_CACHE_VERSION = 1;

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

// Bundle cache operations using siglum-filesystem
// Automatically uses OPFS when available, IndexedDB as fallback
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

export async function clearBundleCache() {
    try {
        const fs = await getFileSystem();
        if (fs && await ensureBundleCacheMounted()) {
            await fs.rmdir('/bundle-cache/bundles', { recursive: true });
        }
    } catch (e) {}
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
        if (data instanceof SharedArrayBuffer) {
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

// ============================================================================
// OPFS Bundle Extraction - Extract individual files from bundles to OPFS
// This enables lazy loading: only read files that are actually used
// ============================================================================

const EXTRACTED_BUNDLES_VERSION = 1;

/**
 * Check if a bundle has been extracted to OPFS with matching hash
 * @param {string} bundleName - Name of the bundle
 * @param {string} expectedHash - Expected manifest hash for version check
 * @returns {Promise<boolean>} True if bundle is extracted and up-to-date
 */
export async function isBundleExtracted(bundleName, expectedHash) {
    try {
        const root = await getOPFSRoot();
        if (!root) return false;

        const extractedDir = await root.getDirectoryHandle('extracted-bundles');
        const bundleDir = await extractedDir.getDirectoryHandle(bundleName);
        const metaHandle = await bundleDir.getFileHandle('.meta.json');
        const metaFile = await metaHandle.getFile();
        const meta = JSON.parse(await metaFile.text());

        return meta.hash === expectedHash && meta.version === EXTRACTED_BUNDLES_VERSION;
    } catch (e) {
        return false;
    }
}

/**
 * Extract all files from a bundle to OPFS
 * Files are stored at: /extracted-bundles/{bundleName}/{texmfPath}
 *
 * @param {string} bundleName - Name of the bundle
 * @param {ArrayBuffer|SharedArrayBuffer} bundleData - Raw bundle data blob
 * @param {Object} manifest - File manifest mapping paths to {bundle, offset, size}
 * @param {string} hash - Manifest hash for version tracking
 * @param {Function} onProgress - Optional progress callback (filesExtracted, totalFiles)
 * @returns {Promise<{success: boolean, filesExtracted: number, error?: string}>}
 */
export async function extractBundleToOPFS(bundleName, bundleData, manifest, hash, onProgress) {
    try {
        const root = await getOPFSRoot();
        if (!root) {
            return { success: false, filesExtracted: 0, error: 'OPFS not available' };
        }

        // Create directory structure
        const extractedDir = await root.getDirectoryHandle('extracted-bundles', { create: true });

        // Remove existing bundle dir if exists (clean extraction)
        try {
            await extractedDir.removeEntry(bundleName, { recursive: true });
        } catch (e) {
            // Doesn't exist, that's fine
        }

        const bundleDir = await extractedDir.getDirectoryHandle(bundleName, { create: true });

        // Get files belonging to this bundle
        const bundleFiles = Object.entries(manifest).filter(([_, info]) => info.bundle === bundleName);
        const totalFiles = bundleFiles.length;
        let filesExtracted = 0;

        // Create a Uint8Array view of the bundle data (no copy)
        const dataView = new Uint8Array(bundleData);

        // Cache directory handles to avoid repeated lookups (significant CPU savings)
        const dirHandleCache = new Map();
        dirHandleCache.set('', bundleDir);

        async function getOrCreateDir(pathParts) {
            const key = pathParts.join('/');
            if (dirHandleCache.has(key)) {
                return dirHandleCache.get(key);
            }

            // Build path incrementally, caching each level
            let currentDir = bundleDir;
            let currentPath = '';
            for (const part of pathParts) {
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                if (dirHandleCache.has(currentPath)) {
                    currentDir = dirHandleCache.get(currentPath);
                } else {
                    currentDir = await currentDir.getDirectoryHandle(part, { create: true });
                    dirHandleCache.set(currentPath, currentDir);
                }
            }
            return currentDir;
        }

        // Extract files in batches to balance parallelism vs memory
        // Smaller batch = less concurrent memory, larger = faster
        const BATCH_SIZE = 20;
        for (let i = 0; i < bundleFiles.length; i += BATCH_SIZE) {
            const batch = bundleFiles.slice(i, i + BATCH_SIZE);

            await Promise.all(batch.map(async ([texmfPath, info]) => {
                try {
                    // Use subarray (view) instead of slice (copy) - no memory allocation
                    // The view is valid for the duration of the write operation
                    const fileData = dataView.subarray(info.offset, info.offset + info.size);

                    // Get/create parent directory (cached)
                    const pathParts = texmfPath.split('/').filter(p => p);
                    const parentDir = await getOrCreateDir(pathParts.slice(0, -1));

                    // Write file directly from subarray view
                    const fileName = pathParts[pathParts.length - 1];
                    const fileHandle = await parentDir.getFileHandle(fileName, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(fileData);
                    await writable.close();

                    filesExtracted++;
                } catch (e) {
                    console.warn(`Failed to extract ${texmfPath}:`, e.message);
                }
            }));

            // Report progress
            if (onProgress) {
                onProgress(filesExtracted, totalFiles);
            }
        }

        // Clear directory cache to free memory
        dirHandleCache.clear();

        // Write metadata
        const metaHandle = await bundleDir.getFileHandle('.meta.json', { create: true });
        const metaWritable = await metaHandle.createWritable();
        await metaWritable.write(JSON.stringify({
            hash,
            version: EXTRACTED_BUNDLES_VERSION,
            filesExtracted,
            totalFiles,
            extractedAt: Date.now(),
        }));
        await metaWritable.close();

        console.log(`Extracted bundle ${bundleName}: ${filesExtracted}/${totalFiles} files`);
        return { success: true, filesExtracted };
    } catch (e) {
        console.error(`Failed to extract bundle ${bundleName}:`, e);
        return { success: false, filesExtracted: 0, error: e.message };
    }
}

/**
 * Read a single file from an extracted bundle
 * @param {string} bundleName - Name of the bundle
 * @param {string} texmfPath - Path within texmf (e.g., "texmf/tex/latex/base/article.cls")
 * @returns {Promise<Uint8Array|null>} File contents or null if not found
 */
export async function getBundleFileFromOPFS(bundleName, texmfPath) {
    try {
        const root = await getOPFSRoot();
        if (!root) return null;

        const pathParts = ['extracted-bundles', bundleName, ...texmfPath.split('/').filter(p => p)];
        let current = root;

        for (let i = 0; i < pathParts.length - 1; i++) {
            current = await current.getDirectoryHandle(pathParts[i]);
        }

        const fileName = pathParts[pathParts.length - 1];
        const fileHandle = await current.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();

        // Safari has ArrayBuffer detachment issues - must copy
        // Other browsers can use the buffer directly (faster)
        if (isSafari) {
            const copy = new Uint8Array(buffer.byteLength);
            copy.set(new Uint8Array(buffer));
            return copy;
        }

        return new Uint8Array(buffer);
    } catch (e) {
        return null;
    }
}

/**
 * List all extracted bundles
 * @returns {Promise<string[]>} Array of bundle names
 */
export async function listExtractedBundles() {
    try {
        const root = await getOPFSRoot();
        if (!root) return [];

        const extractedDir = await root.getDirectoryHandle('extracted-bundles');
        const bundles = [];

        for await (const [name, handle] of extractedDir) {
            if (handle.kind === 'directory' && !name.startsWith('.')) {
                bundles.push(name);
            }
        }

        return bundles;
    } catch (e) {
        return [];
    }
}

/**
 * Get metadata for an extracted bundle
 * @param {string} bundleName - Name of the bundle
 * @returns {Promise<Object|null>} Bundle metadata or null
 */
export async function getExtractedBundleMeta(bundleName) {
    try {
        const root = await getOPFSRoot();
        if (!root) return null;

        const extractedDir = await root.getDirectoryHandle('extracted-bundles');
        const bundleDir = await extractedDir.getDirectoryHandle(bundleName);
        const metaHandle = await bundleDir.getFileHandle('.meta.json');
        const metaFile = await metaHandle.getFile();
        return JSON.parse(await metaFile.text());
    } catch (e) {
        return null;
    }
}

/**
 * Clear all extracted bundles from OPFS
 * @returns {Promise<boolean>} True if successful
 */
export async function clearExtractedBundles() {
    try {
        const root = await getOPFSRoot();
        if (!root) return false;

        await root.removeEntry('extracted-bundles', { recursive: true });
        console.log('Cleared all extracted bundles from OPFS');
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Clear a specific extracted bundle from OPFS
 * @param {string} bundleName - Name of the bundle to clear
 * @returns {Promise<boolean>} True if successful
 */
export async function clearExtractedBundle(bundleName) {
    try {
        const root = await getOPFSRoot();
        if (!root) return false;

        const extractedDir = await root.getDirectoryHandle('extracted-bundles');
        await extractedDir.removeEntry(bundleName, { recursive: true });
        console.log(`Cleared extracted bundle: ${bundleName}`);
        return true;
    } catch (e) {
        return false;
    }
}

// ============================================================================

// Manifest cache - stores file-manifest.json, registry.json, package-map.json in OPFS
export async function getManifestFromOPFS(name) {
    try {
        const root = await getOPFSRoot();
        if (!root) return null;

        const manifestDir = await root.getDirectoryHandle('manifests');
        const fileHandle = await manifestDir.getFileHandle(name + '.json');
        const file = await fileHandle.getFile();
        const text = await file.text();
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

export async function saveManifestToOPFS(name, data) {
    try {
        const root = await getOPFSRoot();
        if (!root) return false;

        const manifestDir = await root.getDirectoryHandle('manifests', { create: true });
        const fileHandle = await manifestDir.getFileHandle(name + '.json', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(data));
        await writable.close();
        return true;
    } catch (e) {
        return false;
    }
}

export async function getManifestVersion() {
    try {
        const root = await getOPFSRoot();
        if (!root) return 0;

        const manifestDir = await root.getDirectoryHandle('manifests');
        const fileHandle = await manifestDir.getFileHandle('version');
        const file = await fileHandle.getFile();
        return parseInt(await file.text()) || 0;
    } catch (e) {
        return 0;
    }
}

export async function saveManifestVersion(version) {
    try {
        const root = await getOPFSRoot();
        if (!root) return false;

        const manifestDir = await root.getDirectoryHandle('manifests', { create: true });
        const fileHandle = await manifestDir.getFileHandle('version', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(String(version));
        await writable.close();
        return true;
    } catch (e) {
        return false;
    }
}

export async function clearManifestCache() {
    try {
        const root = await getOPFSRoot();
        if (!root) return;
        await root.removeEntry('manifests', { recursive: true });
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

// Keep old function name for backwards compat but it's now a no-op
export async function saveCompiledWasmModule(module) {
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
    EXTRACTED_BUNDLES_VERSION,
};
