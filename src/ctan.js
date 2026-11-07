import { TEXLIVE_YEAR } from './texlive.js';
/**
 * @module @siglum/engine/ctan
 * CTAN package fetching and caching.
 */

import { fileSystem } from '@siglum/filesystem';
import {
    getPackageMeta,
    savePackageMeta,
    ensureTexliveMounted,
    CTAN_CACHE_VERSION
} from './storage.js';

// Common LaTeX file extensions for file-to-package lookups
// Used when package name doesn't match file name (e.g., algorithm.sty → algorithms package)
const NEGATIVE_CACHE_TTL = 5 * 60 * 1000;
async function cacheGeneration(payload) {
    if (globalThis.crypto?.subtle && payload) {
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
        return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
    }
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

const packageCacheKey = (name, year = null) => `pkg-v1-${year ? "tl" + year : TEXLIVE_YEAR}-${encodeURIComponent(name)}`;

const LATEX_FILE_EXTENSIONS = ['.sty', '.cls', '.def', '.clo', '.fd', '.cfg', '.tex'];

// Lazy load xzwasm when needed (UMD module loaded via script tag)
let XzReadableStream = null;
let xzwasmUrl = './src/xzwasm.js'; // Default, can be overridden

function setXzwasmUrl(url) {
    xzwasmUrl = url;
}

let xzLoading = null;
async function loadXzwasm() {
    if (XzReadableStream) return XzReadableStream;
    if (typeof self.xzwasm?.XzReadableStream === 'function') return XzReadableStream = self.xzwasm.XzReadableStream;
    if (xzLoading) return xzLoading;
    xzLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        let timer;
        const finish = error => {
            clearTimeout(timer);
            script.onload = script.onerror = null;
            script.remove();
            if (error) reject(error);
            else resolve(XzReadableStream);
        };
        script.crossOrigin = 'anonymous';
        script.src = xzwasmUrl;
        script.onload = () => {
            if (typeof self.xzwasm?.XzReadableStream !== 'function') {
                finish(new Error('Invalid XZ decompressor script at ' + xzwasmUrl));
                return;
            }
            XzReadableStream = self.xzwasm.XzReadableStream;
            finish();
        };
        script.onerror = () => finish(new Error('Failed to load xzwasm from ' + xzwasmUrl));
        timer = setTimeout(() => finish(new Error('Timed out loading xzwasm from ' + xzwasmUrl)), 30000);
        document.head.appendChild(script);
    });
    try { return await xzLoading; }
    finally { xzLoading = null; }
}

// Parse TAR archive into Map<path, Uint8Array>
function parseTar(tarData) {
    const files = new Map();
    let offset = 0;
    const decoder = new TextDecoder();

    while (offset < tarData.length - 512) {
        // Check for zero block (end of archive)
        let isZero = true;
        for (let i = 0; i < 512; i++) {
            if (tarData[offset + i] !== 0) { isZero = false; break; }
        }
        if (isZero) break;

        // Parse header - name is at bytes 0-99
        const nameBytes = tarData.subarray(offset, offset + 100);
        let nameEnd = nameBytes.indexOf(0);
        if (nameEnd === -1) nameEnd = 100;
        const name = decoder.decode(nameBytes.subarray(0, nameEnd));

        // Size is at bytes 124-135 (12 bytes, octal, null/space terminated)
        const sizeBytes = tarData.subarray(offset + 124, offset + 136);
        let sizeEnd = 0;
        for (let i = 0; i < 12; i++) {
            if (sizeBytes[i] === 0 || sizeBytes[i] === 32) break;
            sizeEnd = i + 1;
        }
        const sizeStr = decoder.decode(sizeBytes.subarray(0, sizeEnd));
        const size = parseInt(sizeStr, 8) || 0;

        // TypeFlag is at byte 156
        const typeFlag = tarData[offset + 156];

        // Prefix is at bytes 345-499 (USTAR format)
        const prefixBytes = tarData.subarray(offset + 345, offset + 500);
        let prefixEnd = prefixBytes.indexOf(0);
        if (prefixEnd === -1) prefixEnd = 155;
        const prefix = decoder.decode(prefixBytes.subarray(0, prefixEnd));

        const fullPath = prefix ? prefix + '/' + name : name;

        offset += 512; // Move past header

        // Only process regular files (typeFlag 0 or '0' which is ASCII 48)
        if ((typeFlag === 0 || typeFlag === 48) && size > 0 && name) {
            files.set(fullPath, new Uint8Array(tarData.buffer, tarData.byteOffset + offset, size));
        }

        // Move to next 512-byte boundary
        offset += Math.ceil(size / 512) * 512;
    }

    return files;
}

// Note: We use TexLive 2026 for ALL packages for version compatibility

// Dynamic package name cache (populated by CTAN API lookups)
const packageNameCache = new Map();

// Share successful index loads only among fetchers using the same asset URL.
const fileToPackageByUrl = new Map();

// Font-name-to-package index (loaded from server on first use)
let fontNameIndex = null;
let fontNameLoading = null;

/**
 * Normalize a font family name the way the build-time index keys are normalized:
 * lowercase, keep only [a-z0-9]. fontspec/fontconfig compare loosely, so
 * "TeX Gyre Chorus" and "texgyrechorus" must collapse to the same key.
 * @param {string} name - Font family name
 * @returns {string} Normalized key
 */
export function normalizeFontName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * @typedef {Object} CTANFetcherOptions
 * @property {string} [proxyUrl] - CTAN proxy URL
 * @property {string} [bundlesUrl] - Bundles URL
 * @property {string} [xzwasmUrl] - XZ decompression WASM URL
 * @property {(msg: string) => void} [onLog] - Logging callback
 */

/**
 * @typedef {Object} PackageResult
 * @property {Map<string, Uint8Array>} files - Map of file paths to contents
 * @property {string[]} dependencies - Package dependencies
 * @property {boolean} [notFound] - True if package was not found
 */

/**
 * Fetches LaTeX packages from CTAN/TexLive archives.
 */
export class CTANFetcher {
    /**
     * @param {CTANFetcherOptions} [options] - Fetcher options
     */
    constructor(options = {}) {
        this.proxyUrl = options.proxyUrl || 'http://localhost:8787';
        this.bundlesUrl = options.bundlesUrl || this.proxyUrl + '/bundles';
        this.mountedFiles = new Set();
        this.fileCache = new Map(); // Memory cache for file contents
        this.loadedPackages = new Set();
        this.cacheGenerations = new Map();
        this.packageFetches = new Map(); // Track packages already loaded into memory
        this.fetchCount = 0;
        this.onLog = options.onLog || (() => {});

        // Set xzwasm URL if provided
        if (options.xzwasmUrl) {
            setXzwasmUrl(options.xzwasmUrl);
        }
    }

    /**
     * Load file-to-package index (maps filename.sty → package-name).
     * @returns {Promise<Object<string, string>>} Index mapping filenames to packages
     */
    async loadFileToPackageIndex() {
        return this._loadOwnershipIndex('file-to-package.json');
    }

    /** @private @param {string} name @returns {Promise<Object<string, string>>} */
    async _loadOwnershipIndex(name) {
        const url = `${this.bundlesUrl}/${name}`;
        let loading = fileToPackageByUrl.get(url);
        if (!loading) {
            loading = (async () => {
                let cache;
                try {
                    if (typeof caches !== 'undefined') cache = await caches.open('siglum-ctan-index-v1');
                } catch {}
                const readIndex = async response => {
                    if (!response?.ok) return null;
                    const index = await response.json();
                    return index && typeof index === 'object' && !Array.isArray(index) ? index : null;
                };
                const readSaved = async () => {
                    try { return await readIndex(await cache?.match(url)); }
                    catch { return null; }
                };
                const immutable = /\/releases\/tl2026-[a-f0-9]{16}\//.test(url);
                if (immutable) {
                    const saved = await readSaved();
                    if (saved) return saved;
                }
                try {
                    const response = await fetch(url);
                    const index = await readIndex(response);
                    if (index) {
                        // Persist ownership independently of service-worker installation.
                        try {
                            await cache?.put(url, new Response(JSON.stringify(index), {
                                headers: { 'Content-Type': 'application/json' },
                            }));
                        } catch {}
                        this.onLog(`Loaded file-to-package index: ${Object.keys(index).length} entries`);
                        return index;
                    }
                    this.onLog(`Failed to load file-to-package index: ${response.status}`);
                } catch (e) {
                    this.onLog(`Error loading file-to-package index: ${e.message}`);
                }
                return immutable ? null : readSaved();
            })();
            fileToPackageByUrl.set(url, loading);
        }

        const index = await loading;
        if (!index && fileToPackageByUrl.get(url) === loading) fileToPackageByUrl.delete(url);
        return index || {};
    }

    /**
     * Look up package name for a file.
     * @param {string} fileName - File name (e.g., "lingmacros.sty")
     * @returns {Promise<string|null>} Package name or null
     */
    async lookupPackageForFile(fileName) {
        const index = await this.loadFileToPackageIndex();
        if (Object.hasOwn(index, fileName) && typeof index[fileName] === 'string') return index[fileName];
        // TeX reports missing metrics by stem, including case-sensitive names.
        // Consult the release's generated ownership data rather than guessing a
        // package from that stem or relying on a server's local archive layout.
        if (!/^[A-Za-z0-9_.+-]+$/.test(fileName)
            || fileName.includes('.') && !/\.(?:tfm|vf|pfb|pfm|afm|otf|ttf|ttc|map|enc)$/i.test(fileName)) return null;
        const fonts = await this._loadOwnershipIndex('font-file-to-package.json');
        const stem = fileName.replace(/\.(?:tfm|vf|pfb|pfm|afm|otf|ttf|ttc|map|enc)$/i, '');
        for (const key of [fileName, stem]) {
            if (Object.hasOwn(fonts, key) && typeof fonts[key] === 'string') return fonts[key];
        }
        return null;
    }

    /**
     * Load font-name-to-package index (maps normalized family name → package).
     * @returns {Promise<Object<string, string>>} Index mapping font keys to packages
     */
    async loadFontNameIndex() {
        if (fontNameIndex) return fontNameIndex;
        if (fontNameLoading) return fontNameLoading;

        fontNameLoading = (async () => {
            try {
                const response = await fetch(`${this.bundlesUrl}/font-name-to-package.json`);
                if (response.ok) {
                    fontNameIndex = await response.json();
                    this.onLog(`Loaded font-name index: ${Object.keys(fontNameIndex).length} entries`);
                } else {
                    this.onLog(`Failed to load font-name index: ${response.status}`);
                    fontNameIndex = {};
                }
            } catch (e) {
                this.onLog(`Error loading font-name index: ${e.message}`);
                fontNameIndex = {};
            }
            return fontNameIndex;
        })();

        return fontNameLoading;
    }

    /**
     * Look up the TeX Live package that provides a font family.
     * @param {string} fontName - Font family name (e.g., "EB Garamond")
     * @returns {Promise<string|null>} Package name or null
     */
    async lookupPackageForFontName(fontName) {
        const index = await this.loadFontNameIndex();
        return index[normalizeFontName(fontName)] || null;
    }

    /**
     * Resolve a list of font family names to the set of packages that provide
     * them. Unknown names are returned separately so callers can report them.
     * @param {string[]} fontNames - Font family names from the document
     * @returns {Promise<{packages: string[], unresolved: string[]}>}
     */
    async resolveFontPackages(fontNames) {
        const index = await this.loadFontNameIndex();
        const packages = new Set();
        const unresolved = [];
        for (const name of fontNames) {
            const pkg = index[normalizeFontName(name)];
            if (pkg) {
                packages.add(pkg);
            } else {
                unresolved.push(name);
                this.onLog(`[FONT] No package found for font "${name}" (will rely on bundled/system fonts)`);
            }
        }
        return { packages: [...packages], unresolved };
    }

    /**
     * Get all cached file contents.
     * @returns {Object<string, Uint8Array>} Map of file paths to contents
     */
    // Only returns files that were loaded in this session (via fetchPackage)
    getCachedFiles() {
        return Object.fromEntries(this.fileCache);
    }

    /**
     * Load a package from cache.
     * @param {string} packageName - Package name
     * @returns {Promise<PackageResult|null>} Package result or null if not cached
     */
    async loadPackageFromCache(packageName, tlYear = null) {
        try {
            const key = packageCacheKey(packageName, tlYear);
            // Read old positive entries for offline compatibility. Old negative
            // markers cannot distinguish a missing package from a network outage.
            const meta = await getPackageMeta(key) || (!tlYear && await getPackageMeta(packageName));
            if (!meta || meta.cacheVersion !== CTAN_CACHE_VERSION) return null;
            if (meta.notFound) {
                const age = Date.now() - meta.checkedAt;
                return meta.status === 404 && meta.proxyUrl === this.proxyUrl
                    && meta.year === (tlYear || TEXLIVE_YEAR)
                    && age >= 0 && age < NEGATIVE_CACHE_TTL ? { notFound: true } : null;
            }
            if (!Array.isArray(meta.files) || !meta.files.length) return null;
            const sourceYear = /^texlive-(\d+)$/.exec(meta.source || '')?.[1];
            if (sourceYear && Number(sourceYear) !== (tlYear || TEXLIVE_YEAR)) return null;
            const fromMemory = !tlYear && (!meta.generation || this.cacheGenerations.get(key) === meta.generation);
            const files = new Map();
            await ensureTexliveMounted();
            const results = await Promise.all(meta.files.map(async path => {
                if (fromMemory && this.fileCache.has(path)) return [path, this.fileCache.get(path)];
                const content = await fileSystem.readBinary(meta.storagePaths?.[path] || path).catch(() => null);
                return content ? [path, new Uint8Array(content)] : null;
            }));
            // An evicted or incomplete package must be repaired, not advertised
            // as a cache hit. Never mount a partial package on that path.
            if (results.some(result => !result)) return null;
            for (const [path, content] of results) files.set(path, content);
            if (!tlYear) {
                for (const [path, content] of files) {
                    this.fileCache.set(path, content);
                    this.mountedFiles.add(path);
                }
                this.cacheGenerations.set(key, meta.generation);
            }
            this.onLog(`[Cache] ${packageName}: ${files.size} files (${meta.source || 'legacy'})`);
            return { files, dependencies: meta.dependencies || [] };
        } catch {
            return null;
        }
    }

    async _cachePackageResult(packageName, resolvedName, files, dependencies, source, tlYear, generation = null) {
        if (!files.size) return null;
        const key = packageCacheKey(packageName, tlYear);
        // Historical compatibility packages are compilation inputs, not the
        // current TeX tree. Do not leak them into a later document's file delta.
        if (!tlYear) {
            for (const [path, content] of files) {
                this.fileCache.set(path, content);
                this.mountedFiles.add(path);
            }
        }
        try {
            // Content-addressed storage makes a failed refresh harmless to the
            // previous package. Random generations also work on insecure LAN
            // origins where SubtleCrypto is unavailable.
            generation ||= await cacheGeneration();
            await ensureTexliveMounted();
            const prefix = `/texlive/.siglum-cache/v1/${tlYear ? "tl" + tlYear : TEXLIVE_YEAR}/${encodeURIComponent(resolvedName)}/${generation}`;
            const storagePaths = {};
            const writes = await Promise.allSettled([...files].map(async ([path, content]) => {
                // Proxy paths are VFS names, never filesystem traversal inputs.
                if (!path.startsWith('/texlive/') || path.split('/').some(part => part === '.' || part === '..')) {
                    throw new Error('Invalid package file path');
                }
                const savedPath = prefix + path.slice('/texlive'.length);
                await fileSystem.writeBinary(savedPath, content, { createParents: true });
                storagePaths[path] = savedPath;
            }));
            if (writes.some(result => result.status === 'rejected')) throw new Error('Incomplete package cache write');
            const meta = {
                name: resolvedName, files: [...files.keys()], storagePaths,
                dependencies, source, generation, cacheVersion: CTAN_CACHE_VERSION,
            };
            const saved = await savePackageMeta(key, meta);
            if (saved && !tlYear) this.cacheGenerations.set(key, generation);
            if (saved && resolvedName !== packageName) {
                await savePackageMeta(packageCacheKey(resolvedName, tlYear), meta);
                if (!tlYear) this.cacheGenerations.set(packageCacheKey(resolvedName, tlYear), generation);
            }
        } catch (error) {
            this.onLog(`[Cache] ${packageName}: not persisted (${error.message}); usable in this compilation`);
        }
        this.fetchCount++;
        if (!tlYear) {
            this.loadedPackages.add(packageName);
            this.loadedPackages.add(resolvedName);
        }
        return { files, dependencies };
    }

    async _cacheNotFound(packageName, tlYear) {
        await savePackageMeta(packageCacheKey(packageName, tlYear), {
            notFound: true, status: 404, checkedAt: Date.now(),
            proxyUrl: this.proxyUrl, year: tlYear || TEXLIVE_YEAR,
            cacheVersion: CTAN_CACHE_VERSION,
        });
    }

    /**
     * Fetch a package from CTAN/TexLive.
     * @param {string} packageName - Package name
     * @param {{tlYear?: number}} [options] - Options
     * @returns {Promise<PackageResult|null>} Package result or null if not found
     */
    async fetchPackage(packageName, options = {}) {
        const key = (options.tlYear ? 'tl' + options.tlYear : 'default' + TEXLIVE_YEAR) + ':' + packageName;
        const pending = this.packageFetches.get(key);
        if (pending) return pending;
        const task = this._fetchPackage(packageName, options);
        this.packageFetches.set(key, task);
        try { return await task; }
        finally { if (this.packageFetches.get(key) === task) this.packageFetches.delete(key); }
    }

    async _fetchPackage(packageName, options = {}) {
        const { tlYear } = options;
        const yearLabel = tlYear ? ` (TL${tlYear})` : '';
        this.onLog(`[FETCH] ${packageName}${yearLabel}: starting fetch`);

        {
            const cached = await this.loadPackageFromCache(packageName, tlYear);
            if (cached) {
                if (cached.notFound) {
                    // Package itself doesn't exist - but maybe the file is in a different package
                    // e.g., algorithm.sty is in the "algorithms" package
                    // Try common extensions in order of likelihood
                    const extensions = LATEX_FILE_EXTENSIONS;
                    for (const ext of extensions) {
                        const fileName = packageName + ext;
                        const realPkg = await this.lookupPackageForFile(fileName);
                        if (realPkg && realPkg !== packageName) {
                            this.onLog(`[FETCH] ${packageName}: not found, but ${fileName} is in package "${realPkg}"`);
                            return this.fetchPackage(realPkg, options);
                        }
                    }
                    this.onLog(`[FETCH] ${packageName}: marked as not found in cache`);
                    return null;
                }
                this.onLog(`[FETCH] ${packageName}: loaded from cache`);
                if (!tlYear) this.loadedPackages.add(packageName);
                return cached;
            }
        }

        this.onLog(`[FETCH] ${packageName}: not in cache, fetching from TexLive${yearLabel}...`);
        // Try TexLive first for version compatibility with our TeX Live 2026 kernel
        // (CTAN has latest versions that may require newer LaTeX)
        return this.fetchTexLivePackage(packageName, tlYear);
    }

    // Look up real TexLive archive name via CTAN API
    async lookupTexLivePackageName(packageName) {
        // Check memory cache first
        if (packageNameCache.has(packageName)) {
            return packageNameCache.get(packageName);
        }

        try {
            // Query CTAN API for package info
            const response = await fetch(`${this.proxyUrl}/api/ctan-pkg/${packageName}`);
            if (!response.ok) return packageName;

            const data = await response.json();
            // If package is contained in another, use that
            const realName = data.contained_in || data.name || packageName;
            packageNameCache.set(packageName, realName);
            return realName;
        } catch (e) {
            return packageName;
        }
    }

    // Fetch from TexLive archive
    // tlYear: optional year (2026, 2025, 2024, 2023) - if specified, goes directly to CTAN proxy
    async fetchTexLivePackage(packageName, tlYear = null) {
        const yearLabel = tlYear ? ` (TL${tlYear})` : '';

        const yearSuffix = tlYear ? `?tlYear=${tlYear}` : '';
        // Check persistent cache (same cache as CTAN)
        const cached = await this.loadPackageFromCache(packageName, tlYear);
        if (cached) {
            if (cached.notFound) {
                this.onLog(`Package ${packageName} marked as not found in cache`);
                return null;
            }
            this.onLog(`Package ${packageName} loaded from cache (TexLive)`);
            if (!tlYear) this.loadedPackages.add(packageName);
            return cached;
        }

        this.onLog(`[TEXLIVE] Fetching ${packageName} from TexLive ${tlYear || TEXLIVE_YEAR} via ${this.proxyUrl}...`);

        let response = null;
        let texlivePkg = packageName;

        // Try direct package name first
        try {
            const url = `${this.proxyUrl}/api/texlive/${packageName}${yearSuffix}`;
            this.onLog(`[TEXLIVE] Trying URL: ${url}`);
            response = await fetch(url);
            this.onLog(`[TEXLIVE] Response status: ${response?.status}`);
        } catch (e) {
            this.onLog(`[TEXLIVE] Fetch error: ${e.message}`);
            response = null;
        }

        // If not found, look up in file-to-package index (try common extensions)
        if (!response || !response.ok) {
            const extensions = LATEX_FILE_EXTENSIONS;
            for (const ext of extensions) {
                const fileName = packageName + ext;
                const realPkg = await this.lookupPackageForFile(fileName);
                if (realPkg && realPkg !== packageName) {
                    this.onLog(`${fileName} is in package "${realPkg}", fetching...`);
                    texlivePkg = realPkg;
                    try {
                        response = await fetch(`${this.proxyUrl}/api/texlive/${texlivePkg}${yearSuffix}`);
                        if (response?.ok) break;
                    } catch (e) {
                        response = null;
                    }
                }
            }
        }

        // If still not found, try CTAN API lookup as fallback
        if (!response || !response.ok) {
            this.onLog(`Looking up package container via CTAN API...`);
            const realName = await this.lookupTexLivePackageName(packageName);
            if (realName !== packageName) {
                this.onLog(`${packageName} is in ${realName}, fetching...`);
                texlivePkg = realName;
                try {
                    response = await fetch(`${this.proxyUrl}/api/texlive/${texlivePkg}${yearSuffix}`);
                } catch (e) {
                    response = null;
                }
            }
        }

        try {
            if (!response || !response.ok) {
                this.onLog(`[TEXLIVE] FAILED for ${packageName} (status=${response?.status}), falling back to CTAN...`);
                // Fall back to CTAN for packages not in TexLive 2026
                return tlYear ? null : this.fetchCtanPackage(packageName);
            }
            this.onLog(`[TEXLIVE] SUCCESS for ${packageName}, extracting XZ archive...`);

            // Get XZ-compressed TAR
            let xzData = await response.arrayBuffer();
            const generation = await cacheGeneration(xzData);
            const downloadedSize = xzData.byteLength;
            this.onLog(`Downloaded ${(downloadedSize / 1024).toFixed(1)} KB, decompressing...`);

            // Load xzwasm and decompress XZ using streaming
            // Use Blob.stream() instead of Response(arrayBuffer).body to avoid
            // ArrayBuffer detachment issues when multiple decompressions run in parallel
            const XzStream = await loadXzwasm();
            const xzStream = new XzStream(new Blob([xzData]).stream());
            xzData = null; // Allow GC of original buffer

            const reader = xzStream.getReader();
            const chunks = [];
            let totalLen = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // Must copy chunk - xzwasm may reuse its internal buffer
                const chunk = new Uint8Array(value);
                chunks.push(chunk);
                totalLen += chunk.length;
            }

            // Concatenate chunks into final TAR buffer
            this.onLog(`Decompressed ${chunks.length} chunks, total ${totalLen} bytes`);
            const tarData = new Uint8Array(totalLen);
            let pos = 0;
            for (let i = 0; i < chunks.length; i++) {
                tarData.set(chunks[i], pos);
                pos += chunks[i].length;
                chunks[i] = null; // Allow GC of chunk after copying
            }

            // Parse TAR
            const tarFiles = parseTar(tarData);
            this.onLog(`Extracted ${tarFiles.size} files from TAR (keys: ${[...tarFiles.keys()].slice(0,3).join(', ')}...)`);

            // Log package version for debugging
            for (const [tarPath, content] of tarFiles) {
                if (tarPath.endsWith(`${packageName}.sty`)) {
                    const text = new TextDecoder().decode(content.slice(0, 500));
                    const versionMatch = text.match(/ProvidesPackage\{[^}]+\}\[([^\]]+)\]/);
                    if (versionMatch) {
                        this.onLog(`Package ${packageName} version: ${versionMatch[1]}`);
                    }
                    break;
                }
            }

            // Process files (similar to CTAN fetch)
            const files = new Map();

            for (const [tarPath, content] of tarFiles) {
                // Skip docs and source directories
                if (tarPath.includes('/doc/') || tarPath.startsWith('doc/')) continue;
                if (tarPath.includes('/source/') || tarPath.startsWith('source/')) continue;

                const ext = tarPath.substring(tarPath.lastIndexOf('.')).toLowerCase();
                const fileName = tarPath.split('/').pop();

                // Include all non-doc/source files — packages may contain
                // arbitrary data files (.csv, .lua, .html, etc.)
                if (fileName && ext.startsWith('.')) {
                    // Map to texlive path structure
                    // Note: tar paths may or may not have leading slash
                    let targetPath;
                    if (tarPath.includes('/texmf-dist/') || tarPath.includes('texmf-dist/')) {
                        const idx = tarPath.indexOf('texmf-dist/');
                        targetPath = '/texlive/' + tarPath.substring(idx);
                    } else if (tarPath.startsWith('bibtex/') || tarPath.includes('/bibtex/')) {
                        targetPath = '/texlive/texmf-dist/' + tarPath.slice(tarPath.indexOf('bibtex/'));
                    } else if (tarPath.includes('/tex/') || tarPath.startsWith('tex/')) {
                        // Handle both /tex/ and tex/ (no leading slash)
                        const idx = tarPath.indexOf('tex/');
                        targetPath = '/texlive/texmf-dist/' + tarPath.substring(idx);
                    } else if (tarPath.includes('/fonts/') || tarPath.startsWith('fonts/')) {
                        const idx = tarPath.indexOf('fonts/');
                        targetPath = '/texlive/texmf-dist/' + tarPath.substring(idx);
                    } else {
                        targetPath = `/texlive/texmf-dist/tex/latex/${packageName}/${fileName}`;
                    }

                    const fileData = new Uint8Array(content);
                    files.set(targetPath, fileData);

                }
            }

            this.onLog(`Processed ${files.size} TeX/font files from ${packageName}`);
            return this._cachePackageResult(packageName, texlivePkg, files, [],
                `texlive-${tlYear || TEXLIVE_YEAR}`, tlYear, generation);
        } catch (e) {
            this.onLog(`[TEXLIVE] EXTRACTION ERROR for ${packageName}: ${e.message}`);
            this.onLog(`[TEXLIVE] Stack: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`);
            this.onLog(`[TEXLIVE] Falling back to CTAN (WARNING: may have older version)...`);
            return tlYear ? null : this.fetchCtanPackage(packageName);
        }
    }

    // Fetch from CTAN proxy (fallback when TexLive doesn't have the package)
    async fetchCtanPackage(packageName, tlYear = null) {
        const yearSuffix = tlYear ? `?tlYear=${tlYear}` : '';
        const yearLabel = tlYear ? ` (TL${tlYear})` : '';
        this.onLog(`[CTAN-FALLBACK] Fetching ${packageName}${yearLabel} from CTAN proxy...`);

        if (packageName === 'enumitem' && !tlYear) {
            this.onLog(`[CTAN-FALLBACK] *** WARNING: enumitem from CTAN may be v3.10 which has known bugs! ***`);
            this.onLog(`[CTAN-FALLBACK] *** TexLive 2026 should be used for enumitem v3.11 ***`);
        }

        let response = null;
        let ctanPkg = packageName;

        // Try direct package name first
        try {
            response = await fetch(`${this.proxyUrl}/api/fetch/${packageName}${yearSuffix}`);
        } catch (e) {
            response = null;
        }

        // If not found, look up in file-to-package index (try common extensions)
        if (!response || !response.ok) {
            const extensions = LATEX_FILE_EXTENSIONS;
            for (const ext of extensions) {
                const fileName = packageName + ext;
                const realPkg = await this.lookupPackageForFile(fileName);
                if (realPkg && realPkg !== packageName) {
                    this.onLog(`${fileName} is in package "${realPkg}", fetching from CTAN${yearLabel}...`);
                    ctanPkg = realPkg;
                    try {
                        response = await fetch(`${this.proxyUrl}/api/fetch/${ctanPkg}${yearSuffix}`);
                        if (response?.ok) break;
                    } catch (e) {
                        response = null;
                    }
                }
            }
        }

        try {
            if (!response || !response.ok) {
                this.onLog(`CTAN package ${packageName} unavailable (status=${response?.status || 'network'})`);
                if (response?.status === 404) await this._cacheNotFound(packageName, tlYear);
                return null;
            }

            const data = await response.json();
            if (data.error) {
                this.onLog(`CTAN fetch failed: ${data.error}`);
                return null;
            }

            // Production may resolve a file/font name to a different TeX Live archive.
            if (data.useTexLive && typeof data.texlivePackage === 'string') {
                return this.fetchTexLivePackage(data.texlivePackage, tlYear);
            }

            // Process and cache files
            const files = new Map();

            for (const [path, info] of Object.entries(data.files)) {
                let content;
                if (info.encoding === 'base64') {
                    const binary = atob(info.content);
                    content = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) {
                        content[i] = binary.charCodeAt(i);
                    }
                } else if (typeof info.content === 'string') {
                    content = new TextEncoder().encode(info.content);
                } else {
                    content = new Uint8Array(info.content);
                }
                files.set(path, content);

            }

            return this._cachePackageResult(packageName, ctanPkg, files,
                data.dependencies || [], tlYear ? `texlive-${tlYear}` : 'ctan', tlYear);
        } catch (e) {
            this.onLog(`CTAN fetch error: ${e.message}`);
            return null;
        }
    }

    async fetchWithDependencies(packageName, fetched = new Set()) {
        if (fetched.has(packageName)) return new Map();
        fetched.add(packageName);

        const result = await this.fetchPackage(packageName);
        if (!result) return new Map();

        const allFiles = new Map(result.files);

        // Fetch dependencies
        for (const dep of result.dependencies) {
            const depFiles = await this.fetchWithDependencies(dep, fetched);
            for (const [path, content] of depFiles) {
                allFiles.set(path, content);
            }
        }

        return allFiles;
    }

    /**
     * Batch fetch multiple packages in parallel.
     * Used for pre-fetching detected CTAN packages before compilation.
     * @param {string[]} packageNames - Package names to fetch
     * @param {Object} options
     * @param {number} options.concurrency - Max parallel fetches (default: 1, see note below)
     * @returns {Promise<{fetched: string[], failed: string[], skipped: string[]}>}
     */
    async batchFetchPackages(packageNames, options = {}) {
        // Concurrency limited to 1 because xzwasm's WASM module has shared internal state
        // that causes "detached ArrayBuffer" errors when multiple decompressions run in parallel.
        // HTTP fetches are still fast, and decompression is CPU-bound anyway, so serialization
        // doesn't significantly impact total time (~200ms for 10 packages).
        const { concurrency = 1 } = options;

        const fetched = [];
        const failed = [];
        const skipped = [];

        // Deduplicate requested names
        const uniquePackages = [...new Set(packageNames)];

        // Resolve each requested package to its CONTAINER package up front. Many
        // sub-packages share one TeX Live container — e.g. tikz, pgfcore, pgfsys,
        // pgfkeys, pgfmath, pgffor … all live in "pgf". Without this, each name
        // independently misses the cache and re-downloads + re-decompresses the
        // same multi-MB archive (the bug: pgf fetched ~13× per tikz compile).
        // fetchPackage() would redirect each name to its container anyway, so
        // collapsing them here is behaviour-preserving but fetches once.
        const membersOf = new Map();  // container -> [requestedName, ...]
        for (const pkgName of uniquePackages) {
            let container = pkgName;
            if (!options.tlYear) {
                for (const ext of LATEX_FILE_EXTENSIONS) {
                    const realPkg = await this.lookupPackageForFile(pkgName + ext);
                    if (realPkg && realPkg !== pkgName) { container = realPkg; break; }
                }
            }
            if (!membersOf.has(container)) membersOf.set(container, []);
            membersOf.get(container).push(pkgName);
        }

        const toFetch = [];  // containers needing a network fetch

        // Check cache first (keyed by container) to avoid filesystem reads on recompile.
        for (const [container, members] of membersOf) {
            // Already loaded into memory this session (container or any member)?
            if (!options.tlYear && (this.loadedPackages.has(container) || members.some((m) => this.loadedPackages.has(m)))) {
                this.loadedPackages.add(container);
                skipped.push(...members);
                continue;
            }
            const cached = await this.loadPackageFromCache(container, options.tlYear);
            if (cached && cached.files && !cached.notFound) {
                if (!options.tlYear) {
                    for (const [path, content] of cached.files) this.fileCache.set(path, content);
                    this.loadedPackages.add(container);
                    for (const m of members) this.loadedPackages.add(m);
                }
                skipped.push(...members);
            } else {
                toFetch.push(container);
            }
        }

        if (toFetch.length === 0) {
            this.onLog(`[PRE-FETCH] Done: ${fetched.length} fetched, ${failed.length} failed, ${skipped.length} cached`);
            return { fetched, failed, skipped };
        }

        this.onLog(`[PRE-FETCH] Batch fetching ${toFetch.length} container package${toFetch.length === 1 ? '' : 's'} (from ${uniquePackages.length} requested)...`);

        // Fetch in chunks with concurrency limit
        for (let i = 0; i < toFetch.length; i += concurrency) {
            const chunk = toFetch.slice(i, i + concurrency);
            const results = await Promise.allSettled(
                chunk.map(async (container) => {
                    const result = await this.fetchPackage(container, { tlYear: options.tlYear });
                    return { container, result };
                })
            );

            for (const res of results) {
                const container = res.status === 'fulfilled' ? res.value.container : null;
                const members = (container && membersOf.get(container)) || (container ? [container] : []);
                if (res.status === 'fulfilled' && res.value.result) {
                    if (!options.tlYear) this.loadedPackages.add(container);
                    for (const m of members) {
                        if (!options.tlYear) this.loadedPackages.add(m);
                        fetched.push(m);
                    }
                } else {
                    failed.push(...(members.length ? members : ['unknown']));
                }
            }
        }

        this.onLog(`[PRE-FETCH] Done: ${fetched.length} fetched, ${failed.length} failed, ${skipped.length} cached`);
        return { fetched, failed, skipped };
    }

    /**
     * Get list of all mounted file paths.
     * @returns {string[]} Array of file paths
     */
    getMountedFiles() {
        return [...this.mountedFiles];
    }

    /**
     * Get fetcher statistics.
     * @returns {{fetchCount: number, mountedFiles: number}} Stats object
     */
    getStats() {
        return {
            fetchCount: this.fetchCount,
            mountedFiles: this.mountedFiles.size,
        };
    }

    /**
     * Clear the mounted files set and memory caches.
     */
    clearMountedFiles() {
        this.mountedFiles.clear();
        this.fileCache.clear();
        this.loadedPackages.clear();
    }
}

/**
 * Extract package name from a missing file path.
 * Handles special cases like EC/TC fonts (cm-super).
 * @param {string} filename - File name (e.g., "lingmacros.sty")
 * @returns {string} Package name
 */
export function getPackageFromFile(filename) {
    // Check for EC/TC fonts (cm-super)
    if (/^(ec|tc)[a-z]{2}\d+$/.test(filename)) {
        return 'cm-super';
    }
    // Remove extension
    return filename.replace(/\.(sty|cls|def|clo|fd|cfg|tex)$/, '');
}

/**
 * Check if a string is a valid CTAN package name.
 * @param {string} name - Package name to validate
 * @returns {boolean} True if valid
 */
export function isValidPackageName(name) {
    if (!name || name.length < 2 || name.length > 50) return false;
    if (/[^a-zA-Z0-9_-]/.test(name)) return false;
    // Skip common false positives
    const skipList = ['document', 'texput', 'null', 'undefined', 'NaN'];
    if (skipList.includes(name)) return false;
    return true;
}

/**
 * Force clear a specific package from cache (for version refresh).
 * @param {string} packageName - Package name to clear
 * @returns {Promise<boolean>} True if successful
 */
export async function forceRefreshPackage(packageName) {
    try {
        const invalid = {
            name: packageName,
            notFound: false,
            cacheVersion: 0,  // Force version mismatch on next load
            files: [],
            clearedAt: Date.now()
        };
        const saved = await savePackageMeta(packageCacheKey(packageName), invalid);
        const legacy = await savePackageMeta(packageName, invalid);
        return Boolean(saved && legacy);
    } catch (e) {
        return false;
    }
}
