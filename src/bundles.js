/**
 * @module @siglum/engine/bundles
 * Bundle loading and package resolution for LaTeX compilation.
 */

import { normalizeProjectPath } from './project-paths.js';
import { validPackageName } from './texlive.js';

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

const MAX_FILE_PREFETCH_ARCHIVES = 6;
const MAX_FILE_PREFETCH_BYTES = 32 * 1024;

function appendFilePrefetch(packages, plans) {
    const known = new Set(packages);
    let count = 0;
    let bytes = 0;
    for (const plan of plans) {
        if (!Array.isArray(plan) || plan.length > MAX_FILE_PREFETCH_ARCHIVES || plan.some(entry =>
            !Array.isArray(entry) || typeof entry[0] !== 'string' || !validPackageName(entry[0])
            || !Number.isSafeInteger(entry[1]) || entry[1] <= 0 || entry[1] > MAX_FILE_PREFETCH_BYTES
        )) continue;

        // Exact-file plans list canonical TeX Live archives and their measured
        // compressed sizes. Admit a whole plan to keep optional features from
        // loading without their transitive dependencies.
        const missing = new Map(plan.filter(([name]) => !known.has(name)));
        const size = [...missing.values()].reduce((sum, value) => sum + value, 0);
        if (count + missing.size > MAX_FILE_PREFETCH_ARCHIVES || bytes + size > MAX_FILE_PREFETCH_BYTES) continue;
        for (const name of missing.keys()) {
            known.add(name);
            packages.push(name);
        }
        count += missing.size;
        bytes += size;
    }
}

// Optional lookahead for cheap runtime dependencies. This is a bounded hint,
// not an interpreter or a replacement for the exact missing-file resolver.
export function planArchiveDependencies(packages, metadata) {
    const graph = metadata?.archiveDependencies;
    if (!graph || metadata.archiveDependencySource?.format !== 1) return [];
    const known = new Set(packages);
    const visited = new Set();
    const queue = [...known];
    const planned = [];
    let bytes = 0;
    for (let i = 0; i < queue.length && visited.size < 256; i++) {
        const name = queue[i];
        if (visited.has(name) || !Object.hasOwn(graph, name)) continue;
        visited.add(name);
        const requires = graph[name]?.requires;
        if (!Array.isArray(requires)) continue;
        for (const dep of requires) {
            if (typeof dep !== 'string' || !validPackageName(dep) || !Object.hasOwn(graph, dep)) continue;
            if (known.has(dep)) { if (!visited.has(dep)) queue.push(dep); continue; }
            const size = graph[dep]?.bytes;
            if (!Number.isSafeInteger(size) || size <= 0 || size > 32 * 1024
                || planned.length >= 12 || bytes + size > 128 * 1024) continue;
            known.add(dep);
            planned.push(dep);
            queue.push(dep);
            bytes += size;
        }
    }
    return planned;
}

const KOMA_EXTENDED_SIZES = new Set([8, 9, 14, 17, 20]);

export function getKomaExtendedSize(source) {
    const declaration = source.match(/^[ \t]*\\documentclass\s*(?:\[([^\]]*)\]\s*)?\{([^{}]+)\}/m);
    const className = declaration?.[2].trim();
    if (!declaration?.[1] || !/^(?:scrartcl|scrbook|scrreprt|scrlttr2)$/.test(className)) return null;

    // Follow the last explicit size option. Ignore complex option expressions.
    const options = declaration[1]
        .replace(/(^|[^\\])%[^\r\n]*/g, '$1')
        .replace(/(^|,)\s*fontsize\s*=\s*\{\s*(\d+(?:\.0+)?)\s*(pt)?\s*\}(?=\s*(?:,|$))/g, '$1fontsize=$2$3');
    if (/[\\{}]/.test(options)) return null;
    const lastSize = options.split(',').map(option => option.trim())
        .reverse().find(option => /^fontsize\s*=|^\d+pt$/.test(option));
    const requested = lastSize?.match(/^(?:fontsize\s*=\s*(\d+(?:\.0+)?)\s*(?:pt)?|(\d+)pt)$/);
    const size = Number(requested?.[1] ?? requested?.[2]);
    return KOMA_EXTENDED_SIZES.has(size) ? { className, size } : null;
}

// Decompression using native CompressionStream
// Returns regular ArrayBuffer - SharedArrayBuffer causes memory leaks due to V8 GC issues
// (SABs sent to workers become "strong roots" that persist even after worker termination)
async function decompress(compressed, format = 'gzip') {
    // If format is 'none', return as-is (already decompressed by browser)
    if (format === 'none') {
        return compressed;
    }

    const ds = new DecompressionStream(format);
    const blob = new Blob([compressed]);
    const stream = blob.stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
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
        this.cachePrefix = (this.bundleBase.match(/\/releases\/(tl2026-[a-f0-9]{16})(?:\/|$)/)?.[1] || 'tl2026-r1') + '-';
        this.bundleCache = new Map();  // In-memory bundle cache
        this.fileManifest = null;
        this.packageMap = null;
        this.sourceCommands = new Map();
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
                getManifestFromCache(this.cachePrefix + 'file-manifest'),
                getManifestFromCache(this.cachePrefix + 'bundles'),
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
                saveManifestToCache(this.cachePrefix + 'file-manifest', this.fileManifest),
                saveManifestToCache(this.cachePrefix + 'bundles', bundlesData),
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
        this.packageMap = { ...bundlesData.packages };
        // Old manifests can omit bundled styles/classes from their package map.
        // Infer only unambiguous file ownership; explicit metadata wins.
        const inferred = new Map();
        for (const [path, info] of Object.entries(this.fileManifest || {})) {
            const match = /\/([^/]+)\.(?:sty|cls)$/.exec(path);
            if (!match || !this.bundleRegistry.has(info.bundle)) continue;
            const name = match[1];
            if (Object.hasOwn(this.packageMap, name)) continue;
            if (!inferred.has(name)) inferred.set(name, info.bundle);
            else if (inferred.get(name) !== info.bundle) inferred.set(name, null);
        }
        for (const [name, bundle] of inferred) if (bundle) this.packageMap[name] = bundle;
        this.sourceCommands = new Map(Object.entries(bundlesData.sourceCommands || {}));
        // Extract bundle deps (engines, bundle requires, deferred)
        this.bundleDeps = {
            engines: bundlesData.engines || {},
            bundles: {},
            deferred: bundlesData.deferred || [],
            nativeResources: bundlesData.nativeResources || [],
        };
        // Build bundle dependency map from bundlesData.bundles
        for (const [name, info] of Object.entries(bundlesData.bundles || {})) {
            if (info.requires && info.requires.length > 0) {
                this.bundleDeps.bundles[name] = { requires: info.requires };
            }
        }
    }

    _addSourceCommandPackages(source, packages) {
        if (![...this.sourceCommands.keys()].some(command => source.includes('\\' + command))) return;

        // Consume comments and escaped control symbols before looking up commands.
        for (const [, command] of source.matchAll(/\\([A-Za-z@]+|[^\r\n])|%[^\r\n]*/g)) {
            const required = this.sourceCommands.get(command);
            if (Array.isArray(required)) {
                for (const pkg of required) packages.add(pkg);
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
                const packageDeps = await getManifestFromCache(this.cachePrefix + 'package-deps');
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
                        await saveManifestToCache(this.cachePrefix + 'package-deps', this.packageDeps);
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

        this._addSourceCommandPackages(source, packages);

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
     * @param {string} [mainFile] - Main source path from the virtual project root
     * @param {string[]} [plannedBundles] - Bundles already selected from the main source
     * @returns {{ bundledPackages: string[], ctanPackages: string[], additionalBundles: string[] }}
     */
    prescanForCtanPackages(source, engine = 'pdflatex', additionalFiles = {}, mainFile = 'document.tex', plannedBundles = this.checkPackages(source, engine).bundles) {
        const packages = new Set();
        const extensions = new Map();
        const mainPath = normalizeProjectPath(mainFile);
        const directory = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/') + 1) : '';
        const localFiles = new Set(Object.keys(additionalFiles).map(normalizeProjectPath));
        const filePrefetch = this.packageDeps?.filePrefetch;
        const exactPlans = new Map();
        const isLocalFile = (pkg, extension) => {
            try {
                const path = (pkg.startsWith('/') ? pkg : directory + pkg) + extension;
                return localFiles.has(normalizeProjectPath(path));
            } catch { return false; }
        };
        const addPackage = (pkg, extension, text, offset) => {
            packages.add(pkg);
            if (!extensions.has(pkg)) extensions.set(pkg, new Set());
            extensions.get(pkg).add(extension);
            if (!filePrefetch) return;
            const filename = pkg + extension;
            if (!Object.hasOwn(filePrefetch, filename) || exactPlans.has(filename)
                || isLocalFile(pkg, extension)) return;
            const linePrefix = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
            // A commented or escaped command may still be part of the legacy
            // hint scan, but it must not activate additional exact-file plans.
            if (/(^|[^\\])(?:\\\\)*%/.test(linePrefix) || (linePrefix.match(/\\+$/)?.[0].length ?? 0) % 2) return;
            exactPlans.set(filename, filePrefetch[filename]);
        };
        const isLocal = (pkg) => [...(extensions.get(pkg) || ['.sty'])].every(extension => isLocalFile(pkg, extension));

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
                for (const pkg of extractPackages(match[1])) addPackage(pkg, '.sty', text, match.index);
            }

            // \RequirePackage[options]{pkg} and \RequirePackageWithOptions{pkg}
            const requireRegex = /\\RequirePackage(?:WithOptions)?(?:\[[^\]]*\])?\{([^}]+)\}/g;
            while ((match = requireRegex.exec(text)) !== null) {
                for (const pkg of extractPackages(match[1])) addPackage(pkg, '.sty', text, match.index);
            }

            // \documentclass[options]{class}
            const docclassMatch = text.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/);
            if (docclassMatch) {
                addPackage(docclassMatch[1], '.cls', text, docclassMatch.index);
            }

            // \LoadClass[options]{class} and \LoadClassWithOptions{class}
            const loadClassRegex = /\\LoadClass(?:WithOptions)?(?:\[[^\]]*\])?\{([^}]+)\}/g;
            while ((match = loadClassRegex.exec(text)) !== null) {
                addPackage(match[1].trim(), '.cls', text, match.index);
            }

            this._addSourceCommandPackages(text, packages);
        };

        // Scan main source
        scanSource(source);
        const komaSize = getKomaExtendedSize(source);
        if (komaSize) {
            const { className, size } = komaSize;
            // KOMA-Script can silently calculate different sizes if size<N>.clo is absent.
            // Its own class and size files must keep their normal precedence.
            const localOverrides = [className + '.cls', 'scrsize' + size + '.clo', 'scrsize' + size + 'pt.clo', 'size' + size + '.clo'];
            if (!localOverrides.some(file => localFiles.has(file) || localFiles.has(directory + file))) {
                addPackage('extsizes', '.sty');
            }
        }

        // Local styles/classes can declare their own external dependencies.
        const texFiles = Object.entries(additionalFiles).filter(([f]) => /\.(tex|sty|cls|clo|def|cfg)$/i.test(f));
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
            if (visited.has(pkg) || isLocal(pkg)) return;
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

        for (const dep of this.planArchivePrefetch([...expanded].filter(pkg => !isLocal(pkg)))) expanded.add(dep);
        const directBundles = new Set(plannedBundles);
        const externalPackages = [...expanded].filter(pkg => !isLocal(pkg));
        const additionalBundles = this.resolveBundles(externalPackages, engine)
            .filter(bundle => !directBundles.has(bundle));

        const bundledPackages = [];
        const ctanPackages = [];

        for (const pkg of externalPackages) {
            const bundleName = this.packageMap?.[pkg];
            if (bundleName && this.bundleExists(bundleName)) {
                bundledPackages.push(pkg);
            } else {
                ctanPackages.push(pkg);
            }
        }
        if (exactPlans.size) appendFilePrefetch(ctanPackages, exactPlans.values());

        return { bundledPackages, ctanPackages, additionalBundles };
    }

    planArchivePrefetch(packages) {
        return planArchiveDependencies(packages, this.packageDeps);
    }

    /**
     * Load a bundle by name.
     * @param {string} bundleName - Bundle name
     * @returns {Promise<ArrayBuffer>} Bundle data
     */
    async loadBundle(bundleName) {
        // Check memory cache
        if (this.bundleCache.has(bundleName)) {
            return this.bundleCache.get(bundleName);
        }

        // Check filesystem cache
        const cached = await getBundleFromCache(this.cachePrefix + bundleName);
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
        // A worker may return a PDF and close immediately after this request.
        await saveBundleToCache(this.cachePrefix + bundleName, decompressed);
        this.bundleCache.set(bundleName, decompressed);

        return decompressed;
    }

    /**
     * Load multiple bundles in parallel.
     * @param {string[]} bundleNames - Bundle names
     * @returns {Promise<Object<string, ArrayBuffer>>} Map of bundle data
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
 * Extract fontspec font *family names* requested by name in the source.
 * These are not caught by the \usepackage pre-scan, yet each needs its TeX Live
 * font package fetched so fontconfig can resolve the name at compile time.
 *
 * Handles: \setmainfont \setsansfont \setmonofont \setmathfont \setromanfont
 * \fontspec, and \newfontface/\newfontfamily (which take a control sequence
 * before the name). Names that are actually file references (containing a path
 * separator or a font extension) are skipped — those resolve via kpathsea.
 *
 * @param {string} source - Main LaTeX source
 * @param {Object} [additionalFiles] - Optional map of filename → content
 * @returns {string[]} Unique font family names
 */
export function extractFontNames(source, additionalFiles = {}) {
    const names = new Set();

    // \setmainfont[opts]{Name}, \fontspec[opts]{Name}, etc. The name is the
    // first brace group, optionally preceded by a bracket option group.
    const directRegex =
        /\\(?:setmainfont|setsansfont|setmonofont|setmathfont|setromanfont|fontspec)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

    // \newfontface\Cmd[opts]{Name} / \newfontfamily[opts]\Cmd{Name}: a control
    // sequence sits between the macro and the name.
    const newFontRegex =
        /\\newfontf(?:ace|amily)\s*(?:\[[^\]]*\])?\s*\\[A-Za-z@]+\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

    const looksLikeFile = (n) => /[\\/]/.test(n) || /\.(otf|ttf|ttc|pfb|pfa)$/i.test(n);

    const scan = (text) => {
        let m;
        for (const re of [directRegex, newFontRegex]) {
            re.lastIndex = 0;
            while ((m = re.exec(text)) !== null) {
                const name = m[1].trim();
                if (name && !looksLikeFile(name)) names.add(name);
            }
        }
    };

    scan(source);

    const texFiles = Object.entries(additionalFiles).filter(([f]) => f.endsWith('.tex'));
    if (texFiles.length > 0) {
        const decoder = new TextDecoder();
        for (const [, content] of texFiles) {
            scan(typeof content === 'string' ? content : decoder.decode(content));
        }
    }

    return [...names];
}

/**
 * Extract preamble from LaTeX source (everything before \begin{document}).
 * @param {string} source - LaTeX source
 * @returns {string} Preamble content
 */
export function extractPreamble(source) {
    let depth = 0;
    for (let i = 0; i < source.length;) {
        const char = source[i];
        if (char === '%') {
            const newline = source.indexOf('\n', i);
            if (newline < 0) return '';
            i = newline + 1;
            continue;
        }
        if (char === '\\') {
            const command = /^[A-Za-z@]+/.exec(source.slice(i + 1));
            if (!command) { i += 2; continue; }
            const name = command[0];
            // This is an optimization boundary, not a TeX interpreter. Decline
            // uncertain tokenization/conditional or preamble-environment cases.
            if (name === 'catcode' || (depth === 0 && name.startsWith('if'))) return '';
            if (depth === 0 && name === 'begin') {
                if (/^\\begin\s*\{document\}/.test(source.slice(i))) return source.slice(0, i);
                return '';
            }
            i += name.length + 1;
            continue;
        }
        if (char === '{') depth++;
        else if (char === '}' && --depth < 0) return '';
        i++;
    }
    return '';
}

// Re-export hashPreamble from centralized hash module (BLAKE3-WASM)
export { hashPreamble } from './hash.js';
