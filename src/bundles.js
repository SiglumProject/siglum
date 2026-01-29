// Bundle loading and package resolution module

import {
    getBundleFromOPFS,
    saveBundleToOPFS,
    getManifestFromOPFS,
    saveManifestToOPFS,
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

export class BundleManager {
    constructor(options = {}) {
        this.bundleBase = options.bundleBase || 'packages/bundles';
        this.bundleCache = new Map();  // Legacy: blob cache (for fallback)
        this.extractedBundles = new Set();  // Track which bundles are extracted to OPFS
        this.fileManifest = null;
        this.packageMap = null;
        this.bundleDeps = null;
        this.packageDeps = null;
        this.bundleRegistry = null;
        this.bytesDownloaded = 0;
        this.cacheHitCount = 0;
        this.useOPFSExtraction = false;  // DISABLED - worker reading from OPFS on every compile is slower than blob transfer
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

    async loadManifest() {
        if (this.fileManifest) return this.fileManifest;

        // Check OPFS cache first
        const cachedVersion = await getManifestVersion();
        if (cachedVersion === MANIFEST_CACHE_VERSION) {
            const [manifest, bundlesData] = await Promise.all([
                getManifestFromOPFS('file-manifest'),
                getManifestFromOPFS('bundles'),
            ]);

            if (manifest && bundlesData) {
                this.onLog('Manifests loaded from OPFS cache');
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

        // Save to OPFS (await to ensure cache is populated)
        try {
            await Promise.all([
                saveManifestToOPFS('file-manifest', this.fileManifest),
                saveManifestToOPFS('bundles', bundlesData),
                saveManifestVersion(MANIFEST_CACHE_VERSION),
            ]);
            this.onLog('Manifests saved to OPFS cache');
        } catch (e) {
            // OPFS save failed, continue anyway
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
                const packageDeps = await getManifestFromOPFS('package-deps');
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
                        await saveManifestToOPFS('package-deps', this.packageDeps);
                    } catch (e) {
                        // OPFS save failed, continue anyway
                    }
                }
            } catch (e) {
                // package-deps is optional
            }
        }

        return this.bundleDeps;
    }

    bundleExists(bundleName) {
        return this.bundleRegistry?.has(bundleName) ?? false;
    }

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
     * Ensure a bundle is ready in OPFS for worker to read
     * Phase 1: Saves blob to OPFS (worker reads blob)
     * Phase 2 (future): Extract individual files (worker reads files lazily)
     */
    async ensureBundleExtracted(bundleName) {
        // Already handled this session?
        if (this.extractedBundles.has(bundleName)) {
            return { bundleName, extracted: true, cached: true };
        }

        // Check OPFS for existing bundle blob
        const existingBlob = await getBundleFromOPFS(bundleName);
        if (existingBlob) {
            this.onLog(`  OPFS ready: ${bundleName}`);
            this.extractedBundles.add(bundleName);
            this.cacheHitCount++;
            return { bundleName, extracted: true, cached: true };
        }

        // Need to fetch and save to OPFS
        this.onLog(`  Fetching for OPFS: ${bundleName}...`);
        this.onProgress('loading', `Loading ${bundleName}...`);

        // Fetch bundle blob
        const url = `${this.bundleBase}/${bundleName}.data.gz`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load ${bundleName}: ${response.status}`);

        const compressed = await response.arrayBuffer();
        this.bytesDownloaded += compressed.byteLength;

        // Decompress
        const contentEncoding = response.headers.get('Content-Encoding');
        const format = contentEncoding === 'br' ? 'none' : 'gzip';
        const decompressed = await decompress(compressed, format);

        // Save to OPFS for worker to read
        const saved = await saveBundleToOPFS(bundleName, decompressed);

        this.extractedBundles.add(bundleName);
        if (saved) {
            this.onLog(`  Saved to storage: ${bundleName} (${(decompressed.byteLength / 1024 / 1024).toFixed(1)}MB)`);
        } else {
            this.onLog(`  WARNING: Failed to save ${bundleName} to storage!`);
        }
        return { bundleName, extracted: true, cached: false };

        // Note: decompressed blob is now eligible for GC - we don't keep it in memory!
    }

    /**
     * Load bundle blob (legacy approach - for fallback)
     * Returns the full blob in memory
     */
    async loadBundle(bundleName) {
        // Check memory cache
        if (this.bundleCache.has(bundleName)) {
            return this.bundleCache.get(bundleName);
        }

        // Check OPFS blob cache (legacy)
        const cached = await getBundleFromOPFS(bundleName);
        if (cached) {
            this.onLog(`  From OPFS: ${bundleName}`);
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

        // Save to OPFS in background
        saveBundleToOPFS(bundleName, decompressed);

        return decompressed;
    }

    /**
     * Ensure multiple bundles are extracted to OPFS
     * Returns list of bundle names that are ready
     */
    async ensureBundlesExtracted(bundleNames) {
        const results = await Promise.all(
            bundleNames.map(name => this.ensureBundleExtracted(name).catch(e => {
                this.onLog(`Failed to extract ${name}: ${e.message}`);
                return null;
            }))
        );

        return results
            .filter(r => r !== null)
            .map(r => r.bundleName);
    }

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

    getStats() {
        return {
            bytesDownloaded: this.bytesDownloaded,
            cacheHits: this.cacheHitCount,
            bundlesCached: this.bundleCache.size,
        };
    }

    /**
     * Clear in-memory bundle cache to free RAM. OPFS cache is preserved.
     */
    clearCache() {
        this.bundleCache.clear();
        this.extractedBundles.clear();
        this.onLog('Bundle memory cache cleared');
    }

    /**
     * Check if OPFS extraction is available
     */
    isOPFSAvailable() {
        return typeof navigator?.storage?.getDirectory === 'function';
    }

    // Preload all required bundles for an engine (call during init)
    // Uses OPFS extraction when available, falls back to blob loading
    async preloadEngine(engine = 'pdflatex') {
        await this.loadBundleDeps();
        const engineDeps = this.bundleDeps?.engines?.[engine];
        if (!engineDeps?.required) return;

        this.onLog(`Preloading ${engine} bundles...`);

        if (this.useOPFSExtraction && this.isOPFSAvailable()) {
            // New approach: extract to OPFS (no blobs in memory)
            await this.ensureBundlesExtracted(engineDeps.required);
            this.onLog(`Preload complete: ${engineDeps.required.length} bundles extracted to OPFS`);
        } else {
            // Legacy approach: load blobs into memory
            await this.loadBundles(engineDeps.required);
            this.onLog(`Preload complete: ${engineDeps.required.length} bundles in memory`);
        }
    }
}

// Engine detection
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

// Preamble extraction for format generation
export function extractPreamble(source) {
    const beginDocIdx = source.indexOf('\\begin{document}');
    if (beginDocIdx === -1) return '';
    return source.substring(0, beginDocIdx);
}

// Re-export hashPreamble from centralized hash module (BLAKE3-WASM)
export { hashPreamble } from './hash.js';
