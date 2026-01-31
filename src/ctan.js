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
const LATEX_FILE_EXTENSIONS = ['.sty', '.cls', '.def', '.clo', '.fd', '.cfg', '.tex'];

// Lazy load xzwasm when needed (UMD module loaded via script tag)
let XzReadableStream = null;
let xzwasmUrl = './src/xzwasm.js'; // Default, can be overridden

function setXzwasmUrl(url) {
    xzwasmUrl = url;
}

async function loadXzwasm() {
    if (XzReadableStream) return XzReadableStream;

    // Load UMD module via script tag
    return new Promise((resolve, reject) => {
        if (self.xzwasm) {
            XzReadableStream = self.xzwasm.XzReadableStream;
            resolve(XzReadableStream);
            return;
        }
        const script = document.createElement('script');
        script.src = xzwasmUrl;
        script.onload = () => {
            XzReadableStream = self.xzwasm.XzReadableStream;
            resolve(XzReadableStream);
        };
        script.onerror = () => reject(new Error('Failed to load xzwasm from ' + xzwasmUrl));
        document.head.appendChild(script);
    });
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

// Note: We use TexLive 2025 for ALL packages for version compatibility

// Dynamic package name cache (populated by CTAN API lookups)
const packageNameCache = new Map();

// File-to-package index (loaded from server on first use)
let fileToPackageIndex = null;
let fileToPackageLoading = null;

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
        this.loadedPackages = new Set(); // Track packages already loaded into memory
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
        if (fileToPackageIndex) return fileToPackageIndex;
        if (fileToPackageLoading) return fileToPackageLoading;

        fileToPackageLoading = (async () => {
            try {
                const response = await fetch(`${this.bundlesUrl}/file-to-package.json`);
                if (response.ok) {
                    fileToPackageIndex = await response.json();
                    this.onLog(`Loaded file-to-package index: ${Object.keys(fileToPackageIndex).length} entries`);
                } else {
                    this.onLog(`Failed to load file-to-package index: ${response.status}`);
                    fileToPackageIndex = {};
                }
            } catch (e) {
                this.onLog(`Error loading file-to-package index: ${e.message}`);
                fileToPackageIndex = {};
            }
            return fileToPackageIndex;
        })();

        return fileToPackageLoading;
    }

    /**
     * Look up package name for a file.
     * @param {string} fileName - File name (e.g., "lingmacros.sty")
     * @returns {Promise<string|null>} Package name or null
     */
    async lookupPackageForFile(fileName) {
        const index = await this.loadFileToPackageIndex();
        return index[fileName] || null;
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
    async loadPackageFromCache(packageName) {
        try {
            const meta = await getPackageMeta(packageName);
            if (!meta) {
                this.onLog(`[Cache] ${packageName}: no metadata found - will fetch fresh`);
                return null;
            }

            // Check cache version
            if (meta.cacheVersion !== CTAN_CACHE_VERSION) {
                this.onLog(`[Cache] ${packageName}: version mismatch (cached=${meta.cacheVersion}, current=${CTAN_CACHE_VERSION}) - will refetch`);
                return null;
            }
            this.onLog(`[Cache] ${packageName}: loading from cache (v${meta.cacheVersion}, source=${meta.source || 'unknown'})`);

            // Check if it's a "not found" marker
            if (meta.notFound) return { notFound: true };

            // Check memory cache first, then filesystem
            const files = new Map();
            if (meta.files && meta.files.length > 0) {
                const filesToLoad = [];
                for (const filePath of meta.files) {
                    if (this.fileCache.has(filePath)) {
                        files.set(filePath, this.fileCache.get(filePath));
                        this.mountedFiles.add(filePath);
                    } else {
                        filesToLoad.push(filePath);
                    }
                }

                // Load any missing files from filesystem cache
                if (filesToLoad.length > 0) {
                    await ensureTexliveMounted();
                    const results = await Promise.all(
                        filesToLoad.map(async (filePath) => {
                            const content = await fileSystem.readBinary(filePath).catch(() => null);
                            return content ? [filePath, new Uint8Array(content)] : null;
                        })
                    );
                    for (const result of results) {
                        if (result) {
                            files.set(result[0], result[1]);
                            this.mountedFiles.add(result[0]);
                            this.fileCache.set(result[0], result[1]); // Cache in memory
                        }
                    }
                }
            }

            return {
                files,
                dependencies: meta.dependencies || [],
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Fetch a package from CTAN/TexLive.
     * @param {string} packageName - Package name
     * @param {{tlYear?: number}} [options] - Options
     * @returns {Promise<PackageResult|null>} Package result or null if not found
     */
    async fetchPackage(packageName, options = {}) {
        const { tlYear } = options;
        const yearLabel = tlYear ? ` (TL${tlYear})` : '';
        this.onLog(`[FETCH] ${packageName}${yearLabel}: starting fetch`);

        // Skip cache for version-specific requests - we want a different version
        if (!tlYear) {
            // Check persistent cache
            const cached = await this.loadPackageFromCache(packageName);
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
                this.loadedPackages.add(packageName);
                return cached;
            }
        } else {
            this.onLog(`[FETCH] ${packageName}: skipping cache for TL${tlYear} request`);
        }

        this.onLog(`[FETCH] ${packageName}: not in cache, fetching from TexLive${yearLabel}...`);
        // Try TexLive first for version compatibility with our LaTeX 2022-11-01
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
    // tlYear: optional year (2025, 2024, 2023) - if specified, goes directly to CTAN proxy
    async fetchTexLivePackage(packageName, tlYear = null) {
        const yearLabel = tlYear ? ` (TL${tlYear})` : '';

        // If specific TL year requested, go directly to CTAN proxy (skip local archive)
        // This is used for version fallback when kernel incompatibility is detected
        if (tlYear) {
            this.onLog(`[TEXLIVE] Fetching ${packageName} from TL${tlYear} via CTAN proxy...`);
            return this.fetchCtanPackage(packageName, tlYear);
        }

        // Check persistent cache (same cache as CTAN)
        const cached = await this.loadPackageFromCache(packageName);
        if (cached) {
            if (cached.notFound) {
                this.onLog(`Package ${packageName} marked as not found in cache`);
                return null;
            }
            this.onLog(`Package ${packageName} loaded from cache (TexLive)`);
            this.loadedPackages.add(packageName);
            return cached;
        }

        this.onLog(`[TEXLIVE] Fetching ${packageName} from TexLive 2025 via ${this.proxyUrl}...`);

        let response = null;
        let texlivePkg = packageName;

        // Try direct package name first
        try {
            const url = `${this.proxyUrl}/api/texlive/${packageName}`;
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
                        response = await fetch(`${this.proxyUrl}/api/texlive/${texlivePkg}`);
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
                    response = await fetch(`${this.proxyUrl}/api/texlive/${texlivePkg}`);
                } catch (e) {
                    response = null;
                }
            }
        }

        try {
            if (!response || !response.ok) {
                this.onLog(`[TEXLIVE] FAILED for ${packageName} (status=${response?.status}), falling back to CTAN...`);
                // Fall back to CTAN for packages not in TexLive 2025
                return this.fetchCtanPackage(packageName);
            }
            this.onLog(`[TEXLIVE] SUCCESS for ${packageName}, extracting XZ archive...`);

            // Get XZ-compressed TAR
            let xzData = await response.arrayBuffer();
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
            const texExtensions = ['.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo', '.ltx'];
            const fontExtensions = ['.pfb', '.pfm', '.afm', '.tfm', '.vf', '.map', '.enc'];
            const files = new Map();
            const cacheWrites = [];

            await ensureTexliveMounted();

            for (const [tarPath, content] of tarFiles) {
                // Skip docs and source
                if (tarPath.includes('/doc/') || tarPath.startsWith('doc/')) continue;
                if (tarPath.includes('/source/') || tarPath.startsWith('source/')) continue;

                const ext = tarPath.substring(tarPath.lastIndexOf('.')).toLowerCase();
                const fileName = tarPath.split('/').pop();

                if (texExtensions.includes(ext) || fontExtensions.includes(ext)) {
                    // Map to texlive path structure
                    // Note: tar paths may or may not have leading slash
                    let targetPath;
                    if (tarPath.includes('/texmf-dist/') || tarPath.includes('texmf-dist/')) {
                        const idx = tarPath.indexOf('texmf-dist/');
                        targetPath = '/texlive/' + tarPath.substring(idx);
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
                    this.mountedFiles.add(targetPath);
                    this.fileCache.set(targetPath, fileData);
                    cacheWrites.push(fileSystem.writeBinary(targetPath, fileData, { createParents: true }).catch(() => {}));
                }
            }

            // Parallel filesystem cache writes
            await Promise.all(cacheWrites);

            this.onLog(`Processed ${files.size} TeX/font files from ${packageName}`);

            if (files.size === 0) {
                this.onLog(`No TeX files found in ${packageName}, marking as not found`);
                await savePackageMeta(packageName, {
                    notFound: true,
                    cacheVersion: CTAN_CACHE_VERSION,
                });
                return null;
            }

            // Cache metadata under the requested package name
            const cacheEntry = {
                name: texlivePkg, // The actual package that provided the files
                files: [...files.keys()],
                dependencies: [],
                cacheVersion: CTAN_CACHE_VERSION,
                source: 'texlive-2025',
            };
            await savePackageMeta(packageName, cacheEntry);

            // Also cache under the resolved name if different (avoids duplicate fetches)
            if (texlivePkg !== packageName) {
                await savePackageMeta(texlivePkg, cacheEntry);
                this.onLog(`Cached under both "${packageName}" and "${texlivePkg}"`);
            }

            this.fetchCount++;
            this.loadedPackages.add(packageName);
            if (texlivePkg !== packageName) {
                this.loadedPackages.add(texlivePkg);
            }
            return { files, dependencies: [] };
        } catch (e) {
            this.onLog(`[TEXLIVE] EXTRACTION ERROR for ${packageName}: ${e.message}`);
            this.onLog(`[TEXLIVE] Stack: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`);
            this.onLog(`[TEXLIVE] Falling back to CTAN (WARNING: may have older version)...`);
            return this.fetchCtanPackage(packageName);
        }
    }

    // Fetch from CTAN proxy (fallback when TexLive doesn't have the package)
    async fetchCtanPackage(packageName, tlYear = null) {
        const yearSuffix = tlYear ? `?tlYear=${tlYear}` : '';
        const yearLabel = tlYear ? ` (TL${tlYear})` : '';
        this.onLog(`[CTAN-FALLBACK] Fetching ${packageName}${yearLabel} from CTAN proxy...`);

        if (packageName === 'enumitem' && !tlYear) {
            this.onLog(`[CTAN-FALLBACK] *** WARNING: enumitem from CTAN may be v3.10 which has known bugs! ***`);
            this.onLog(`[CTAN-FALLBACK] *** TexLive 2025 should be used for enumitem v3.11 ***`);
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
                this.onLog(`CTAN package ${packageName} not found (404)`);
                await savePackageMeta(packageName, {
                    notFound: true,
                    cacheVersion: CTAN_CACHE_VERSION,
                });
                return null;
            }

            const data = await response.json();
            if (data.error) {
                this.onLog(`CTAN fetch failed: ${data.error}`);
                await savePackageMeta(packageName, {
                    notFound: true,
                    cacheVersion: CTAN_CACHE_VERSION,
                });
                return null;
            }

            // Process and cache files
            const files = new Map();
            const cacheWrites = [];
            await ensureTexliveMounted();
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
                this.mountedFiles.add(path);
                this.fileCache.set(path, content);
                cacheWrites.push(fileSystem.writeBinary(path, content, { createParents: true }).catch(() => {}));
            }

            // Parallel filesystem cache writes
            await Promise.all(cacheWrites);

            // Cache metadata under the requested package name
            const cacheEntry = {
                name: ctanPkg, // The actual package that provided the files
                files: [...files.keys()],
                dependencies: data.dependencies || [],
                cacheVersion: CTAN_CACHE_VERSION,
                source: 'ctan',
            };
            await savePackageMeta(packageName, cacheEntry);

            // Also cache under the resolved name if different (avoids duplicate fetches)
            if (ctanPkg !== packageName) {
                await savePackageMeta(ctanPkg, cacheEntry);
                this.onLog(`Cached under both "${packageName}" and "${ctanPkg}"`);
            }

            this.fetchCount++;
            this.loadedPackages.add(packageName);
            if (ctanPkg !== packageName) {
                this.loadedPackages.add(ctanPkg);
            }
            return {
                files,
                dependencies: data.dependencies || [],
            };
        } catch (e) {
            this.onLog(`CTAN fetch error: ${e.message}`);
            await savePackageMeta(packageName, {
                notFound: true,
                cacheVersion: CTAN_CACHE_VERSION,
            });
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

        // Deduplicate
        const uniquePackages = [...new Set(packageNames)];
        const toFetch = [];

        // Check cache first - use memory cache to avoid filesystem reads on every recompile
        for (const pkgName of uniquePackages) {
            // Skip filesystem check if package already loaded into memory this session
            if (this.loadedPackages.has(pkgName)) {
                skipped.push(pkgName);
                continue;
            }

            const cached = await this.loadPackageFromCache(pkgName);
            if (cached && cached.files && !cached.notFound) {
                // Already cached and has files - populate memory cache
                for (const [path, content] of cached.files) {
                    this.fileCache.set(path, content);
                }
                this.loadedPackages.add(pkgName);
                skipped.push(pkgName);
            } else {
                toFetch.push(pkgName);
            }
        }

        if (toFetch.length === 0) {
            return { fetched, failed, skipped };
        }

        this.onLog(`[PRE-FETCH] Batch fetching ${toFetch.length} packages...`);

        // Fetch in chunks with concurrency limit
        for (let i = 0; i < toFetch.length; i += concurrency) {
            const chunk = toFetch.slice(i, i + concurrency);
            const results = await Promise.allSettled(
                chunk.map(async (pkgName) => {
                    const result = await this.fetchPackage(pkgName);
                    return { pkgName, result };
                })
            );

            for (const res of results) {
                if (res.status === 'fulfilled' && res.value.result) {
                    fetched.push(res.value.pkgName);
                    this.loadedPackages.add(res.value.pkgName);
                } else {
                    const pkgName = res.status === 'fulfilled'
                        ? res.value.pkgName
                        : 'unknown';
                    failed.push(pkgName);
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
        await savePackageMeta(packageName, {
            name: packageName,
            notFound: false,
            cacheVersion: 0,  // Force version mismatch on next load
            files: [],
            clearedAt: Date.now()
        });
        return true;
    } catch (e) {
        return false;
    }
}
