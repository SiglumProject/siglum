/**
 * @module @siglum/engine/bundles
 * Bundle loading and package resolution for LaTeX compilation.
 */

import {
    getBundleFromCache,
    saveBundleToCache,
    getManifestFromCache,
    saveManifestToCache,
    getManifestVersion,
    saveManifestVersion,
    MANIFEST_CACHE_VERSION,
} from './storage.js';

import { hashPreamble } from './hash.js';

// Check if SharedArrayBuffer is available (requires COOP/COEP headers)
const sharedArrayBufferSupported = typeof SharedArrayBuffer !== 'undefined';

// Decompression using native CompressionStream
// Returns SharedArrayBuffer when available for zero-copy sharing with workers
async function decompress(compressed, format = 'gzip') {
    // If format is 'none', return as-is (already decompressed by browser)
    let data;
    if (format === 'none') {
        data = compressed;
    } else {
        const ds = new DecompressionStream(format);
        const blob = new Blob([compressed]);
        const stream = blob.stream().pipeThrough(ds);
        data = await new Response(stream).arrayBuffer();
    }

    // Convert to SharedArrayBuffer for zero-copy worker access
    if (sharedArrayBufferSupported) {
        const shared = new SharedArrayBuffer(data.byteLength);
        new Uint8Array(shared).set(new Uint8Array(data));
        return shared;
    }

    return data;
}

/**
 * @typedef {Object} BundleManagerOptions
 * @property {string} [bundleBase] - Base URL for bundles
 * @property {(msg: string) => void} [onLog] - Logging callback
 * @property {(stage: string, detail: string) => void} [onProgress] - Progress callback
 */

/**
 * Manages LaTeX package bundles - loading, caching, and resolution.
 */
export class BundleManager {
    /**
     * @param {BundleManagerOptions} [options] - Manager options
     */
    constructor(options = {}) {
        this.bundleBase = options.bundleBase || 'packages/bundles';
        this.bundleCache = new Map();  // In-memory bundle cache
        this.fileManifest = null;
        this.packageMap = null;
        this.bundleDeps = null;
        this.packageDeps = null;
        this.bundleRegistry = null;
        this.bytesDownloaded = 0;
        this.cacheHitCount = 0;
        this.onLog = options.onLog || (() => {});
        this.onProgress = options.onProgress || (() => {});
    }

    /**
     * Compute a hash for bundle versioning based on manifest entries
     * Uses the file paths and sizes to detect changes
     */
    getBundleHash(bundleName) {
        if (!this.fileManifest) return null;

        // Get all files in this bundle and create a version string
        const bundleFiles = Object.entries(this.fileManifest)
            .filter(([_, info]) => info.bundle === bundleName)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, info]) => `${path}:${info.size}`)
            .join('|');

        // Simple hash of the version string
        let hash = 0;
        for (let i = 0; i < bundleFiles.length; i++) {
            const char = bundleFiles.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString(16);
    }

    /**
     * Load bundle manifests from cache or server.
     * @returns {Promise<Object>} File manifest
     */
    async loadManifest() {
        if (this.fileManifest) return this.fileManifest;

        // Check cache first
        const cachedVersion = await getManifestVersion();
        if (cachedVersion === MANIFEST_CACHE_VERSION) {
            const [manifest, bundlesData] = await Promise.all([
                getManifestFromCache('file-manifest'),
                getManifestFromCache('bundles'),
            ]);

            if (manifest && bundlesData) {
                this.onLog('Manifests loaded from cache');
                this.fileManifest = manifest;
                this._initFromBundlesData(bundlesData);
                return this.fileManifest;
            }
        }

        // Fetch fresh manifests
        const [manifestRes, bundlesRes] = await Promise.all([
            fetch(`${this.bundleBase}/file-manifest.json`),
            fetch(`${this.bundleBase}/bundles.json`),
        ]);

        this.fileManifest = await manifestRes.json();
        const bundlesData = await bundlesRes.json();
        this._initFromBundlesData(bundlesData);

        // Save to cache (await to ensure cache is populated)
        try {
            await Promise.all([
                saveManifestToCache('file-manifest', this.fileManifest),
                saveManifestToCache('bundles', bundlesData),
                saveManifestVersion(MANIFEST_CACHE_VERSION),
            ]);
            this.onLog('Manifests saved to cache');
        } catch (e) {
            // Cache save failed, continue anyway
        }

        return this.fileManifest;
    }

    _initFromBundlesData(bundlesData) {
        // Extract bundle registry (set of bundle names)
        this.bundleRegistry = new Set(Object.keys(bundlesData.bundles || {}));
        // Extract package map
        this.packageMap = bundlesData.packages || {};
        // Extract bundle deps (engines, bundle requires, deferred)
        this.bundleDeps = {
            engines: bundlesData.engines || {},
            bundles: {},
            deferred: bundlesData.deferred || [],
        };
        // Build bundle dependency map from bundlesData.bundles
        for (const [name, info] of Object.entries(bundlesData.bundles || {})) {
            if (info.requires && info.requires.length > 0) {
                this.bundleDeps.bundles[name] = { requires: info.requires };
            }
        }
    }

    /**
     * Load bundle dependency information.
     * @returns {Promise<Object>} Bundle dependencies
     */
    async loadBundleDeps() {
        // Ensure manifest is loaded first (sets bundleDeps)
        if (!this.bundleDeps) {
            await this.loadManifest();
        }

        // Load optional package-deps.json for package-level dependencies
        // This must run even if bundleDeps is already loaded!
        if (!this.packageDeps) {
            const cachedVersion = await getManifestVersion();
            if (cachedVersion === MANIFEST_CACHE_VERSION) {
                const packageDeps = await getManifestFromCache('package-deps');
                if (packageDeps) {
                    this.packageDeps = packageDeps;
                    return this.bundleDeps;
                }
            }

            try {
                const packageDepsRes = await fetch(`${this.bundleBase}/package-deps.json`).catch(() => null);
                if (packageDepsRes?.ok) {
                    this.packageDeps = await packageDepsRes.json();
                    try {
                        await saveManifestToCache('package-deps', this.packageDeps);
                    } catch (e) {
                        // Cache save failed, continue anyway
                    }
                }
            } catch (e) {
                // package-deps is optional
            }
        }

        return this.bundleDeps;
    }

    /**
     * Check if a bundle exists in the registry.
     * @param {string} bundleName - Bundle name
     * @returns {boolean}
     */
    bundleExists(bundleName) {
        return this.bundleRegistry?.has(bundleName) ?? false;
    }

    /**
     * Resolve packages to their required bundles.
     * @param {string[]} packages - Package names
     * @param {string} [engine] - Engine name
     * @returns {string[]} Bundle names
     */
    resolveBundles(packages, engine = 'xelatex') {
        const bundles = new Set();
        const resolved = new Set();

        // Add engine-required bundles from bundle-deps.json
        const engineDeps = this.bundleDeps?.engines?.[engine];
        if (engineDeps?.required) {
            for (const b of engineDeps.required) {
                if (this.bundleExists(b)) bundles.add(b);
            }
        }

        // Recursive function to add bundle and its dependencies
        const addBundle = (bundleName) => {
            if (resolved.has(bundleName)) return;
            resolved.add(bundleName);

            if (!this.bundleExists(bundleName)) return;
            bundles.add(bundleName);

            // Resolve bundle dependencies from bundleDeps.bundles
            const bundleInfo = this.bundleDeps?.bundles?.[bundleName];
            if (bundleInfo?.requires) {
                for (const dep of bundleInfo.requires) {
                    addBundle(dep);
                }
            }
        };

        const resolvePackage = (pkg) => {
            if (resolved.has('pkg:' + pkg)) return;
            resolved.add('pkg:' + pkg);

            // Find bundle for package
            const bundleName = this.packageMap?.[pkg];
            if (bundleName) {
                addBundle(bundleName);
            }

            // Resolve package-level dependencies
            const pkgDeps = this.packageDeps?.[pkg] || [];
            for (const dep of pkgDeps) {
                resolvePackage(dep);
            }
        };

        for (const pkg of packages) {
            resolvePackage(pkg);
        }

        // Filter to only existing bundles
        return [...bundles].filter(b => this.bundleExists(b));
    }

    /**
     * Extract packages from LaTeX source and resolve to bundles.
     * @param {string} source - LaTeX source
     * @param {string} [engine] - Engine name
     * @returns {{packages: string[], bundles: string[]}}
     */
    checkPackages(source, engine = 'xelatex') {
        const packages = new Set();

        // Extract \usepackage commands
        const usePackageRegex = /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
        let match;
        while ((match = usePackageRegex.exec(source)) !== null) {
            const pkgList = match[1].split(',').map(p => p.trim());
            for (const pkg of pkgList) packages.add(pkg);
        }

        // Extract \documentclass
        const docclassMatch = source.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/);
        if (docclassMatch) {
            packages.add(docclassMatch[1]);
        }

        // Extract \RequirePackage
        const requireRegex = /\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
        while ((match = requireRegex.exec(source)) !== null) {
            const pkgList = match[1].split(',').map(p => p.trim());
            for (const pkg of pkgList) packages.add(pkg);
        }

        const bundles = this.resolveBundles([...packages], engine);
        return { packages: [...packages], bundles };
    }

    /**
     * Pre-scan source to identify packages needing CTAN fetch.
     * Expands detected packages with known dependencies from packageDeps.
     * Scans additionalFiles for multi-file documents.
     *
     * @param {string} source - Main LaTeX source
     * @param {string} engine - Engine (pdflatex, xelatex, etc.)
     * @param {Object} additionalFiles - Optional map of filename → content
     * @returns {{ bundledPackages: string[], ctanPackages: string[] }}
     */
    prescanForCtanPackages(source, engine = 'pdflatex', additionalFiles = {}) {
        const packages = new Set();

        // Helper to extract package names from a match
        const extractPackages = (content) => {
            return content.split(',').map(p => p.trim()).filter(p => p);
        };

        // Helper to scan source for package commands
        const scanSource = (text) => {
            // \usepackage[options]{pkg1,pkg2}
            const usePackageRegex = /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
            let match;
            while ((match = usePackageRegex.exec(text)) !== null) {
                for (const pkg of extractPackages(match[1])) packages.add(pkg);
            }

            // \RequirePackage[options]{pkg} and \RequirePackageWithOptions{pkg}
            const requireRegex = /\\RequirePackage(?:WithOptions)?(?:\[[^\]]*\])?\{([^}]+)\}/g;
            while ((match = requireRegex.exec(text)) !== null) {
                for (const pkg of extractPackages(match[1])) packages.add(pkg);
            }

            // \documentclass[options]{class}
            const docclassMatch = text.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/);
            if (docclassMatch) {
                packages.add(docclassMatch[1]);
            }

            // \LoadClass[options]{class} and \LoadClassWithOptions{class}
            const loadClassRegex = /\\LoadClass(?:WithOptions)?(?:\[[^\]]*\])?\{([^}]+)\}/g;
            while ((match = loadClassRegex.exec(text)) !== null) {
                packages.add(match[1]);
            }
        };

        // Scan main source
        scanSource(source);

        // Scan additional files (for multi-file documents)
        const texFiles = Object.entries(additionalFiles).filter(([f]) => f.endsWith('.tex'));
        if (texFiles.length > 0) {
            const decoder = new TextDecoder(); // Reuse for all files
            for (const [, content] of texFiles) {
                const text = typeof content === 'string' ? content : decoder.decode(content);
                scanSource(text);
            }
        }

        // Expand with known dependencies from packageDeps
        const expanded = new Set(packages);
        const visited = new Set();

        const expandDeps = (pkg) => {
            if (visited.has(pkg)) return;
            visited.add(pkg);

            const deps = this.packageDeps?.packages?.[pkg] || [];
            for (const dep of deps) {
                // Skip obviously invalid entries (LaTeX syntax that leaked into deps)
                if (!dep || dep.startsWith('#') || dep.startsWith('\\')) continue;
                expanded.add(dep);
                expandDeps(dep); // Recursive
            }
        };

        for (const pkg of packages) {
            expandDeps(pkg);
        }

        // Get bundles that will be loaded based on direct packages (not deps)
        const directBundles = new Set(this.resolveBundles([...packages], engine));

        // Categorize expanded packages:
        // - bundled: in a bundle that will be loaded
        // - additionalBundles: in a bundle that exists but won't be loaded (dependency-only)
        // - ctanPackages: not in any bundle, need CTAN fetch
        const bundledPackages = [];
        const ctanPackages = [];
        const additionalBundles = new Set();

        for (const pkg of expanded) {
            const bundleName = this.packageMap?.[pkg];
            if (bundleName && this.bundleExists(bundleName)) {
                if (directBundles.has(bundleName)) {
                    // Bundle will be loaded from direct packages
                    bundledPackages.push(pkg);
                } else {
                    // Bundle exists but not in direct list - it's a dependency bundle
                    bundledPackages.push(pkg);
                    additionalBundles.add(bundleName);
                }
            } else {
                ctanPackages.push(pkg);
            }
        }

        return { bundledPackages, ctanPackages, additionalBundles: [...additionalBundles] };
    }

    /**
     * Load a bundle by name.
     * @param {string} bundleName - Bundle name
     * @returns {Promise<ArrayBuffer|SharedArrayBuffer>} Bundle data
     */
    async loadBundle(bundleName) {
        // Check memory cache
        if (this.bundleCache.has(bundleName)) {
            return this.bundleCache.get(bundleName);
        }

        // Check filesystem cache
        const cached = await getBundleFromCache(bundleName);
        if (cached) {
            this.onLog(`  From cache: ${bundleName}`);
            this.bundleCache.set(bundleName, cached);
            this.cacheHitCount++;
            return cached;
        }

        // Fetch from server
        const url = `${this.bundleBase}/${bundleName}.data.gz`;
        this.onLog(`  Fetching: ${bundleName}`);

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load ${bundleName}: ${response.status}`);

        const compressed = await response.arrayBuffer();
        this.bytesDownloaded += compressed.byteLength;

        // Check if response was Brotli-compressed (browser already decompressed)
        const contentEncoding = response.headers.get('Content-Encoding');
        const format = contentEncoding === 'br' ? 'none' : 'gzip';
        const decompressed = await decompress(compressed, format);
        this.bundleCache.set(bundleName, decompressed);

        // Save to cache in background
        saveBundleToCache(bundleName, decompressed);

        return decompressed;
    }

    /**
     * Load multiple bundles in parallel.
     * @param {string[]} bundleNames - Bundle names
     * @returns {Promise<Object<string, ArrayBuffer|SharedArrayBuffer>>} Map of bundle data
     */
    async loadBundles(bundleNames) {
        const bundleData = {};
        await Promise.all(bundleNames.map(async (name) => {
            try {
                bundleData[name] = await this.loadBundle(name);
            } catch (e) {
                this.onLog(`Failed to load bundle ${name}: ${e.message}`);
            }
        }));
        return bundleData;
    }

    /**
     * Get bundle loading statistics.
     * @returns {{bytesDownloaded: number, cacheHits: number, bundlesCached: number}}
     */
    getStats() {
        return {
            bytesDownloaded: this.bytesDownloaded,
            cacheHits: this.cacheHitCount,
            bundlesCached: this.bundleCache.size,
        };
    }

    /**
     * Clear in-memory bundle cache to free RAM. Filesystem cache is preserved.
     */
    clearCache() {
        this.bundleCache.clear();
        this.onLog('Bundle memory cache cleared');
    }


    /**
     * Preload all required bundles for an engine.
     * @param {string} [engine] - Engine name
     * @returns {Promise<void>}
     */
    async preloadEngine(engine = 'pdflatex') {
        await this.loadBundleDeps();
        const engineDeps = this.bundleDeps?.engines?.[engine];
        if (!engineDeps?.required) return;

        this.onLog(`Preloading ${engine} bundles...`);

        await this.loadBundles(engineDeps.required);
        this.onLog(`Preload complete: ${engineDeps.required.length} bundles loaded`);
    }
}

/**
 * Detect the appropriate engine from LaTeX source.
 * @param {string} source - LaTeX source
 * @returns {'pdflatex'|'xelatex'} Detected engine
 */
export function detectEngine(source) {
    // XeLaTeX indicators
    if (source.includes('\\usepackage{fontspec}') ||
        source.includes('\\usepackage{unicode-math}') ||
        source.includes('\\setmainfont') ||
        source.includes('\\setsansfont') ||
        source.includes('\\setmonofont')) {
        return 'xelatex';
    }

    // pdfLaTeX is default
    return 'pdflatex';
}

/**
 * Extract preamble from LaTeX source (everything before \begin{document}).
 * @param {string} source - LaTeX source
 * @returns {string} Preamble content
 */
export function extractPreamble(source) {
    const beginDocIdx = source.indexOf('\\begin{document}');
    if (beginDocIdx === -1) return '';
    return source.substring(0, beginDocIdx);
}

// Re-export hashPreamble from centralized hash module (BLAKE3-WASM)
export { hashPreamble } from './hash.js';
