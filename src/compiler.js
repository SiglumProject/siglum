/**
 * @module @siglum/engine/compiler
 * Main SiglumCompiler class - orchestrates LaTeX compilation in the browser.
 */

import { BundleManager, detectEngine, extractPreamble, hashPreamble } from './bundles.js';

/**
 * @typedef {Object} SiglumCompilerOptions
 * @property {string} [bundlesUrl] - URL to bundles directory
 * @property {string} [wasmUrl] - URL to busytex.wasm
 * @property {string} [jsUrl] - URL to busytex.js (derived from wasmUrl if not provided)
 * @property {string|null} [workerUrl] - URL to worker.js (required for bundlers like Vite/Webpack)
 * @property {string} [ctanProxyUrl] - CTAN proxy URL
 * @property {string} [xzwasmUrl] - XZ decompression WASM URL
 * @property {(msg: string) => void} [onLog] - Logging callback
 * @property {(stage: string, detail: string) => void} [onProgress] - Progress callback
 * @property {boolean} [enableCtan] - Enable CTAN fetching (default: true if ctanProxyUrl provided)
 * @property {boolean} [enableLazyFS] - Enable lazy filesystem (default: true)
 * @property {boolean} [enableDocCache] - Enable document cache (default: true)
 * @property {number} [maxRetries] - Max fetch retries per compile (default: 15)
 * @property {boolean} [verbose] - Log TeX stdout (default: false)
 * @property {string[]|Object<string, string[]>} [eagerBundles] - Bundles to load eagerly
 */

/**
 * @typedef {Object} CompileOptions
 * @property {string} [engine] - 'pdflatex', 'xelatex', or 'lualatex'
 * @property {boolean} [useCache] - Use document cache
 * @property {Object<string, string|Uint8Array>} [additionalFiles] - Additional files for compilation
 */

/**
 * @typedef {Object} CompileResult
 * @property {boolean} success - Whether compilation succeeded
 * @property {Uint8Array} [pdf] - Compiled PDF bytes
 * @property {boolean} [pdfIsShared] - True if PDF is in SharedArrayBuffer
 * @property {Object|null} [syncTexData] - SyncTeX data for source mapping
 * @property {Object} [stats] - Compilation statistics
 * @property {string} [log] - TeX compilation log
 * @property {string} [error] - Error message if failed
 * @property {number} [exitCode] - TeX exit code if failed
 * @property {boolean} [cached] - True if result was from cache
 */
import { CTANFetcher } from './ctan.js';

// Module-level tracking to prevent multiple workers across all instances
let _globalActiveWorker = null;
let _globalWorkerId = 0;
import { fileSystem } from '@siglum/filesystem';
import {
    getAuxCache,
    saveAuxCache,
    getCachedPdf,
    saveCachedPdf,
    hashDocument,
    getFmtPath,
    clearCTANCache,
    getCompiledWasmModule,
    saveWasmBytes,
    saveWasmMemorySnapshot,
} from './storage.js';

// Ensure fmt-cache mount exists
let fmtCacheMounted = false;
async function ensureFmtCacheMount() {
    if (fmtCacheMounted) return true;
    try {
        await fileSystem.mountAuto('/fmt-cache');
        fmtCacheMounted = true;
        return true;
    } catch (e) {
        console.warn('Failed to mount fmt-cache:', e);
        return false;
    }
}

/**
 * Browser-based LaTeX compiler using WebAssembly.
 * Handles bundle loading, CTAN fetching, and compilation orchestration.
 */
export class SiglumCompiler {
    /**
     * @param {SiglumCompilerOptions} [options] - Compiler options
     */
    constructor(options = {}) {
        this.bundlesUrl = options.bundlesUrl || 'packages/bundles';
        this.wasmUrl = options.wasmUrl || 'busytex.wasm';
        this.jsUrl = options.jsUrl || null; // Derived from wasmUrl if not provided
        this.workerUrl = options.workerUrl || null; // Will use embedded worker if not provided
        this.ctanProxyUrl = options.ctanProxyUrl || null;
        this.xzwasmUrl = options.xzwasmUrl || './src/xzwasm.js';

        this.bundleManager = new BundleManager({
            bundleBase: this.bundlesUrl,
            onLog: (msg) => this._log(msg),
        });

        this.ctanFetcher = new CTANFetcher({
            proxyUrl: this.ctanProxyUrl,
            xzwasmUrl: this.xzwasmUrl,
            onLog: (msg) => this._log(msg),
        });

        this.worker = null;
        this.workerReady = false;
        this.wasmModule = null;
        this._initWorkerPromise = null;
        this.pendingCompile = null;
        this.formatGenerationPromise = null;

        this.onLog = options.onLog || (() => {});
        this.onProgress = options.onProgress || (() => {});

        // Options
        // Enable CTAN if explicitly set, otherwise default to true only if ctanProxyUrl is provided
        this.enableCtan = options.enableCtan ?? (this.ctanProxyUrl !== null);
        this.enableLazyFS = options.enableLazyFS !== false;
        this.enableDocCache = options.enableDocCache !== false;
        this.maxRetries = options.maxRetries ?? 15;  // Max CTAN/bundle fetch retries per compile
        this.verbose = options.verbose ?? false;  // Log TeX stdout (adds ~4000 postMessage calls)

        // Eager bundle loading - bundles to load immediately instead of deferring
        // Can be an array (applies to all engines) or object keyed by engine
        // Example: ['cm-super'] or { pdflatex: ['cm-super'], xelatex: [] }
        this.eagerBundles = options.eagerBundles || {};

        // Range request coalescing - batch nearby requests to reduce HTTP overhead
        this._pendingRangeRequests = new Map(); // bundleName -> [{requestId, start, end}]
        this._rangeRequestTimer = null;
        this._rangeRequestDebounceMs = 10; // Wait 10ms to batch requests
        this._rangeCoalesceGapBytes = 64 * 1024; // Coalesce ranges within 64KB of each other
    }

    _log(msg) {
        this.onLog(msg);
    }

    /**
     * Get eager bundles for a specific engine.
     * Eager bundles are loaded immediately instead of being deferred.
     * @param {string} engine - The engine (pdflatex, xelatex, lualatex)
     * @returns {string[]} List of bundle names to load eagerly
     */
    getEagerBundles(engine) {
        if (Array.isArray(this.eagerBundles)) {
            // Global list applies to all engines
            return this.eagerBundles;
        }
        // Per-engine configuration
        return this.eagerBundles[engine] || [];
    }

    /**
     * Preload bundles into memory cache.
     * Call this to eagerly load bundles before compilation.
     * Useful for loading large deferred bundles (like cm-super) in advance.
     *
     * @example
     * // Preload cm-super before first compile
     * await compiler.preloadBundles(['cm-super']);
     *
     * @param {string[]} bundleNames - Bundles to preload
     * @returns {Promise<{loaded: string[], failed: string[]}>}
     */
    async preloadBundles(bundleNames) {
        await this.bundleManager.loadManifest();

        const loaded = [];
        const failed = [];

        // Load bundles in parallel
        const promises = bundleNames.map(async (bundleName) => {
            try {
                if (!this.bundleManager.bundleExists(bundleName)) {
                    this._log(`Preload: bundle ${bundleName} does not exist`);
                    failed.push(bundleName);
                    return;
                }

                const data = await this.bundleManager.loadBundle(bundleName);
                if (data) {
                    this._log(`Preloaded bundle: ${bundleName} (${(data.byteLength / 1024 / 1024).toFixed(1)}MB)`);
                    loaded.push(bundleName);
                } else {
                    failed.push(bundleName);
                }
            } catch (e) {
                this._log(`Preload failed for ${bundleName}: ${e.message}`);
                failed.push(bundleName);
            }
        });

        await Promise.all(promises);
        return { loaded, failed };
    }

    /**
     * Pre-warm the compiler in the background.
     * Call this early (e.g., on page load) to eliminate cold start latency.
     * The promise resolves when initialization is complete, but you don't need to await it.
     *
     * @example
     * // On app mount, before user starts typing
     * const compiler = new BusyTeXCompiler(options);
     * compiler.prewarm(); // Fire and forget - init happens in background
     *
     * // Later, when user wants to compile:
     * await compiler.compile(source); // Already warmed up!
     *
     * @returns {Promise<void>} Resolves when initialization is complete
     */
    prewarm() {
        // Return existing init promise if already warming/initialized
        if (this._prewarmPromise) {
            return this._prewarmPromise;
        }

        this._prewarmPromise = this.init().catch(e => {
            this._log('Prewarm failed: ' + e.message);
            // Reset so next prewarm/init can retry
            this._prewarmPromise = null;
            throw e;
        });

        return this._prewarmPromise;
    }

    /**
     * Check if compiler is ready (initialized and warmed up)
     * @returns {boolean}
     */
    isReady() {
        return this.workerReady && this.wasmModule !== undefined;
    }

    /**
     * Initialize the compiler. Loads WASM, manifests, and prepares the worker.
     * @returns {Promise<void>}
     */
    async init() {
        this._log('Initializing Siglum compiler...');

        // Load manifests + WASM in parallel
        await Promise.all([
            this._loadManifests(),
            this._loadWasm(),
        ]);

        // Worker init (required) + bundle preload (optional, don't fail if it errors)
        await Promise.all([
            this._initWorker(),
            this.bundleManager.preloadEngine('pdflatex').catch(e => {
                this._log('Bundle preload failed (will load on demand): ' + e.message);
            }),
        ]);

        this._log('Compiler initialized');
    }

    async _loadManifests() {
        await this.bundleManager.loadManifest();
        await this.bundleManager.loadBundleDeps();
    }

    async _loadWasm() {
        this._log('Loading WASM...');
        const startTime = performance.now();

        try {
            // Try loading cached compiled module first (skips fetch + compile)
            const cachedModule = await getCompiledWasmModule();
            if (cachedModule) {
                this.wasmModule = cachedModule;
                const elapsed = (performance.now() - startTime).toFixed(0);
                this._log('WASM loaded from cache in ' + elapsed + 'ms');
                return;
            }

            // Fetch WASM as bytes (not streaming compile - we need bytes for caching)
            const response = await fetch(this.wasmUrl);
            const wasmBytes = new Uint8Array(await response.arrayBuffer());
            const fetchElapsed = (performance.now() - startTime).toFixed(0);

            // Compile from bytes
            const compileStart = performance.now();
            this.wasmModule = await WebAssembly.compile(wasmBytes);
            const compileElapsed = (performance.now() - compileStart).toFixed(0);
            this._log(`WASM fetched in ${fetchElapsed}ms, compiled in ${compileElapsed}ms`);

            // Cache the bytes for future loads (Module can't be serialized to IndexedDB)
            saveWasmBytes(wasmBytes).catch(() => {});
        } catch (e) {
            this._log('WASM load failed: ' + e.message);
            throw e;
        }
    }

    async _initWorker() {
        if (this.worker) return;

        // Prevent race condition: if init is already in progress, wait for it
        if (this._initWorkerPromise) {
            return this._initWorkerPromise;
        }

        this._initWorkerPromise = this._doInitWorker();
        try {
            await this._initWorkerPromise;
        } finally {
            this._initWorkerPromise = null;
        }
    }

    async _doInitWorker() {
        // Check for existing global worker - prevents duplicates across instances
        if (_globalActiveWorker && _globalActiveWorker !== this.worker) {
            console.warn('[SiglumCompiler] WARNING: Another worker already exists! Terminating old worker.');
            _globalActiveWorker.terminate();
            _globalActiveWorker = null;
        }

        // Get worker code - use external URL or fetch from package
        let workerUrl = this.workerUrl;
        if (!workerUrl) {
            // Fetch worker.js and create blob URL
            const workerResponse = await fetch(new URL('./worker.js', import.meta.url));
            const workerCode = await workerResponse.text();
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            workerUrl = URL.createObjectURL(blob);
        }

        const workerId = ++_globalWorkerId;

        this.worker = new Worker(workerUrl);
        this.worker._workerId = workerId;
        _globalActiveWorker = this.worker;

        this.worker.onmessage = (e) => this._handleWorkerMessage(e);
        this.worker.onerror = (e) => this._handleWorkerError(e);

        // Get absolute URL for busytex.js - use jsUrl if provided, otherwise derive from wasmUrl
        const wasmUrlObj = new URL(this.wasmUrl, window.location.href);
        const busytexJsUrl = this.jsUrl
            ? new URL(this.jsUrl, window.location.href).href
            : new URL('busytex.js', wasmUrlObj.href).href;

        // NOTE: Memory snapshots are DISABLED - pdfTeX's internal globals cause assertion
        // failures when restored. Fast recompiles come from format caching (.fmt files).
        const memorySnapshot = null;

        // Send init message
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 30000);

            const originalHandler = this.worker.onmessage;
            this.worker.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    clearTimeout(timeout);
                    this.workerReady = true;
                    this.worker.onmessage = originalHandler;
                    this._log('Worker ready');
                    resolve();
                } else {
                    originalHandler(e);
                }
            };

            const initMsg = {
                type: 'init',
                wasmModule: this.wasmModule,
                busytexJsUrl,
                manifest: this.bundleManager.fileManifest,
                packageMapData: this.bundleManager.packageMap,
                bundleDepsData: this.bundleManager.bundleDeps,
                bundleRegistryData: this.bundleManager.bundleRegistry ? [...this.bundleManager.bundleRegistry] : [],
                verbose: this.verbose,
            };

            // Include memory snapshot if available (transfer for efficiency)
            if (memorySnapshot) {
                initMsg.memorySnapshot = memorySnapshot;
                this.worker.postMessage(initMsg, [memorySnapshot]);
            } else {
                this.worker.postMessage(initMsg);
            }
        });
    }

    _handleWorkerMessage(e) {
        const msg = e.data;

        switch (msg.type) {
            case 'log':
                this._log(msg.message);
                break;

            case 'progress':
                this.onProgress(msg.stage, msg.detail);
                break;

            case 'compile-response':
                if (this.pendingCompile) {
                    this.pendingCompile.resolve(msg);
                    this.pendingCompile = null;
                }
                break;

            case 'format-generate-response':
                if (this.pendingFormat) {
                    this.pendingFormat.resolve(msg);
                    this.pendingFormat = null;
                }
                break;

            case 'ctan-fetch-request':
                this._handleCtanFetchRequest(msg);
                break;

            case 'bundle-fetch-request':
                this._handleBundleFetchRequest(msg);
                break;

            case 'file-range-fetch-request':
                this._queueRangeRequest(msg);
                break;

            case 'memory-snapshot':
                // Worker sent memory snapshot after first successful compile - save to IndexedDB
                this._handleMemorySnapshot(msg).catch(e => {
                    this._log('Failed to save memory snapshot: ' + e.message);
                });
                break;

            default:
                // Log unhandled message types for debugging
                if (msg.type && !['log', 'progress', 'compile-response', 'format-generate-response'].includes(msg.type)) {
                    console.log('[Compiler] Unhandled message type:', msg.type);
                }
        }
    }

    _handleWorkerError(e) {
        this._log('Worker error: ' + e.message);
        if (this.pendingCompile) {
            this.pendingCompile.reject(new Error('Worker error: ' + e.message));
            this.pendingCompile = null;
        }
        this.workerReady = false;
        // Terminate the worker before clearing the reference to avoid memory leak
        if (this.worker) {
            this.worker.terminate();
            // Clear global reference if this is the active worker
            if (_globalActiveWorker === this.worker) {
                _globalActiveWorker = null;
            }
        }
        this.worker = null;
    }

    async _handleCtanFetchRequest(msg) {
        const { requestId, packageName, fileName, tlYear } = msg;

        try {
            // Look up the correct package for this file (e.g., bbm.sty → bbm-macros)
            let actualPackage = packageName;
            if (fileName) {
                const mappedPackage = await this.ctanFetcher.lookupPackageForFile(fileName);
                if (mappedPackage && mappedPackage !== packageName) {
                    this._log(`[CTAN-REQ] ${fileName} maps to package "${mappedPackage}" (not "${packageName}")`);
                    actualPackage = mappedPackage;
                }
            }

            const yearLabel = tlYear ? ` (TL${tlYear})` : '';
            this._log(`[CTAN-REQ] Worker requested package: ${actualPackage}${yearLabel}`);
            // Only fetch this specific package, not dependencies
            // Dependencies are resolved by the worker's retry loop - if a dependency
            // is missing, the worker will request it specifically
            const result = await this.ctanFetcher.fetchPackage(actualPackage, { tlYear });
            if (result) {
                this._log(`[CTAN-REQ] ${packageName}: got ${result.files?.size || 0} files`);
            }

            if (!result) {
                this.worker.postMessage({
                    type: 'ctan-fetch-response',
                    requestId,
                    packageName,
                    success: false,
                    error: 'Package not found',
                });
                return;
            }

            this.worker.postMessage({
                type: 'ctan-fetch-response',
                requestId,
                packageName,
                success: true,
                files: Object.fromEntries(result.files),
                dependencies: result.dependencies || [],
            });
        } catch (e) {
            this._log('CTAN fetch error: ' + e.message);
            this.worker.postMessage({
                type: 'ctan-fetch-response',
                requestId,
                packageName,
                success: false,
                error: e.message,
            });
        }
    }

    async _handleBundleFetchRequest(msg) {
        const { requestId, bundleName } = msg;

        try {
            this._log('Worker requested bundle: ' + bundleName);

            const bundleData = await this.bundleManager.loadBundle(bundleName);

            // SharedArrayBuffer: send directly (automatically shared, no transfer list)
            // ArrayBuffer: copy before transfer so original stays valid in cache
            const isShared = typeof SharedArrayBuffer !== 'undefined' && bundleData instanceof SharedArrayBuffer;
            if (isShared) {
                this.worker.postMessage({
                    type: 'bundle-fetch-response',
                    requestId,
                    bundleName,
                    success: true,
                    bundleData,
                });
            } else {
                const copy = bundleData.slice(0);
                this.worker.postMessage({
                    type: 'bundle-fetch-response',
                    requestId,
                    bundleName,
                    success: true,
                    bundleData: copy,
                }, [copy]);
            }
        } catch (e) {
            this._log('Bundle fetch error: ' + e.message);
            this.worker.postMessage({
                type: 'bundle-fetch-response',
                requestId,
                bundleName,
                success: false,
                error: e.message,
            });
        }
    }

    /**
     * Queue a range request for batching. Requests are coalesced and fetched
     * together to reduce HTTP overhead.
     */
    _queueRangeRequest(msg) {
        const { requestId, bundleName, start, end } = msg;

        // Add to pending queue for this bundle
        if (!this._pendingRangeRequests.has(bundleName)) {
            this._pendingRangeRequests.set(bundleName, []);
        }
        this._pendingRangeRequests.get(bundleName).push({ requestId, start, end });

        // Reset debounce timer
        if (this._rangeRequestTimer) {
            clearTimeout(this._rangeRequestTimer);
        }

        this._rangeRequestTimer = setTimeout(() => {
            this._processRangeRequestBatch().catch(e => {
                console.error('[Compiler] Range batch processing error:', e);
                this._log('Error processing range batch: ' + e.message);
            });
        }, this._rangeRequestDebounceMs);
    }

    /**
     * Process all pending range requests, coalescing nearby ranges.
     */
    async _processRangeRequestBatch() {
        this._rangeRequestTimer = null;

        // Process each bundle's requests
        for (const [bundleName, requests] of this._pendingRangeRequests.entries()) {
            if (requests.length === 0) continue;

            // Coalesce ranges
            const coalesced = this._coalesceRanges(requests);

            this._log(`Range coalescing: ${requests.length} requests -> ${coalesced.length} fetches for ${bundleName}`);

            // Fetch each coalesced range
            for (const group of coalesced) {
                await this._fetchCoalescedRange(bundleName, group);
            }
        }

        // Clear processed requests
        this._pendingRangeRequests.clear();
    }

    /**
     * Coalesce nearby ranges to reduce HTTP requests.
     * Returns groups of original requests that can be satisfied by a single fetch.
     */
    _coalesceRanges(requests) {
        if (requests.length === 0) return [];
        if (requests.length === 1) return [[requests[0]]];

        // Sort by start position
        const sorted = [...requests].sort((a, b) => a.start - b.start);

        const groups = [];
        let currentGroup = [sorted[0]];
        let groupEnd = sorted[0].end;

        for (let i = 1; i < sorted.length; i++) {
            const req = sorted[i];

            // If this range is within the gap threshold of the current group, merge
            if (req.start <= groupEnd + this._rangeCoalesceGapBytes) {
                currentGroup.push(req);
                groupEnd = Math.max(groupEnd, req.end);
            } else {
                // Start a new group
                groups.push(currentGroup);
                currentGroup = [req];
                groupEnd = req.end;
            }
        }

        groups.push(currentGroup);
        return groups;
    }

    /**
     * Fetch a coalesced range and distribute data to original requesters.
     */
    async _fetchCoalescedRange(bundleName, group) {
        // Calculate the overall range to fetch
        const fetchStart = Math.min(...group.map(r => r.start));
        const fetchEnd = Math.max(...group.map(r => r.end));

        try {
            const url = `${this.bundlesUrl}/${bundleName}.raw`;
            const response = await fetch(url, {
                headers: {
                    'Range': `bytes=${fetchStart}-${fetchEnd - 1}`,
                },
            });

            if (response.status !== 206 && response.status !== 200) {
                throw new Error(`Range request failed with status ${response.status}`);
            }

            const fullData = new Uint8Array(await response.arrayBuffer());
            this._log(`Fetched coalesced range [${fetchStart}:${fetchEnd}] = ${fullData.length} bytes`);

            // Distribute data to each original requester
            for (const req of group) {
                const offset = req.start - fetchStart;
                const length = req.end - req.start;
                const data = fullData.slice(offset, offset + length);

                this.worker.postMessage({
                    type: 'file-range-fetch-response',
                    requestId: req.requestId,
                    bundleName,
                    start: req.start,
                    end: req.end,
                    success: true,
                    data,
                }, [data.buffer]);
            }
        } catch (e) {
            this._log('Coalesced range fetch error: ' + e.message);

            // Send error to all requesters in this group
            for (const req of group) {
                this.worker.postMessage({
                    type: 'file-range-fetch-response',
                    requestId: req.requestId,
                    bundleName,
                    start: req.start,
                    end: req.end,
                    success: false,
                    error: e.message,
                });
            }
        }
    }

    async _handleMemorySnapshot(msg) {
        // Save memory snapshot to persistent storage for future instant restore
        const { snapshot, byteLength, isShared } = msg;
        if (!snapshot || byteLength === 0) {
            this._log('Memory snapshot is empty, skipping save');
            return;
        }

        // For SharedArrayBuffer: create a regular copy for IndexedDB (can't store SAB)
        // For transferred ArrayBuffer: wrap in Uint8Array view
        let snapshotArray;
        if (isShared) {
            // Copy from SharedArrayBuffer to regular ArrayBuffer for IndexedDB
            snapshotArray = new Uint8Array(byteLength);
            snapshotArray.set(new Uint8Array(snapshot));
            this._log(`Saving memory snapshot to cache (${(byteLength / 1024 / 1024).toFixed(1)}MB, from shared)...`);
        } else {
            snapshotArray = new Uint8Array(snapshot);
            this._log(`Saving memory snapshot to cache (${(byteLength / 1024 / 1024).toFixed(1)}MB)...`);
        }

        const success = await saveWasmMemorySnapshot(snapshotArray, {
            savedAt: Date.now(),
            byteLength,
        });

        if (success) {
            this._log('Memory snapshot saved');
        } else {
            this._log('Failed to save memory snapshot');
        }
    }

    /**
     * Compile LaTeX source to PDF.
     * @param {string} source - LaTeX source code
     * @param {CompileOptions} [options] - Compilation options
     * @returns {Promise<CompileResult>} Compilation result with PDF or error
     */
    async compile(source, options = {}) {
        // Wait for any pending format generation to complete before checking cache
        // This ensures the format is available in cache for the current compile
        if (this.formatGenerationPromise) {
            this._log('Waiting for format generation to complete...');
            await this.formatGenerationPromise.catch(() => {});
        }

        const engine = options.engine || detectEngine(source);
        const useCache = this.enableDocCache && options.useCache !== false;

        // Check document cache
        if (useCache) {
            const docHash = hashDocument(source);
            const cached = await getCachedPdf(docHash, engine);
            if (cached) {
                this._log('Using cached PDF');
                return {
                    success: true,
                    pdf: new Uint8Array(cached),
                    cached: true,
                };
            }
        }

        // Ensure worker is ready
        if (!this.workerReady) {
            await this._initWorker();
        }

        // Determine required bundles from direct \usepackage commands
        const { bundles } = this.bundleManager.checkPackages(source, engine);

        // Add eager bundles for this engine (these get loaded immediately instead of deferred)
        const eagerBundles = this.getEagerBundles(engine);

        // Pre-scan for CTAN packages and dependency bundles - batch fetch before compilation
        let depBundles = [];
        if (this.enableCtan) {
            const additionalFilesMap = options.additionalFiles || {};
            const { ctanPackages, additionalBundles } = this.bundleManager.prescanForCtanPackages(source, engine, additionalFilesMap);

            // Add bundles needed for package dependencies (not detected from direct \usepackage)
            if (additionalBundles && additionalBundles.length > 0) {
                depBundles = additionalBundles;
            }

            if (ctanPackages.length > 0) {
                this._log(`Pre-scan: ${ctanPackages.length} potential CTAN packages`);
                const prescanStart = performance.now();

                const { fetched, failed, skipped } = await this.ctanFetcher.batchFetchPackages(ctanPackages);

                const elapsed = (performance.now() - prescanStart).toFixed(0);
                if (fetched.length > 0 || skipped.length > 0) {
                    this._log(`Pre-fetch: ${fetched.length} new, ${skipped.length} cached, ${failed.length} not found (${elapsed}ms)`);
                }
            }
        }

        // Combine all bundles: direct packages + eager + dependency bundles
        const allBundles = [...new Set([...bundles, ...eagerBundles, ...depBundles])];

        // Log required bundles with optional extras
        const extras = [];
        if (eagerBundles.length > 0) extras.push('eager: ' + eagerBundles.join(', '));
        if (depBundles.length > 0) extras.push('deps: ' + depBundles.join(', '));
        if (extras.length > 0) {
            this._log('Required bundles: ' + bundles.join(', ') + ' (+ ' + extras.join(', ') + ')');
        } else {
            this._log('Required bundles: ' + bundles.join(', '));
        }

        // Prepare bundle data for worker (SharedArrayBuffer for zero-copy, or regular ArrayBuffer with transfer)
        this.onProgress('loading', 'Loading bundles...');

        let bundleData = {};
        let transferList = [];

        // Load bundle blobs
        const loadedBundles = await this.bundleManager.loadBundles(allBundles);
        let totalBytes = 0;
        let usingSharedArrayBuffer = false;

        for (const [name, data] of Object.entries(loadedBundles)) {
            if (data) {
                // Check if data is SharedArrayBuffer (zero-copy) or regular ArrayBuffer (needs transfer)
                const isShared = typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer;
                if (isShared) {
                    // SharedArrayBuffer: no copy needed, worker reads same memory
                    bundleData[name] = data;
                    usingSharedArrayBuffer = true;
                } else {
                    // Regular ArrayBuffer: copy for transfer (original stays in cache)
                    const copy = data.slice(0);
                    bundleData[name] = copy;
                    transferList.push(copy);
                }
                totalBytes += data.byteLength;
            }
        }
        if (usingSharedArrayBuffer) {
            this._log(`Sharing ${Object.keys(bundleData).length} bundles via SharedArrayBuffer (${(totalBytes/1024/1024).toFixed(1)}MB, zero-copy)`);
        } else {
            this._log(`Transferring ${Object.keys(bundleData).length} bundles (${(totalBytes/1024/1024).toFixed(1)}MB)`);
        }

        // Get CTAN files from memory cache (populated by previous fetches)
        const ctanFiles = this.ctanFetcher.getCachedFiles();
        const ctanFileCount = Object.keys(ctanFiles).length;
        if (ctanFileCount > 0) {
            this._log(`Passing ${ctanFileCount} cached CTAN files to worker`);
        }

        // Merge in any additional files provided by the user
        const additionalFiles = options.additionalFiles || {};
        for (const [filename, content] of Object.entries(additionalFiles)) {
            // Convert string content to Uint8Array
            const data = typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content;
            // Mount in current directory (will be found by TeX)
            ctanFiles['/' + filename] = data;
        }

        // Check for cached format (in-memory first, then filesystem)
        let cachedFormat = null;
        const preamble = extractPreamble(source);
        const preambleHash = hashPreamble(preamble);
        const fmtKey = preambleHash + '_' + engine;

        // Check in-memory cache first (fast path)
        if (this._fmtMemCache?.key === fmtKey && this._fmtMemCache?.data?.buffer?.byteLength > 0) {
            cachedFormat = { fmtName: fmtKey, fmtData: this._fmtMemCache.data };
            this._log('Using cached format (memory)');
        } else {
            // Fall back to filesystem cache - path is deterministic from fmtKey
            const fmtPath = '/' + getFmtPath(fmtKey);
            await ensureFmtCacheMount();
            const fmtData = await fileSystem.readBinary(fmtPath).catch(() => null);
            if (fmtData && fmtData.byteLength > 0) {
                // Cache in memory for subsequent compiles
                this._fmtMemCache = { key: fmtKey, data: fmtData.slice() };
                cachedFormat = { fmtName: fmtKey, fmtData: this._fmtMemCache.data };
                this._log('Using cached format (filesystem)');
            }
        }

        // Check for cached aux files (include format state in key to avoid mismatch)
        const auxCacheKey = cachedFormat ? preambleHash + '_fmt' : preambleHash;
        const auxCache = await getAuxCache(auxCacheKey);

        // Send compile request
        this.onProgress('compiling', 'Compiling...');
        const compileId = crypto.randomUUID();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingCompile) {
                    this.pendingCompile = null;
                    reject(new Error('Compilation timeout'));
                }
            }, 120000);

            this.pendingCompile = {
                resolve: async (result) => {
                    clearTimeout(timeout);

                    if (result.success) {
                        // Create Uint8Array view - works for both SharedArrayBuffer and ArrayBuffer
                        // Both are zero-copy views, just pointing to different backing memory
                        const pdfData = result.pdfData ? new Uint8Array(result.pdfData) : null;

                        // Cache the PDF (IndexedDB requires regular ArrayBuffer, not SharedArrayBuffer)
                        if (useCache && pdfData) {
                            const docHash = hashDocument(source);
                            const cacheBuffer = result.pdfDataIsShared
                                ? result.pdfData.slice(0)  // Copy SharedArrayBuffer to regular ArrayBuffer
                                : result.pdfData;          // Already regular ArrayBuffer
                            await saveCachedPdf(docHash, engine, cacheBuffer);
                        }

                        // Cache aux files (use same key that includes format state)
                        if (result.auxFilesToCache) {
                            await saveAuxCache(auxCacheKey, result.auxFilesToCache);
                        }

                        // Auto-generate format cache if no cached format was used
                        // Do this in background to not block the compile result
                        // Skip for xelatex - XeTeX can't dump formats with native fonts
                        if (!cachedFormat && preamble && engine !== 'xelatex') {
                            this.generateFormat(source, { engine }).then(async () => {
                                // Populate memory cache from the newly generated format
                                await ensureFmtCacheMount();
                                const data = await fileSystem.readBinary('/' + getFmtPath(fmtKey)).catch(() => null);
                                if (data) this._fmtMemCache = { key: fmtKey, data: new Uint8Array(data) };
                            }).catch(() => {}); // Silent fail for background task
                        }

                        resolve({
                            success: true,
                            pdf: pdfData,
                            pdfIsShared: result.pdfDataIsShared || false, // Pass flag to consumer
                            syncTexData: result.syncTexData || null, // SyncTeX data for source/PDF synchronization
                            stats: result.stats,
                            log: result.log,
                        });
                    } else {
                        resolve({
                            success: false,
                            error: result.error,
                            exitCode: result.exitCode,
                            log: result.log,
                        });
                    }
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            };

            this.worker.postMessage({
                type: 'compile',
                id: compileId,
                source,
                engine,
                options: {
                    enableLazyFS: this.enableLazyFS,
                    enableCtan: this.enableCtan,
                    maxRetries: this.maxRetries,
                    verbose: this.verbose,
                },
                bundleData,
                ctanFiles,
                cachedFormat,
                cachedAuxFiles: auxCache?.files || null,
                // Deferred bundles minus any that are eagerly loaded
                deferredBundleNames: (this.bundleManager.bundleDeps?.deferred || [])
                    .filter(b => !eagerBundles.includes(b)),
            }, transferList);
        });
    }

    /**
     * Pre-generate a format file for faster subsequent compilations.
     * @param {string} source - LaTeX source with preamble to cache
     * @param {{engine?: string}} [options] - Options
     * @returns {Promise<Uint8Array|null>} Format data or null if not supported
     */
    async generateFormat(source, options = {}) {
        const engine = options.engine || 'pdflatex';

        // XeTeX can't dump formats with native fonts (fontspec)
        if (engine === 'xelatex') {
            this._log('Format caching not supported for XeLaTeX (native fonts)');
            return null;
        }

        const preamble = extractPreamble(source);

        if (!preamble) {
            throw new Error('No preamble found in source');
        }

        // Check cache - path is deterministic from fmtKey
        const preambleHash = hashPreamble(preamble);
        const fmtKey = preambleHash + '_' + engine;
        const fmtPath = '/' + getFmtPath(fmtKey);
        await ensureFmtCacheMount();
        const existingFmt = await fileSystem.readBinary(fmtPath).catch(() => null);
        if (existingFmt && existingFmt.byteLength > 0) {
            this._log('Format already cached');
            return new Uint8Array(existingFmt);
        }

        // Ensure worker is ready
        if (!this.workerReady) {
            await this._initWorker();
        }

        // Determine required bundles (same logic as compile)
        const { bundles } = this.bundleManager.checkPackages(source, engine);

        // Get dependency bundles from prescan (e.g., utils for environ)
        let depBundles = [];
        if (this.enableCtan) {
            const { additionalBundles } = this.bundleManager.prescanForCtanPackages(source, engine, {});
            if (additionalBundles && additionalBundles.length > 0) {
                depBundles = additionalBundles;
            }
        }

        const allBundles = [...new Set([...bundles, ...depBundles])];
        const bundleData = await this.bundleManager.loadBundles(allBundles);

        // Get CTAN files from memory cache
        const ctanFiles = this.ctanFetcher.getCachedFiles();

        this._log('Generating format file...');
        this.onProgress('format', 'Generating format...');

        // Track this promise so compile() can wait for it
        this.formatGenerationPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingFormat) {
                    this.pendingFormat = null;
                    reject(new Error('Format generation timeout'));
                }
            }, 300000); // 5 minute timeout

            this.pendingFormat = {
                resolve: (result) => {
                    clearTimeout(timeout);

                    if (result.success) {
                        const fmtData = new Uint8Array(result.formatData);

                        // Cache to filesystem, then resolve
                        ensureFmtCacheMount().then(() => {
                            return fileSystem.writeBinary(fmtPath, fmtData, { createParents: true });
                        }).then(() => {
                            this._log('Format generated and cached');
                            resolve(fmtData);
                        }).catch(e => {
                            // Cache failed but format is still valid
                            this._log('Warning: Failed to cache format: ' + e.message);
                            resolve(fmtData);
                        });
                    } else {
                        reject(new Error(result.error || 'Format generation failed'));
                    }
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            };

            this.worker.postMessage({
                type: 'generate-format',
                id: crypto.randomUUID(),
                preambleContent: preamble,
                engine,
                manifest: this.bundleManager.fileManifest,
                packageMapData: this.bundleManager.packageMap,
                bundleDepsData: this.bundleManager.bundleDeps,
                bundleRegistryData: [...this.bundleManager.bundleRegistry],
                bundleData,
                ctanFiles,
                maxRetries: this.maxRetries,
            });
        }).finally(() => {
            this.formatGenerationPromise = null;
        });

        return this.formatGenerationPromise;
    }

    /**
     * Clear all caches (CTAN packages, mounted files).
     * @returns {Promise<void>}
     */
    async clearCache() {
        this._log('Clearing CTAN cache...');
        await clearCTANCache();
        this.ctanFetcher.clearMountedFiles();
        this._log('Cache cleared');
    }

    /**
     * Get compiler statistics.
     * @returns {{bundles: Object, ctan: Object}} Statistics from bundle manager and CTAN fetcher
     */
    getStats() {
        return {
            bundles: this.bundleManager.getStats(),
            ctan: this.ctanFetcher.getStats(),
        };
    }

    /**
     * Terminate the worker. Call unload() for full cleanup.
     */
    terminate() {
        if (this.worker) {
            this.worker.terminate();
            // Clear global reference if this is the active worker
            if (_globalActiveWorker === this.worker) {
                _globalActiveWorker = null;
            }
            this.worker = null;
            this.workerReady = false;
        }
    }

    /**
     * Unload compiler to free memory. Clears RAM caches but keeps disk caches.
     * Call init() again to reinitialize.
     */
    unload() {
        this._log('Unloading compiler to free memory...');

        // Terminate worker (frees WASM module, heap, worker bundle cache)
        this.terminate();

        // Clear main thread caches
        this.bundleManager.clearCache();
        this.ctanFetcher.clearMountedFiles();

        this._log('Compiler unloaded');
    }

    /**
     * Check if compiler is currently loaded.
     * @returns {boolean}
     */
    isLoaded() {
        return this.worker !== null;
    }
}

/**
 * Backwards-compatible alias for SiglumCompiler.
 * @type {typeof SiglumCompiler}
 */
export const BusyTeXCompiler = SiglumCompiler;
